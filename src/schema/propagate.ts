// src/schema/propagate.ts
//
// Schema change propagation: when schema claims change, affected nodes
// are re-rendered through the write pipeline (source='propagation').
// Defaults are populated for added claims; removed claims become orphans.

import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { mergeFieldClaims } from '../validation/merge.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { resolveDefaultValue } from '../validation/resolve-default.js';
import type { FileContext } from '../validation/resolve-default.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { executeMutation } from '../pipeline/execute.js';
import { PipelineError } from '../pipeline/types.js';
import { SchemaValidationError, groupValidationIssues, type PerNodeIssue, type ValidationGroup } from './errors.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';

export interface PropagationOptions {
  preview?: boolean;
  operation_id?: string;
}

export interface PropagationResult {
  nodes_affected: number;
  nodes_rerendered: number;
  defaults_populated: number;
  fields_orphaned: number;
  // Preview-mode augmentations (present iff opts.preview was true):
  validation_groups?: ValidationGroup[];
  orphaned_field_names?: Array<{ field: string; count: number }>;
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
  oldClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown; enum_values_override?: string[] | null }>,
  newClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown; enum_values_override?: string[] | null }>,
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
        JSON.stringify(o.default_value) !== JSON.stringify(n.default_value) ||
        JSON.stringify(o.enum_values_override) !== JSON.stringify(n.enum_values_override)
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

interface LoadedNodeState {
  file_path: string;
  title: string;
  body: string;
  types: string[];
  currentFields: Record<string, unknown>;
  rawFieldTexts: Record<string, string>;
}

/**
 * Load a node's mutable state from DB for re-rendering.
 * Returns null if the node no longer exists.
 */
function loadNodeState(db: Database.Database, nodeId: string): LoadedNodeState | null {
  const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as
    | { file_path: string; title: string; body: string }
    | undefined;
  if (!nodeRow) return null;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(nodeId) as Array<{ schema_type: string }>)
    .map(r => r.schema_type);

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

  const currentFields: Record<string, unknown> = {};
  const rawFieldTexts: Record<string, string> = {};
  for (const row of fieldRows) {
    currentFields[row.field_name] = reconstructValue(row);
    if (row.value_raw_text) rawFieldTexts[row.field_name] = row.value_raw_text;
  }

  return {
    file_path: nodeRow.file_path,
    title: nodeRow.title,
    body: nodeRow.body,
    types,
    currentFields,
    rawFieldTexts,
  };
}

/**
 * Build a FileContext for date-token resolution of adoption defaults.
 * Falls back to { mtimeMs: now, createdAtMs: null } if the file is missing.
 */
function buildFileContext(db: Database.Database, vaultPath: string, nodeId: string, filePath: string): FileContext {
  const absPath = safeVaultPath(vaultPath, filePath);
  let mtimeMs = Date.now();
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    // File missing — fall back to now; caller continues regardless
  }
  const row = db.prepare('SELECT created_at FROM nodes WHERE id = ?').get(nodeId) as { created_at: number | null } | undefined;
  return { mtimeMs, createdAtMs: row?.created_at ?? null };
}

/**
 * Shared per-node primitive: load node state, inject adoption defaults,
 * call executeMutation with source='propagation'.
 * Returns null if the node disappeared between query and processing.
 */
function rerenderNodeThroughPipeline(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  adoptionDefaults: Record<string, unknown>,
  syncLogger: SyncLogger | undefined,
  preLoaded?: LoadedNodeState,
  opts?: { dbOnly?: boolean; operation_id?: string },
): { node_id: string; file_path: string; file_written: boolean } | null {
  const state = preLoaded ?? loadNodeState(db, nodeId);
  if (!state) return null;

  // Merge adoption defaults into currentFields — never overwrite existing values.
  const mergedFields: Record<string, unknown> = { ...state.currentFields };
  for (const [field, value] of Object.entries(adoptionDefaults)) {
    if (!(field in mergedFields)) {
      mergedFields[field] = value;
    }
  }

  const undoCtx = opts?.operation_id ? { operation_id: opts.operation_id } : undefined;

  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'propagation',
    node_id: nodeId,
    file_path: state.file_path,
    title: state.title,
    types: state.types,
    fields: mergedFields,
    body: state.body,
    raw_field_texts: state.rawFieldTexts,
    db_only: opts?.dbOnly === true,
  }, syncLogger, undoCtx);

  return {
    node_id: result.node_id,
    file_path: result.file_path,
    file_written: result.file_written,
  };
}

/**
 * Propagate schema claim changes to all affected nodes.
 * Re-renders affected nodes through executeMutation and populates defaults
 * for added claims. Emits `field-defaulted` and `fields-orphaned` edits_log
 * rows post-mutation with source='propagation'.
 *
 * Per-node PipelineError with validation issues are collected across the full
 * loop. If any are collected, a SchemaValidationError is thrown at the end,
 * which rolls back the enclosing db.transaction. File writes from successfully
 * completed nodes are NOT rolled back (accepted until Phase B).
 */
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  syncLogger?: SyncLogger,
  opts: PropagationOptions = {},
): PropagationResult {
  const preview = opts.preview === true;
  const orphanCounts = new Map<string, number>();

  const result: PropagationResult = {
    nodes_affected: 0,
    nodes_rerendered: 0,
    defaults_populated: 0,
    fields_orphaned: 0,
  };

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    if (preview) {
      result.validation_groups = [];
      result.orphaned_field_names = [];
    }
    return result;
  }

  const nodeIds = (db.prepare('SELECT node_id FROM node_types WHERE schema_type = ?').all(schemaName) as Array<{ node_id: string }>)
    .map(r => r.node_id);

  if (nodeIds.length === 0) {
    if (preview) {
      result.validation_groups = [];
      result.orphaned_field_names = [];
    }
    return result;
  }
  result.nodes_affected = nodeIds.length;

  const trigger = `update-schema: ${schemaName}`;
  const mergeCache = new Map<string, ReturnType<typeof mergeFieldClaims>>();
  const insertLog = db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)');

  const perNodeIssues: PerNodeIssue[] = [];

  const runLoop = db.transaction(() => {
    for (const nodeId of nodeIds) {
      const state = loadNodeState(db, nodeId);
      if (!state) continue;

      // Cache merge results by sorted type-set key
      const typeKey = [...state.types].sort().join(',');
      let mergeResult = mergeCache.get(typeKey);
      if (!mergeResult) {
        const ctx = loadSchemaContext(db, state.types);
        mergeResult = mergeFieldClaims(state.types, ctx.claimsByType, ctx.globalFields);
        mergeCache.set(typeKey, mergeResult);
      }
      const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

      // Identify fields that need adoption defaults on this node.
      const adoptionFieldsToDefault: Array<{ field: string; value: unknown }> = [];
      let fileCtx: FileContext | null = null;
      for (const field of diff.added) {
        if (field in state.currentFields) continue; // re-adoption — value already present
        const ef = effectiveFields.get(field);
        if (!ef?.resolved_required) continue;
        if (ef.resolved_default_value === null || ef.resolved_default_value === undefined) continue;

        if (fileCtx === null) fileCtx = buildFileContext(db, vaultPath, nodeId, state.file_path);
        adoptionFieldsToDefault.push({
          field,
          value: resolveDefaultValue(ef.resolved_default_value, fileCtx),
        });
      }

      // Resolve default source ('global' vs 'claim') for each adoption default
      // from the already-computed mergeResult.effective_fields.
      const adoptionDefaults: Record<string, unknown> = {};
      const adoptionSources: Record<string, 'global' | 'claim'> = {};
      for (const { field, value } of adoptionFieldsToDefault) {
        adoptionDefaults[field] = value;
        adoptionSources[field] = effectiveFields.get(field)?.default_source ?? 'global';
      }

      // Pipeline call — collect validation failures instead of re-throwing
      let pipelineResult: { node_id: string; file_path: string; file_written: boolean } | null = null;
      try {
        pipelineResult = rerenderNodeThroughPipeline(
          db, writeLock, vaultPath, nodeId, adoptionDefaults, syncLogger, state,
          { dbOnly: preview, operation_id: opts.operation_id },
        );
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          for (const issue of err.validation.issues) {
            perNodeIssues.push({
              node_id: nodeId,
              title: state.title,
              field: issue.field,
              code: issue.code,
              value: state.currentFields[issue.field],
            });
          }
          continue;
        }
        throw err;
      }
      if (!pipelineResult) continue;

      // Post-mutation emission: field-defaulted (adoption)
      const now = Date.now();
      for (const [field, value] of Object.entries(adoptionDefaults)) {
        if (!preview) {
          insertLog.run(nodeId, now, 'field-defaulted', JSON.stringify({
            source: 'propagation',
            field,
            default_value: value,
            default_source: adoptionSources[field],
            trigger,
            node_types: state.types,
          }));
        }
        result.defaults_populated++;
      }

      // Post-mutation emission: fields-orphaned (one row per node, listing all)
      const orphanedInThisNode = diff.removed.filter(f => f in state.currentFields);
      if (orphanedInThisNode.length > 0) {
        if (!preview) {
          insertLog.run(nodeId, now, 'fields-orphaned', JSON.stringify({
            source: 'propagation',
            trigger,
            orphaned_fields: orphanedInThisNode,
            node_types: state.types,
          }));
        }
        result.fields_orphaned += orphanedInThisNode.length;
        if (preview) {
          for (const f of orphanedInThisNode) {
            orphanCounts.set(f, (orphanCounts.get(f) ?? 0) + 1);
          }
        }
      }

      if (pipelineResult.file_written) result.nodes_rerendered++;
    }

    if (perNodeIssues.length > 0) {
      const groups = groupValidationIssues(perNodeIssues);
      if (groups.length > 0) {
        if (preview) {
          result.validation_groups = groups;
        } else {
          throw new SchemaValidationError(groups);
        }
      }
    }
  });

  runLoop();

  if (preview) {
    result.validation_groups = result.validation_groups ?? [];
    result.orphaned_field_names = Array.from(orphanCounts.entries())
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
  }
  return result;
}

/**
 * Re-render all nodes that have a specific field.
 * Used after rename-global-field and update-global-field type changes.
 * No adoption/orphan events — schema claims don't change here.
 */
export function rerenderNodesWithField(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  fieldName: string,
  additionalNodeIds?: string[],
  syncLogger?: SyncLogger,
): number {
  const fromField = (db.prepare('SELECT DISTINCT node_id FROM node_fields WHERE field_name = ?').all(fieldName) as Array<{ node_id: string }>)
    .map(r => r.node_id);

  const nodeIdSet = new Set(fromField);
  if (additionalNodeIds) {
    for (const id of additionalNodeIds) nodeIdSet.add(id);
  }
  const nodeIds = Array.from(nodeIdSet);

  if (nodeIds.length === 0) return 0;

  let rerendered = 0;
  for (const nodeId of nodeIds) {
    const pipelineResult = rerenderNodeThroughPipeline(
      db, writeLock, vaultPath, nodeId, {}, syncLogger,
    );
    if (pipelineResult?.file_written) rerendered++;
  }

  return rerendered;
}
