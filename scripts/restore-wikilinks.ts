#!/usr/bin/env tsx
//
// scripts/restore-wikilinks.ts
//
// One-time data correction: restores [[wikilinks]] stripped by the normalizer.
//
// The normalizer's first sweep lost wikilink brackets on orphan fields where
// value_raw_text was NULL. This script:
//   1. Backfills value_raw_text in the DB from global field types + relationships
//   2. Re-renders affected files through the project's render pipeline
//
// Usage:
//   npx tsx scripts/restore-wikilinks.ts --dry-run    # report only
//   npx tsx scripts/restore-wikilinks.ts              # apply fixes
//
// After running, restart the service so the next index picks up corrected hashes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadSchemaContext } from '../src/pipeline/schema-context.js';
import { mergeFieldClaims } from '../src/validation/merge.js';
import { reconstructValue } from '../src/pipeline/classify-value.js';
import { renderNode } from '../src/renderer/render.js';
import { sha256 } from '../src/indexer/hash.js';
import type { FieldOrderEntry } from '../src/renderer/types.js';

const VAULT_PATH = process.env.VAULT_PATH;
if (!VAULT_PATH) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}
const DB_PATH = join(VAULT_PATH, '.vault-engine/vault-new.db');
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) console.log('[dry-run] No files or DB rows will be modified.\n');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Step 1: Load reference-type global fields ─────────────────────────

const referenceFields = new Set<string>();
const listReferenceFields = new Set<string>();
const globalFieldRows = db.prepare('SELECT name, field_type, list_item_type FROM global_fields').all() as Array<{
  name: string;
  field_type: string;
  list_item_type: string | null;
}>;
for (const gf of globalFieldRows) {
  if (gf.field_type === 'reference') referenceFields.add(gf.name);
  if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(gf.name);
}

console.log(`Global reference fields: ${[...referenceFields].join(', ')}`);
console.log(`Global list<reference> fields: ${[...listReferenceFields].join(', ')}\n`);

// ── Step 2: Load relationship data for orphan field recovery ──────────

// Map of "nodeId:fieldName" → set of targets
const relsByNodeField = new Map<string, Set<string>>();
const relRows = db.prepare(
  "SELECT source_id, context, target FROM relationships WHERE rel_type != 'wiki-link'",
).all() as Array<{ source_id: string; context: string; target: string }>;
for (const r of relRows) {
  const key = `${r.source_id}:${r.context}`;
  if (!relsByNodeField.has(key)) relsByNodeField.set(key, new Set());
  relsByNodeField.get(key)!.add(r.target);
}

// ── Step 3: Load all node titles (for heuristic orphan matching) ──────

const nodeTitles = new Set<string>();
for (const row of db.prepare('SELECT title FROM nodes WHERE title IS NOT NULL').all()) {
  nodeTitles.add((row as { title: string }).title);
}

// ── Step 4: Process each node ─────────────────────────────────────────

const nodes = db.prepare(
  'SELECT id, file_path, title, body, content_hash FROM nodes ORDER BY file_path',
).all() as Array<{
  id: string;
  file_path: string;
  title: string;
  body: string;
  content_hash: string;
}>;

const updateRawText = db.prepare(
  'UPDATE node_fields SET value_raw_text = ? WHERE node_id = ? AND field_name = ?',
);

let filesFixed = 0;
let fieldsFixed = 0;
let heuristicMatches = 0;

const txn = db.transaction(() => {
  for (const node of nodes) {
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const fieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?',
    ).all(node.id) as Array<{
      field_name: string;
      value_text: string | null;
      value_number: number | null;
      value_date: string | null;
      value_json: string | null;
      value_raw_text: string | null;
    }>;

    let nodeChanged = false;

    // Build fields + raw texts, fixing as we go
    const fields: Record<string, unknown> = {};
    const rawTexts: Record<string, string> = {};

    for (const row of fieldRows) {
      const value = reconstructValue(row);
      fields[row.field_name] = value;
      if (row.value_raw_text) {
        rawTexts[row.field_name] = row.value_raw_text;
        continue; // already has raw text
      }

      // ── Fix: single reference field with bare string value ──
      if (referenceFields.has(row.field_name) && row.value_text !== null) {
        const raw = `[[${row.value_text}]]`;
        rawTexts[row.field_name] = raw;
        if (!DRY_RUN) updateRawText.run(raw, node.id, row.field_name);
        nodeChanged = true;
        fieldsFixed++;
        continue;
      }

      // ── Fix: list<reference> field with JSON array of bare strings ──
      if (listReferenceFields.has(row.field_name) && row.value_json !== null) {
        const arr = JSON.parse(row.value_json);
        if (Array.isArray(arr) && arr.some(v => typeof v === 'string' && !String(v).startsWith('[['))) {
          const wrapped = arr.map((v: unknown) =>
            typeof v === 'string' && !v.startsWith('[[') ? `[[${v}]]` : v,
          );
          const raw = JSON.stringify(wrapped);
          rawTexts[row.field_name] = raw;
          if (!DRY_RUN) updateRawText.run(raw, node.id, row.field_name);
          nodeChanged = true;
          fieldsFixed++;
          continue;
        }
      }

      // ── Fix: orphan field with relationship data ──
      const relKey = `${node.id}:${row.field_name}`;
      const targets = relsByNodeField.get(relKey);
      if (targets) {
        if (row.value_text !== null && targets.has(row.value_text)) {
          const raw = `[[${row.value_text}]]`;
          rawTexts[row.field_name] = raw;
          if (!DRY_RUN) updateRawText.run(raw, node.id, row.field_name);
          nodeChanged = true;
          fieldsFixed++;
          continue;
        }
        if (row.value_json !== null) {
          const arr = JSON.parse(row.value_json);
          if (Array.isArray(arr)) {
            const wrapped = arr.map((v: unknown) =>
              typeof v === 'string' && targets.has(v) ? `[[${v}]]` : v,
            );
            const raw = JSON.stringify(wrapped);
            rawTexts[row.field_name] = raw;
            if (!DRY_RUN) updateRawText.run(raw, node.id, row.field_name);
            nodeChanged = true;
            fieldsFixed++;
            continue;
          }
        }
      }

      // ── Heuristic: orphan string value matches a node title ──
      if (
        row.value_text !== null &&
        !referenceFields.has(row.field_name) &&
        !listReferenceFields.has(row.field_name) &&
        !targets &&
        nodeTitles.has(row.value_text)
      ) {
        const raw = `[[${row.value_text}]]`;
        rawTexts[row.field_name] = raw;
        if (!DRY_RUN) updateRawText.run(raw, node.id, row.field_name);
        nodeChanged = true;
        fieldsFixed++;
        heuristicMatches++;
      }
    }

    if (!nodeChanged) continue;

    // ── Re-render the file ────────────────────────────────────────────

    const ctx = loadSchemaContext(db, types);
    const mergeResult = mergeFieldClaims(types, ctx.claimsByType, ctx.globalFields);
    const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

    const fieldOrdering: FieldOrderEntry[] = [];
    const claimedNames = new Set(effectiveFields.keys());

    const claimed = Array.from(effectiveFields.entries())
      .filter(([name]) => name in fields)
      .sort((a, b) => {
        const orderDiff = a[1].resolved_order - b[1].resolved_order;
        if (orderDiff !== 0) return orderDiff;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
    for (const [name] of claimed) {
      fieldOrdering.push({ field: name, category: 'claimed' });
    }

    const orphans = Object.keys(fields)
      .filter(name => !claimedNames.has(name))
      .sort();
    for (const name of orphans) {
      fieldOrdering.push({ field: name, category: 'orphan' });
    }

    const refFields = new Set<string>();
    const listRefFields = new Set<string>();
    for (const [name, gf] of ctx.globalFields) {
      if (gf.field_type === 'reference') refFields.add(name);
      if (gf.field_type === 'list' && gf.list_item_type === 'reference') listRefFields.add(name);
    }

    const orphanRawValues: Record<string, string> = {};
    for (const [name, raw] of Object.entries(rawTexts)) {
      if (!claimedNames.has(name)) orphanRawValues[name] = raw;
    }

    const rendered = renderNode({
      title: node.title,
      types,
      fields,
      body: node.body,
      fieldOrdering,
      referenceFields: refFields,
      listReferenceFields: listRefFields,
      orphanRawValues,
    });

    const renderedHash = sha256(rendered);

    if (DRY_RUN) {
      console.log(`[dry-run] ${node.file_path} — would fix fields, hash ${node.content_hash.slice(0, 8)} → ${renderedHash.slice(0, 8)}`);
    } else {
      const absPath = join(VAULT_PATH, node.file_path);
      writeFileSync(absPath, rendered, 'utf-8');

      // Update content_hash so the normalizer sees this as canonical
      db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(renderedHash, node.id);

      console.log(`Fixed: ${node.file_path}`);
    }

    filesFixed++;
  }
});

txn();

db.close();

console.log(`\n=== Summary ===`);
console.log(`Files ${DRY_RUN ? 'to fix' : 'fixed'}: ${filesFixed}`);
console.log(`Fields ${DRY_RUN ? 'to fix' : 'fixed'}: ${fieldsFixed}`);
console.log(`  (${heuristicMatches} via heuristic node-title matching)`);
if (DRY_RUN) console.log(`\nRe-run without --dry-run to apply.`);
else console.log(`\nRestart the service to re-index with corrected hashes.`);
