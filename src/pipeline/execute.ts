// src/pipeline/execute.ts
//
// The write pipeline: single code path for all mutations.
// Section 5 of the Phase 3 spec.

import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { validateProposedState } from '../validation/validate.js';
import type { CoercedValue, ValidationResult, EffectiveFieldSet, ConflictedFieldSet } from '../validation/types.js';
import { renderNode } from '../renderer/render.js';
import type { RenderInput, FieldOrderEntry } from '../renderer/types.js';
import { sha256 } from '../indexer/hash.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { loadSchemaContext } from './schema-context.js';
import { hasBlockingErrors } from './errors.js';
import { classifyValue, reconstructValue } from './classify-value.js';
import { deriveRelationships } from './relationships.js';
import { buildDeviationEntries, writeEditsLogEntries } from './edits-log.js';
import { atomicWriteFile, readFileOrNull } from './file-writer.js';
import type { ProposedMutation, PipelineResult } from './types.js';
import { PipelineError } from './types.js';

/**
 * Execute a mutation through the full write pipeline.
 *
 * The pipeline is one function. The `source` field on ProposedMutation
 * controls Stage 3 behavior. Tool handlers call it and check for errors;
 * the watcher calls it and ignores validation results.
 *
 * Throws PipelineError on tool-path blocking errors.
 * Returns PipelineResult on success.
 */
export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
): PipelineResult {
  const absPath = join(vaultPath, mutation.file_path);
  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');

  // ── DB Transaction spans Stages 1–6 ──────────────────────────────
  const txn = db.transaction(() => {
    // ── Stage 1: Load schema context ────────────────────────────────
    const { claimsByType, globalFields } = loadSchemaContext(db, mutation.types);

    // ── Stage 2: Validate and coerce ────────────────────────────────
    const validation = validateProposedState(
      mutation.fields,
      mutation.types,
      claimsByType,
      globalFields,
    );

    // ── Stage 3: Source-specific error handling ──────────────────────
    let finalFields: Record<string, unknown>;
    let finalRawFieldTexts: Record<string, string> = {};
    const retainedValues: Record<string, { retained_value: unknown; rejected_value: unknown }> = {};
    const defaultedFields: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }> = [];

    if (mutation.source === 'tool') {
      // Tool path: check for blocking errors
      if (hasBlockingErrors(validation.issues)) {
        throw new PipelineError('VALIDATION_FAILED', 'Validation failed', validation);
      }

      // Build final fields from coerced_state
      finalFields = {};
      for (const [fieldName, cv] of Object.entries(validation.coerced_state)) {
        finalFields[fieldName] = cv.value;
      }

      // Track defaulted fields for edits log
      for (const [, cv] of Object.entries(validation.coerced_state)) {
        if (cv.source === 'defaulted') {
          // Determine source
          let source: 'global' | 'claim' = 'global';
          for (const claims of claimsByType.values()) {
            for (const c of claims) {
              if (c.field === cv.field && c.default_value !== null) {
                source = 'claim';
                break;
              }
            }
            if (source === 'claim') break;
          }
          defaultedFields.push({ field: cv.field, default_value: cv.value, default_source: source });
        }
      }
    } else {
      // Watcher path: absorb what we can
      finalFields = {};

      // Start with coerced values that passed
      for (const [fieldName, cv] of Object.entries(validation.coerced_state)) {
        finalFields[fieldName] = cv.value;
        // Carry forward raw_field_texts for accepted watcher values
        if (mutation.raw_field_texts && fieldName in mutation.raw_field_texts) {
          finalRawFieldTexts[fieldName] = mutation.raw_field_texts[fieldName];
        }
      }

      // For rejected fields, retain DB values
      for (const issue of validation.issues) {
        if (issue.severity === 'error' && issue.code !== 'MERGE_CONFLICT' && issue.field) {
          const fieldName = issue.field;
          if (fieldName in finalFields) continue; // already in coerced_state (e.g. from conflict recovery)

          // Look up retained value from DB
          const row = db.prepare(
            'SELECT value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
          ).get(mutation.node_id, fieldName) as {
            value_text: string | null;
            value_number: number | null;
            value_date: string | null;
            value_json: string | null;
            value_raw_text: string | null;
          } | undefined;

          if (row) {
            const retainedValue = reconstructValue(row);
            finalFields[fieldName] = retainedValue;
            if (row.value_raw_text) {
              finalRawFieldTexts[fieldName] = row.value_raw_text;
            }
            retainedValues[fieldName] = {
              retained_value: retainedValue,
              rejected_value: mutation.fields[fieldName],
            };
          } else {
            // New field that failed validation — omit entirely
            retainedValues[fieldName] = {
              retained_value: null,
              rejected_value: mutation.fields[fieldName],
            };
          }
        }
      }

      // Track defaulted fields
      for (const [, cv] of Object.entries(validation.coerced_state)) {
        if (cv.source === 'defaulted') {
          let source: 'global' | 'claim' = 'global';
          for (const claims of claimsByType.values()) {
            for (const c of claims) {
              if (c.field === cv.field && c.default_value !== null) {
                source = 'claim';
                break;
              }
            }
            if (source === 'claim') break;
          }
          defaultedFields.push({ field: cv.field, default_value: cv.value, default_source: source });
        }
      }
    }

    // ── Stage 4: Compute final state → RenderInput ──────────────────
    const effectiveFields = validation.effective_fields;
    const fieldOrdering = computeFieldOrdering(
      effectiveFields,
      validation.orphan_fields,
      finalFields,
    );

    const referenceFields = new Set<string>();
    const listReferenceFields = new Set<string>();
    for (const [name, gf] of globalFields) {
      if (gf.field_type === 'reference') referenceFields.add(name);
      if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
    }

    // Orphan raw values
    const orphanRawValues: Record<string, string> = {};
    for (const orphanField of validation.orphan_fields) {
      if (orphanField in finalRawFieldTexts) {
        orphanRawValues[orphanField] = finalRawFieldTexts[orphanField];
      } else if (mutation.raw_field_texts && orphanField in mutation.raw_field_texts) {
        orphanRawValues[orphanField] = mutation.raw_field_texts[orphanField];
      }
    }

    const renderInput: RenderInput = {
      title: mutation.title,
      types: mutation.types,
      fields: finalFields,
      body: mutation.body,
      fieldOrdering,
      referenceFields,
      listReferenceFields,
      orphanRawValues,
    };

    // ── Stage 5: Render ─────────────────────────────────────────────
    const fileContent = renderNode(renderInput);
    const renderedHash = sha256(fileContent);

    // No-op write rule: if hash matches BOTH the on-disk file AND the DB's content_hash, rollback.
    // For new nodes (node_id is null), always commit.
    // Both must match: on-disk match alone is insufficient because the DB may have stale state
    // (watcher path: file edited, DB not yet updated).
    const existingContent = readFileOrNull(absPath);
    const dbHash = mutation.node_id
      ? (db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(mutation.node_id) as { content_hash: string } | undefined)?.content_hash
      : undefined;
    if (mutation.node_id !== null && existingContent !== null && sha256(existingContent) === renderedHash && dbHash === renderedHash) {
      // Complete no-op: no file write, no DB changes, no edits log
      return {
        node_id: mutation.node_id ?? '',
        file_path: mutation.file_path,
        validation,
        rendered_hash: renderedHash,
        edits_logged: 0,
        file_written: false,
        _noop: true,
      } as PipelineResult & { _noop: boolean };
    }

    // ── Stage 6: Write (under write lock) ───────────────────────────
    return writeLock.withLockSync(absPath, () => {
      // Write file to disk
      atomicWriteFile(absPath, fileContent, tmpDir);

      // Generate node_id for new nodes
      const nodeId = mutation.node_id ?? nanoid();
      const now = Date.now();

      // Upsert nodes row
      db.prepare(`
        INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
        VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @indexed_at)
        ON CONFLICT(id) DO UPDATE SET
          file_path = @file_path,
          title = @title,
          body = @body,
          content_hash = @content_hash,
          file_mtime = @file_mtime,
          indexed_at = @indexed_at
      `).run({
        id: nodeId,
        file_path: mutation.file_path,
        title: mutation.title,
        body: mutation.body,
        content_hash: renderedHash,
        file_mtime: now,
        indexed_at: now,
      });

      // Delete and reinsert node_types
      db.prepare('DELETE FROM node_types WHERE node_id = ?').run(nodeId);
      const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
      for (const t of mutation.types) {
        insertType.run(nodeId, t);
      }

      // Delete and reinsert node_fields
      db.prepare('DELETE FROM node_fields WHERE node_id = ?').run(nodeId);
      const insertField = db.prepare(`
        INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
        VALUES (@node_id, @field_name, @value_text, @value_number, @value_date, @value_json, @value_raw_text, @source)
      `);
      for (const [fieldName, value] of Object.entries(finalFields)) {
        if (value === null || value === undefined) continue;
        const cols = classifyValue(value);
        const rawText = finalRawFieldTexts[fieldName]
          ?? (mutation.raw_field_texts?.[fieldName] ?? null);
        insertField.run({
          node_id: nodeId,
          field_name: fieldName,
          ...cols,
          value_raw_text: rawText,
          source: 'frontmatter',
        });
      }

      // Delete and reinsert relationships
      db.prepare('DELETE FROM relationships WHERE source_id = ?').run(nodeId);
      const insertRel = db.prepare(
        'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
      );
      const rels = deriveRelationships(finalFields, mutation.body, globalFields, orphanRawValues);
      for (const rel of rels) {
        insertRel.run(nodeId, rel.target, rel.rel_type, rel.context);
      }

      // Update FTS
      const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(nodeId) as { rowid: number } | undefined;
      if (rowInfo) {
        db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowInfo.rowid);
        db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (@rowid, @title, @body)').run({
          rowid: rowInfo.rowid,
          title: mutation.title,
          body: mutation.body,
        });
      }

      // Write edits log entries
      const logEntries = buildDeviationEntries(
        nodeId,
        mutation.source,
        validation.coerced_state,
        validation.issues,
        mutation.types,
        Object.keys(retainedValues).length > 0 ? retainedValues : undefined,
        defaultedFields.length > 0 ? defaultedFields : undefined,
      );
      const editsLogged = writeEditsLogEntries(db, logEntries);

      return {
        node_id: nodeId,
        file_path: mutation.file_path,
        validation,
        rendered_hash: renderedHash,
        edits_logged: editsLogged,
        file_written: true,
      };
    });
  });

  // Run the transaction
  const result = txn();

  // Handle no-op case (transaction was committed with no changes)
  if ((result as PipelineResult & { _noop?: boolean })._noop) {
    return {
      node_id: mutation.node_id ?? '',
      file_path: mutation.file_path,
      validation: (result as PipelineResult).validation,
      rendered_hash: (result as PipelineResult).rendered_hash,
      edits_logged: 0,
      file_written: false,
    };
  }

  return result;
}

/**
 * Compute field ordering from effective fields and orphan fields.
 */
function computeFieldOrdering(
  effectiveFields: EffectiveFieldSet,
  orphanFieldNames: string[],
  finalFields: Record<string, unknown>,
): FieldOrderEntry[] {
  const ordering: FieldOrderEntry[] = [];

  // Claimed fields: sorted by resolved_order, ties by Unicode codepoint field name
  const claimed = Array.from(effectiveFields.entries())
    .filter(([name]) => name in finalFields)
    .sort((a, b) => {
      const orderDiff = a[1].resolved_order - b[1].resolved_order;
      if (orderDiff !== 0) return orderDiff;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  for (const [name] of claimed) {
    ordering.push({ field: name, category: 'claimed' });
  }

  // Orphan fields: sorted in Unicode codepoint order
  const orphans = orphanFieldNames
    .filter(name => name in finalFields)
    .sort();

  for (const name of orphans) {
    ordering.push({ field: name, category: 'orphan' });
  }

  // Also add conflicted fields that have values (they're in finalFields but not in effectiveFields or orphans)
  for (const name of Object.keys(finalFields)) {
    if (ordering.some(e => e.field === name)) continue;
    // This is a conflicted field with a provided value — place after claimed, before orphans
    ordering.push({ field: name, category: 'claimed' });
  }

  return ordering;
}
