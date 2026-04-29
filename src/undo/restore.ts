// src/undo/restore.ts
//
// Conflict detection + restore orchestration. See design spec:
// docs/superpowers/specs/2026-04-19-undo-system-design.md

import type Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { executeMutation } from '../pipeline/execute.js';
import { executeDeletion } from '../pipeline/delete.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import type { Conflict, ConflictReason, RestoreResult, UndoSnapshotRow } from './types.js';
import { getSnapshots, getOperation, markUndone } from './operation.js';
import { restoreSchemaSnapshot, type SchemaRestoreFileAction } from './schema-snapshot.js';
import { restoreGlobalFieldSnapshot, type GlobalFieldRestoreFileAction } from './global-field-snapshot.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { atomicWriteFile } from '../pipeline/file-writer.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { validateProposedState } from '../validation/validate.js';
import { renderNode } from '../renderer/render.js';
import type { FieldOrderEntry } from '../renderer/types.js';
import { renderFieldsFile, renderSchemaFile } from '../schema/render.js';

export interface RestoreOptions {
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
}

interface RestoreFileEffects {
  nodeWrites: Map<string, string>;
  nodeDeletes: string[];
  schemaActions: SchemaRestoreFileAction[];
  globalFieldActions: GlobalFieldRestoreFileAction[];
}

export function detectConflicts(
  db: Database.Database,
  vaultPath: string,
  operation_id: string,
  snapshots: UndoSnapshotRow[],
  operations_in_this_call: Set<string>,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const snap of snapshots) {
    // Skip was_deleted=1 if current node absent (nothing to reconcile)
    const currentNode = db.prepare('SELECT id, body, content_hash FROM nodes WHERE id = ?').get(snap.node_id) as { id: string; body: string | null; content_hash: string | null } | undefined;

    if (snap.was_deleted === 1) {
      // Undoing a create: we intend to delete the node. No conflict checks needed.
      continue;
    }

    // snap.was_deleted === 0 below.

    // Path occupancy: undo-delete path is occupied by a different node
    if (!currentNode) {
      const occupant = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(snap.file_path) as { id: string } | undefined;
      if (occupant && occupant.id !== snap.node_id) {
        conflicts.push(buildConflict(snap, 'path_occupied', { occupant_node_id: occupant.id }));
        continue;
      }
    } else {
      // Post-op drift
      if (snap.post_mutation_hash && currentNode.content_hash && currentNode.content_hash !== snap.post_mutation_hash) {
        conflicts.push(buildConflict(snap, 'modified_after_operation', {}));
      }
    }

    // Superseded by later op (NOT part of this undo call)
    const superseding = db.prepare(`
      SELECT o.operation_id, o.source_tool, o.timestamp
      FROM undo_snapshots s
      JOIN undo_operations o ON o.operation_id = s.operation_id
      WHERE s.node_id = ?
        AND o.status = 'active'
        AND o.timestamp > (SELECT timestamp FROM undo_operations WHERE operation_id = ?)
    `).all(snap.node_id, operation_id) as Array<{ operation_id: string; source_tool: string; timestamp: number }>;

    const outsideSet = superseding.filter(row => !operations_in_this_call.has(row.operation_id));
    if (outsideSet.length > 0) {
      const existing = conflicts.find(c => c.node_id === snap.node_id && c.reason === 'superseded_by_later_op');
      if (!existing) {
        conflicts.push(buildConflict(
          snap,
          'superseded_by_later_op',
          { modified_by: outsideSet.map(r => `${r.source_tool} at ${new Date(r.timestamp).toISOString()}`) },
        ));
      }
    }
  }
  return conflicts;
}

function buildConflict(
  snap: UndoSnapshotRow,
  reason: ConflictReason,
  extra: Record<string, unknown>,
): Conflict {
  const current_summary: Record<string, unknown> = {};
  const would_restore_summary: Record<string, unknown> = {};
  if (snap.title !== null) would_restore_summary.title = snap.title;
  // Summaries are intentionally thin — the caller can fetch full state via get-node.
  return {
    operation_id: snap.operation_id,
    node_id: snap.node_id,
    file_path: snap.file_path,
    reason,
    ...(extra.modified_by ? { modified_by: extra.modified_by as string[] } : {}),
    current_summary,
    would_restore_summary,
  };
}

export function restoreOperation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  operation_id: string,
  operations_in_this_call: Set<string>,
  opts: RestoreOptions = {},
): RestoreResult {
  const op = getOperation(db, operation_id);
  if (!op) {
    return {
      operations: [],
      conflicts: [],
      total_undone: 0,
      total_conflicts: 0,
      total_skipped: 0,
    };
  }

  const snapshots = getSnapshots(db, operation_id);
  const conflicts = detectConflicts(db, vaultPath, operation_id, snapshots, operations_in_this_call);
  const conflictedIds = new Set(conflicts.map(c => c.node_id));

  // Schema snapshots tied to this operation. Schema-level conflicts are not
  // detected; re-updates between the operation and the undo overwrite without
  // warning. Node-level snapshots still run through detectConflicts.
  const schemaSnaps = db.prepare(
    'SELECT schema_name FROM undo_schema_snapshots WHERE operation_id = ?',
  ).all(operation_id) as Array<{ schema_name: string }>;
  const globalFieldSnaps = tableExists(db, 'undo_global_field_snapshots')
    ? db.prepare(
      'SELECT field_name FROM undo_global_field_snapshots WHERE operation_id = ?',
    ).all(operation_id) as Array<{ field_name: string }>
    : [];

  // Partition resolve_conflicts
  const resolveMap = new Map<string, 'revert' | 'skip'>();
  for (const r of opts.resolve_conflicts ?? []) resolveMap.set(r.node_id, r.action);

  let undone = 0;
  let skipped = 0;
  const fileEffects: RestoreFileEffects = {
    nodeWrites: new Map(),
    nodeDeletes: [],
    schemaActions: [],
    globalFieldActions: [],
  };

  if (!opts.dry_run) {
    const txn = db.transaction(() => {
      // Schema-first pass: restore schema state before any node work so
      // node restores re-validate against the pre-change schema.
      for (const snap of schemaSnaps) {
        const action = restoreSchemaSnapshot(db, vaultPath, operation_id, snap.schema_name, { render: false });
        if (action) fileEffects.schemaActions.push(action);
      }

      // Global fields before node snapshots so later node restores validate
      // against restored global field definitions.
      for (const snap of globalFieldSnaps) {
        const action = restoreGlobalFieldSnapshot(db, operation_id, snap.field_name);
        if (action) fileEffects.globalFieldActions.push(action);
      }

      // Creates first, then updates, then deletes (within this op)
      const buckets = { create: [] as UndoSnapshotRow[], update: [] as UndoSnapshotRow[], delete: [] as UndoSnapshotRow[] };
      for (const s of snapshots) {
        const resolution = resolveMap.get(s.node_id);
        if (conflictedIds.has(s.node_id) && resolution !== 'revert') {
          if (resolution === 'skip') skipped++;
          continue;
        }
        const currentNode = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(s.node_id);
        if (s.was_deleted === 1) buckets.delete.push(s);
        else if (!currentNode) buckets.create.push(s);
        else buckets.update.push(s);
      }

      for (const s of buckets.create) {
        const written = restoreCreate(db, writeLock, vaultPath, s);
        if (written) fileEffects.nodeWrites.set(written.node_id, written.file_path);
        undone++;
      }
      for (const s of buckets.update) {
        const written = restoreUpdate(db, writeLock, vaultPath, s);
        if (written) fileEffects.nodeWrites.set(written.node_id, written.file_path);
        undone++;
      }
      for (const s of buckets.delete) {
        restoreDelete(db, writeLock, vaultPath, s);
        fileEffects.nodeDeletes.push(s.file_path);
        undone++;
      }

      markUndone(db, operation_id);
    });
    txn();
    applyRestoreFileEffects(db, writeLock, vaultPath, fileEffects);
  }

  return {
    operations: [{
      operation_id,
      node_count: op.node_count,
      schema_count: op.schema_count ?? 0,
      global_field_count: op.global_field_count ?? 0,
      status: opts.dry_run ? 'would_undo' : 'undone',
    }],
    conflicts,
    total_undone: undone,
    total_conflicts: conflicts.length,
    total_skipped: skipped,
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}

/** Restore a deleted node by re-creating it with its original id. */
function restoreCreate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): { node_id: string; file_path: string } | null {
  if (snap.types === null) return null;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields: Record<string, unknown> = {};
  for (const r of fieldsRows) fields[r.field_name] = reconstructValue(r);

  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    body: snap.body ?? '',
    db_only: true,
  });
  return { node_id: result.node_id, file_path: result.file_path };
}

/** Restore an updated node to its pre-state. */
function restoreUpdate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): { node_id: string; file_path: string } | null {
  if (snap.types === null) return null;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields: Record<string, unknown> = {};
  for (const r of fieldsRows) fields[r.field_name] = reconstructValue(r);

  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    body: snap.body ?? '',
    db_only: true,
  });
  return { node_id: result.node_id, file_path: result.file_path };
}

/** Undo a create by deleting the node that was created. */
function restoreDelete(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): void {
  executeDeletion(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    unlink_file: false,
  });
}

function applyRestoreFileEffects(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  effects: RestoreFileEffects,
): void {
  for (const action of effects.schemaActions) {
    if (action.type === 'render') {
      renderRestoredSchemaFile(db, vaultPath, action.schema_name);
    } else {
      deleteRestoredSchemaFile(vaultPath, action.schema_name);
    }
  }

  applyGlobalFieldFileActions(db, writeLock, vaultPath, effects.globalFieldActions);

  for (const filePath of effects.nodeDeletes) {
    unlinkRestoredNodeFile(writeLock, vaultPath, filePath);
  }

  for (const [nodeId] of effects.nodeWrites) {
    renderRestoredNodeFile(db, writeLock, vaultPath, nodeId);
  }
}

function applyGlobalFieldFileActions(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  actions: GlobalFieldRestoreFileAction[],
): void {
  if (actions.length === 0) return;

  if (actions.some(action => action.renderFieldsCatalog)) {
    renderFieldsFile(db, vaultPath);
  }

  const schemaNames = new Set<string>();
  const nodeIds = new Set<string>();
  for (const action of actions) {
    for (const schemaName of action.schemaNames) schemaNames.add(schemaName);
    for (const nodeId of action.nodeIds) nodeIds.add(nodeId);
  }

  for (const schemaName of [...schemaNames].sort()) {
    renderRestoredSchemaFile(db, vaultPath, schemaName);
  }
  for (const nodeId of [...nodeIds].sort()) {
    renderRestoredNodeFile(db, writeLock, vaultPath, nodeId);
  }
}

function renderRestoredSchemaFile(db: Database.Database, vaultPath: string, schemaName: string): void {
  renderSchemaFile(db, vaultPath, schemaName);
}

function deleteRestoredSchemaFile(vaultPath: string, schemaName: string): void {
  try {
    const absPath = safeVaultPath(vaultPath, join('.schemas', `${schemaName}.yaml`));
    if (existsSync(absPath)) unlinkSync(absPath);
  } catch {
    // Preserve the historical best-effort behavior for schema YAML deletion.
  }
}

function unlinkRestoredNodeFile(writeLock: WriteLockManager, vaultPath: string, filePath: string): void {
  const absPath = safeVaultPath(vaultPath, filePath);
  writeLock.withLockSync(absPath, () => {
    try {
      unlinkSync(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  });
}

function renderRestoredNodeFile(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
): void {
  const node = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as
    | { file_path: string; title: string | null; body: string | null }
    | undefined;
  if (!node) return;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order')
    .all(nodeId) as Array<{ schema_type: string }>).map(r => r.schema_type);
  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?'
  ).all(nodeId) as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;

  const fields: Record<string, unknown> = {};
  const rawFieldTexts: Record<string, string> = {};
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
    if (row.value_raw_text !== null) rawFieldTexts[row.field_name] = row.value_raw_text;
  }

  const { claimsByType, globalFields } = loadSchemaContext(db, types);
  const validation = validateProposedState(fields, types, claimsByType, globalFields, { skipDefaults: true });
  const finalFields: Record<string, unknown> = {};
  for (const [fieldName, cv] of Object.entries(validation.coerced_state)) {
    finalFields[fieldName] = cv.value;
  }

  const referenceFields = new Set<string>();
  const listReferenceFields = new Set<string>();
  for (const [name, gf] of globalFields) {
    if (gf.field_type === 'reference') referenceFields.add(name);
    if (gf.field_type === 'list' && gf.list_item_type === 'reference') listReferenceFields.add(name);
  }

  const orphanRawValues: Record<string, string> = {};
  for (const fieldName of validation.orphan_fields) {
    if (fieldName in rawFieldTexts) orphanRawValues[fieldName] = rawFieldTexts[fieldName];
  }

  const content = renderNode({
    types,
    fields: finalFields,
    body: node.body ?? '',
    fieldOrdering: computeFieldOrdering(validation.effective_fields, validation.orphan_fields, finalFields),
    referenceFields,
    listReferenceFields,
    orphanRawValues,
  });

  const absPath = safeVaultPath(vaultPath, node.file_path);
  const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
  writeLock.withLockSync(absPath, () => {
    atomicWriteFile(absPath, content, tmpDir);
  });
}

function computeFieldOrdering(
  effectiveFields: ReturnType<typeof validateProposedState>['effective_fields'],
  orphanFieldNames: string[],
  finalFields: Record<string, unknown>,
): FieldOrderEntry[] {
  const ordering: FieldOrderEntry[] = [];

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

  const orphans = orphanFieldNames
    .filter(name => name in finalFields)
    .sort();

  for (const name of orphans) {
    ordering.push({ field: name, category: 'orphan' });
  }

  for (const name of Object.keys(finalFields)) {
    if (ordering.some(e => e.field === name)) continue;
    ordering.push({ field: name, category: 'claimed' });
  }

  return ordering;
}

export interface RestoreManyParams {
  operation_ids?: string[];
  since?: string;
  until?: string;
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
}

export function restoreMany(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  params: RestoreManyParams,
): RestoreResult {
  // Resolve target operation_ids
  let ids: string[];
  if (params.operation_ids && params.operation_ids.length > 0) {
    ids = params.operation_ids;
  } else {
    const clauses: string[] = ["status = 'active'"];
    const values: (string | number)[] = [];
    if (params.since) { clauses.push('timestamp >= ?'); values.push(new Date(params.since).getTime()); }
    if (params.until) { clauses.push('timestamp <= ?'); values.push(new Date(params.until).getTime()); }
    const rows = db.prepare(
      `SELECT operation_id FROM undo_operations WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC`
    ).all(...values) as Array<{ operation_id: string }>;
    ids = rows.map(r => r.operation_id);
  }

  // Sort reverse chrono
  const idRows = db.prepare(
    `SELECT operation_id, timestamp FROM undo_operations WHERE operation_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as Array<{ operation_id: string; timestamp: number }>;
  idRows.sort((a, b) => b.timestamp - a.timestamp);

  const inCall = new Set(idRows.map(r => r.operation_id));
  const aggregate: RestoreResult = {
    operations: [],
    conflicts: [],
    total_undone: 0,
    total_conflicts: 0,
    total_skipped: 0,
  };

  for (const row of idRows) {
    const result = restoreOperation(db, writeLock, vaultPath, row.operation_id, inCall, {
      dry_run: params.dry_run,
      resolve_conflicts: params.resolve_conflicts,
    });
    aggregate.operations.push(...result.operations);
    aggregate.conflicts.push(...result.conflicts);
    aggregate.total_undone += result.total_undone;
    aggregate.total_conflicts += result.total_conflicts;
    aggregate.total_skipped += result.total_skipped;
  }

  return aggregate;
}
