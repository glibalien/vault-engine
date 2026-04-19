// src/undo/restore.ts
//
// Conflict detection + restore orchestration. See design spec:
// docs/superpowers/specs/2026-04-19-undo-system-design.md

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { executeMutation } from '../pipeline/execute.js';
import { executeDeletion } from '../pipeline/delete.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import type { Conflict, ConflictReason, RestoreResult, UndoSnapshotRow } from './types.js';
import { getSnapshots, getOperation, markUndone } from './operation.js';

export interface RestoreOptions {
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
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

  // Partition resolve_conflicts
  const resolveMap = new Map<string, 'revert' | 'skip'>();
  for (const r of opts.resolve_conflicts ?? []) resolveMap.set(r.node_id, r.action);

  let undone = 0;
  let skipped = 0;

  if (!opts.dry_run) {
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

    for (const s of buckets.create) { restoreCreate(db, writeLock, vaultPath, s); undone++; }
    for (const s of buckets.update) { restoreUpdate(db, writeLock, vaultPath, s); undone++; }
    for (const s of buckets.delete) { restoreDelete(db, writeLock, vaultPath, s); undone++; }

    markUndone(db, operation_id);
  }

  return {
    operations: [{
      operation_id,
      node_count: op.node_count,
      status: opts.dry_run ? 'would_undo' : 'undone',
    }],
    conflicts,
    total_undone: undone,
    total_conflicts: conflicts.length,
    total_skipped: skipped,
  };
}

/** Restore a deleted node by re-creating it with its original id. */
function restoreCreate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): void {
  if (snap.types === null) return;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields: Record<string, unknown> = {};
  for (const r of fieldsRows) fields[r.field_name] = reconstructValue(r);

  executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    body: snap.body ?? '',
  });
}

/** Restore an updated node to its pre-state. */
function restoreUpdate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): void {
  if (snap.types === null) return;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields: Record<string, unknown> = {};
  for (const r of fieldsRows) fields[r.field_name] = reconstructValue(r);

  executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    body: snap.body ?? '',
  });
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
    unlink_file: true,
  });
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
