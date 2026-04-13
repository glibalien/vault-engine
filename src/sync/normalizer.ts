// src/sync/normalizer.ts
//
// Periodic field normalizer: re-renders stale vault markdown from DB state
// on a cron schedule. Fixes frontmatter drift from direct Obsidian edits.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import type Database from 'better-sqlite3';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { mergeFieldClaims } from '../validation/merge.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { renderNode } from '../renderer/render.js';
import type { FieldOrderEntry } from '../renderer/types.js';
import { sha256 } from '../indexer/hash.js';
import { executeMutation } from '../pipeline/execute.js';
import type { WriteLockManager } from './write-lock.js';
import type { SyncLogger } from './sync-logger.js';

export interface NormalizerOptions {
  cronExpression: string;
  quiescenceMinutes?: number;
}

interface SweepStats {
  scanned: number;
  skipped_quiescent: number;
  skipped_canonical: number;
  skipped_missing: number;
  rewritten: number;
  errored: number;
}

export function startNormalizer(
  vaultPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  options?: NormalizerOptions,
): { stop: () => void } {
  if (!options?.cronExpression) {
    return { stop: () => {} };
  }

  const quiescenceMs = (options.quiescenceMinutes ?? 60) * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const cron = new Cron(options.cronExpression);

  function scheduleNext(): void {
    if (stopped) return;
    const next = cron.nextRun();
    if (!next) return;

    const delayMs = next.getTime() - Date.now();
    if (delayMs < 0) return;

    timer = setTimeout(() => {
      if (stopped) return;
      sweep();
      scheduleNext();
    }, delayMs);

    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  function sweep(): void {
    const stats: SweepStats = {
      scanned: 0,
      skipped_quiescent: 0,
      skipped_canonical: 0,
      skipped_missing: 0,
      rewritten: 0,
      errored: 0,
    };

    const nodes = db.prepare(
      'SELECT id, file_path, content_hash FROM nodes ORDER BY file_path',
    ).all() as Array<{
      id: string;
      file_path: string;
      content_hash: string;
    }>;

    const now = Date.now();
    console.log(`[normalizer] Started — ${nodes.length} nodes to check`);

    for (const node of nodes) {
      stats.scanned++;

      try {
        // 1. Stat the file — skip if missing or quiescent
        const absPath = join(vaultPath, node.file_path);
        let mtime: number;
        try {
          const st = statSync(absPath);
          mtime = st.mtimeMs;
        } catch {
          stats.skipped_missing++;
          continue;
        }

        if (now - mtime < quiescenceMs) {
          stats.skipped_quiescent++;
          continue;
        }

        // 2. Render from DB state
        const renderedHash = renderFromDb(db, node.id);
        if (renderedHash === null) {
          stats.errored++;
          continue;
        }

        // 3. Staleness check
        if (renderedHash === node.content_hash) {
          stats.skipped_canonical++;
          continue;
        }

        // 4. Write through pipeline
        const nodeRow = db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(node.id) as {
          title: string;
          body: string;
        };

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

        const fields: Record<string, unknown> = {};
        const rawFieldTexts: Record<string, string> = {};
        for (const row of fieldRows) {
          fields[row.field_name] = reconstructValue(row);
          if (row.value_raw_text) rawFieldTexts[row.field_name] = row.value_raw_text;
        }

        executeMutation(db, writeLock, vaultPath, {
          source: 'normalizer',
          node_id: node.id,
          file_path: node.file_path,
          title: nodeRow.title,
          types,
          fields,
          body: nodeRow.body,
          raw_field_texts: rawFieldTexts,
        }, syncLogger);

        // Suppress the watcher's debounced fs event for this file
        writeLock.markRecentWrite(absPath);

        console.log(`[normalizer] Normalized: ${node.file_path}`);
        stats.rewritten++;
      } catch (err) {
        console.error(
          `[normalizer] Error normalizing ${node.file_path}:`,
          err instanceof Error ? err.message : err,
        );
        stats.errored++;
      }
    }

    console.log(
      `[normalizer] Complete: ${stats.scanned} scanned, ${stats.rewritten} rewritten, ` +
      `${stats.skipped_canonical} already canonical, ${stats.skipped_quiescent} quiescent, ` +
      `${stats.skipped_missing} missing, ${stats.errored} errors`,
    );

    // Log summary to edits_log
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ).run(null, Date.now(), 'normalizer-sweep', JSON.stringify(stats));
  }

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Render a node from DB state and return the SHA256 hash of the rendered content.
 * Returns null if the node cannot be rendered (e.g. missing from DB).
 */
function renderFromDb(db: Database.Database, nodeId: string): string | null {
  const nodeRow = db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(nodeId) as {
    title: string;
    body: string;
  } | undefined;
  if (!nodeRow) return null;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
    value_raw_text: string | null;
  }>;

  const fields: Record<string, unknown> = {};
  const rawTexts: Record<string, string> = {};
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
    if (row.value_raw_text) rawTexts[row.field_name] = row.value_raw_text;
  }

  const ctx = loadSchemaContext(db, types);
  const mergeResult = mergeFieldClaims(types, ctx.claimsByType, ctx.globalFields);
  const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

  const fieldOrdering: FieldOrderEntry[] = [];
  const claimedNames = new Set(effectiveFields.keys());

  // Claimed fields sorted by resolved_order
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

  // Orphan fields sorted by Unicode codepoint
  const orphans = Object.keys(fields)
    .filter(name => !claimedNames.has(name))
    .sort();
  for (const name of orphans) {
    fieldOrdering.push({ field: name, category: 'orphan' });
  }

  const referenceFields = new Set<string>();
  const listReferenceFields = new Set<string>();
  for (const [name, gf] of ctx.globalFields) {
    if (gf.field_type === 'reference') referenceFields.add(name);
    if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
  }

  const orphanRawValues: Record<string, string> = {};
  for (const [name, raw] of Object.entries(rawTexts)) {
    if (!claimedNames.has(name)) orphanRawValues[name] = raw;
  }

  const rendered = renderNode({
    title: nodeRow.title,
    types,
    fields,
    body: nodeRow.body,
    fieldOrdering,
    referenceFields,
    listReferenceFields,
    orphanRawValues,
  });

  return sha256(rendered);
}
