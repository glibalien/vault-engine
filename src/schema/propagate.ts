// src/schema/propagate.ts
//
// Schema change propagation: when schema claims change, affected nodes
// are re-rendered (and defaults populated for added claims).

import type Database from 'better-sqlite3';
import { mergeFieldClaims } from '../validation/merge.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { reconstructValue, classifyValue } from '../pipeline/classify-value.js';
import { renderNode } from '../renderer/render.js';
import type { RenderInput, FieldOrderEntry } from '../renderer/types.js';
import { sha256 } from '../indexer/hash.js';
import { atomicWriteFile, backupFile, restoreFile, cleanupBackups, readFileOrNull } from '../pipeline/file-writer.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { WriteGate } from '../sync/write-gate.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import { join } from 'node:path';
import type { EffectiveFieldSet, GlobalFieldDefinition } from '../validation/types.js';

export interface PropagationResult {
  nodes_affected: number;
  nodes_rerendered: number;
  defaults_populated: number;
  fields_orphaned: number;
}

interface ClaimDiff {
  added: string[];    // field names added to claims
  removed: string[];  // field names removed from claims
  changed: string[];  // field names with changed metadata
}

/**
 * Diff old claims against new claims to determine what changed.
 */
export function diffClaims(
  oldClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown }>,
  newClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown }>,
): ClaimDiff {
  const oldSet = new Map(oldClaims.map(c => [c.field, c]));
  const newSet = new Map(newClaims.map(c => [c.field, c]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [field] of newSet) {
    if (!oldSet.has(field)) added.push(field);
    else {
      const o = oldSet.get(field)!;
      const n = newSet.get(field)!;
      if (
        o.sort_order !== n.sort_order ||
        o.label !== n.label ||
        o.description !== n.description ||
        o.required !== n.required ||
        JSON.stringify(o.default_value) !== JSON.stringify(n.default_value)
      ) {
        changed.push(field);
      }
    }
  }

  for (const [field] of oldSet) {
    if (!newSet.has(field)) removed.push(field);
  }

  return { added, removed, changed };
}

/**
 * Propagate schema claim changes to all affected nodes.
 * Re-renders affected nodes and populates defaults for added claims.
 */
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): PropagationResult {
  const result: PropagationResult = {
    nodes_affected: 0,
    nodes_rerendered: 0,
    defaults_populated: 0,
    fields_orphaned: 0,
  };

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return result;
  }

  // Find all nodes of this schema type
  const nodeIds = (db.prepare('SELECT node_id FROM node_types WHERE schema_type = ?')
    .all(schemaName) as Array<{ node_id: string }>).map(r => r.node_id);

  if (nodeIds.length === 0) return result;
  result.nodes_affected = nodeIds.length;

  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
  const backups: Array<{ filePath: string; backupPath: string }> = [];

  // Cache merge results by type set
  const mergeCache = new Map<string, ReturnType<typeof mergeFieldClaims>>();

  try {
    for (const nodeId of nodeIds) {
      const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as {
        file_path: string; title: string; body: string;
      };

      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

      // Load current fields
      const fieldRows = db.prepare(
        'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?'
      ).all(nodeId) as Array<{
        field_name: string; value_text: string | null; value_number: number | null;
        value_date: string | null; value_json: string | null; value_raw_text: string | null;
      }>;

      const currentFields: Record<string, unknown> = {};
      const rawTexts: Record<string, string> = {};
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
        if (row.value_raw_text) rawTexts[row.field_name] = row.value_raw_text;
      }

      // Run merge algorithm (cached by type set)
      const typeKey = [...types].sort().join(',');
      let mergeResult = mergeCache.get(typeKey);
      if (!mergeResult) {
        const ctx = loadSchemaContext(db, types);
        mergeResult = mergeFieldClaims(types, ctx.claimsByType, ctx.globalFields);
        mergeCache.set(typeKey, mergeResult);
      }

      const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

      // Populate defaults for added claims
      for (const addedField of diff.added) {
        if (addedField in currentFields) continue; // re-adoption, value already exists
        const ef = effectiveFields.get(addedField);
        if (ef?.resolved_default_value !== null && ef?.resolved_default_value !== undefined) {
          currentFields[addedField] = ef.resolved_default_value;
          result.defaults_populated++;

          // Write field-defaulted log entry
          let source: 'global' | 'claim' = 'global';
          const ctx = loadSchemaContext(db, types);
          for (const claims of ctx.claimsByType.values()) {
            for (const c of claims) {
              if (c.field === addedField && c.default_value !== null) { source = 'claim'; break; }
            }
            if (source === 'claim') break;
          }
          db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
            nodeId, Date.now(), 'field-defaulted',
            JSON.stringify({ source: 'tool', field: addedField, default_value: ef.resolved_default_value, default_source: source, node_types: types }),
          );
        }
      }

      // Log fields-orphaned for removed claims
      if (diff.removed.length > 0) {
        const orphanedInThisNode = diff.removed.filter(f => f in currentFields);
        if (orphanedInThisNode.length > 0) {
          result.fields_orphaned += orphanedInThisNode.length;
          db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
            nodeId, Date.now(), 'fields-orphaned',
            JSON.stringify({ source: 'tool', trigger: `update-schema: ${schemaName}`, orphaned_fields: orphanedInThisNode, node_types: types }),
          );
        }
      }

      // Build RenderInput and re-render
      const ctx = loadSchemaContext(db, types);
      const globalFields = ctx.globalFields;

      const fieldOrdering = computePropagationFieldOrdering(effectiveFields, currentFields, globalFields);
      const referenceFields = new Set<string>();
      const listReferenceFields = new Set<string>();
      for (const [name, gf] of globalFields) {
        if (gf.field_type === 'reference') referenceFields.add(name);
        if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
      }

      const claimedFieldNames = new Set(Array.from(effectiveFields.keys()));
      const orphanRawValues: Record<string, string> = {};
      for (const [name, raw] of Object.entries(rawTexts)) {
        if (!claimedFieldNames.has(name)) orphanRawValues[name] = raw;
      }

      const renderInput: RenderInput = {
        title: nodeRow.title,
        types,
        fields: currentFields,
        body: nodeRow.body,
        fieldOrdering,
        referenceFields,
        listReferenceFields,
        orphanRawValues,
      };

      const fileContent = renderNode(renderInput);
      const renderedHash = sha256(fileContent);
      const absPath = join(vaultPath, nodeRow.file_path);

      // Check if re-render is needed
      const existingContent = readFileOrNull(absPath);
      if (existingContent !== null && sha256(existingContent) === renderedHash) {
        continue; // No change needed
      }

      // Backup and write
      const backup = backupFile(absPath, tmpDir);
      if (backup) backups.push({ filePath: absPath, backupPath: backup });

      if (writeGate) {
        writeGate.cancel(nodeRow.file_path);
        syncLogger?.deferredWriteCancelled(nodeRow.file_path, 'propagation');
      }

      writeLock.withLockSync(absPath, () => {
        atomicWriteFile(absPath, fileContent, tmpDir);
        syncLogger?.fileWritten(nodeRow.file_path, 'propagation', renderedHash);

        // Update DB: node_fields for newly defaulted fields and content_hash
        for (const addedField of diff.added) {
          if (addedField in currentFields && currentFields[addedField] !== null) {
            const val = currentFields[addedField];
            const cols = classifyValue(val);
            db.prepare(`
              INSERT OR REPLACE INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'frontmatter')
            `).run(nodeId, addedField, cols.value_text, cols.value_number, cols.value_date, cols.value_json, null);
          }
        }

        db.prepare('UPDATE nodes SET content_hash = ?, indexed_at = ? WHERE id = ?').run(renderedHash, Date.now(), nodeId);
      });

      result.nodes_rerendered++;
    }

    // Success: clean up backups
    cleanupBackups(backups.map(b => b.backupPath));
  } catch (err) {
    // Rollback: restore all backed-up files
    for (const { filePath, backupPath } of backups) {
      try {
        restoreFile(backupPath, filePath);
      } catch {
        // Best effort
      }
    }
    throw err;
  }

  return result;
}

function computePropagationFieldOrdering(
  effectiveFields: EffectiveFieldSet,
  fields: Record<string, unknown>,
  globalFields: Map<string, GlobalFieldDefinition>,
): FieldOrderEntry[] {
  const ordering: FieldOrderEntry[] = [];
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
    ordering.push({ field: name, category: 'claimed' });
  }

  // Orphan fields sorted by Unicode codepoint
  const orphans = Object.keys(fields)
    .filter(name => !claimedNames.has(name))
    .sort();
  for (const name of orphans) {
    ordering.push({ field: name, category: 'orphan' });
  }

  return ordering;
}

/**
 * Re-render all nodes that have a specific field.
 * Used after rename-global-field and update-global-field type changes.
 */
export function rerenderNodesWithField(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  fieldName: string,
  additionalNodeIds?: string[],
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): number {
  const fromField = (db.prepare('SELECT DISTINCT node_id FROM node_fields WHERE field_name = ?')
    .all(fieldName) as Array<{ node_id: string }>).map(r => r.node_id);

  // Merge with additional IDs (e.g. nodes whose field was deleted during type change)
  const nodeIdSet = new Set(fromField);
  if (additionalNodeIds) {
    for (const id of additionalNodeIds) nodeIdSet.add(id);
  }
  const nodeIds = Array.from(nodeIdSet);

  if (nodeIds.length === 0) return 0;

  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
  let rerendered = 0;

  for (const nodeId of nodeIds) {
    const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as {
      file_path: string; title: string; body: string;
    } | undefined;
    if (!nodeRow) continue;

    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const fieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?'
    ).all(nodeId) as Array<{
      field_name: string; value_text: string | null; value_number: number | null;
      value_date: string | null; value_json: string | null; value_raw_text: string | null;
    }>;

    const currentFields: Record<string, unknown> = {};
    const rawTexts: Record<string, string> = {};
    for (const row of fieldRows) {
      currentFields[row.field_name] = reconstructValue(row);
      if (row.value_raw_text) rawTexts[row.field_name] = row.value_raw_text;
    }

    const ctx = loadSchemaContext(db, types);
    const mergeResult = mergeFieldClaims(types, ctx.claimsByType, ctx.globalFields);
    const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

    const fieldOrdering = computePropagationFieldOrdering(effectiveFields, currentFields, ctx.globalFields);
    const referenceFields = new Set<string>();
    const listReferenceFields = new Set<string>();
    for (const [name, gf] of ctx.globalFields) {
      if (gf.field_type === 'reference') referenceFields.add(name);
      if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
    }

    const claimedNames = new Set(effectiveFields.keys());
    const orphanRawValues: Record<string, string> = {};
    for (const [name, raw] of Object.entries(rawTexts)) {
      if (!claimedNames.has(name)) orphanRawValues[name] = raw;
    }

    const renderInput: RenderInput = {
      title: nodeRow.title,
      types,
      fields: currentFields,
      body: nodeRow.body,
      fieldOrdering,
      referenceFields,
      listReferenceFields,
      orphanRawValues,
    };

    const fileContent = renderNode(renderInput);
    const renderedHash = sha256(fileContent);
    const absPath = join(vaultPath, nodeRow.file_path);

    const existingContent = readFileOrNull(absPath);
    if (existingContent !== null && sha256(existingContent) === renderedHash) continue;

    if (writeGate) {
      writeGate.cancel(nodeRow.file_path);
      syncLogger?.deferredWriteCancelled(nodeRow.file_path, 'propagation');
    }

    writeLock.withLockSync(absPath, () => {
      atomicWriteFile(absPath, fileContent, tmpDir);
      syncLogger?.fileWritten(nodeRow.file_path, 'propagation', renderedHash);
      db.prepare('UPDATE nodes SET content_hash = ?, indexed_at = ? WHERE id = ?').run(renderedHash, Date.now(), nodeId);
    });

    rerendered++;
  }

  return rerendered;
}
