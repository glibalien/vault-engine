// src/undo/operation.ts

import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { UndoOperationRow, UndoSnapshotRow } from './types.js';

export interface CreateOperationParams {
  source_tool: string;
  description: string;
}

export function createOperation(
  db: Database.Database,
  params: CreateOperationParams,
): string {
  const operation_id = nanoid();
  // Timestamps are strictly monotonic so the superseded-by-later-op conflict
  // check in restore.ts (ordering via timestamp >) can't fail on ms-resolution
  // collisions when two operations are created in the same millisecond.
  const lastTs = (db.prepare('SELECT MAX(timestamp) AS t FROM undo_operations').get() as { t: number | null }).t ?? 0;
  const timestamp = Math.max(Date.now(), lastTs + 1);
  db.prepare(`
    INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status)
    VALUES (?, ?, ?, ?, 0, 'active')
  `).run(operation_id, timestamp, params.source_tool, params.description);
  return operation_id;
}

export function finalizeOperation(db: Database.Database, operation_id: string): void {
  // Called from tool-handler `finally` blocks. We must not throw here because
  // that would mask a PipelineError in flight. A failed node_count update
  // isn't fatal — the row stays at 0 and the orphan sweep will clean it up.
  try {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots WHERE operation_id = ?')
      .get(operation_id) as { c: number }).c;
    db.prepare('UPDATE undo_operations SET node_count = ? WHERE operation_id = ?')
      .run(count, operation_id);
  } catch (err) {
    console.error(`finalizeOperation failed for ${operation_id}:`, err instanceof Error ? err.message : err);
  }
}

export function markUndone(db: Database.Database, operation_id: string): void {
  db.prepare("UPDATE undo_operations SET status = 'undone' WHERE operation_id = ?")
    .run(operation_id);
}

export function getOperation(db: Database.Database, operation_id: string): UndoOperationRow | null {
  const row = db.prepare('SELECT * FROM undo_operations WHERE operation_id = ?').get(operation_id) as UndoOperationRow | undefined;
  return row ?? null;
}

export function getSnapshots(db: Database.Database, operation_id: string): UndoSnapshotRow[] {
  return db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?')
    .all(operation_id) as UndoSnapshotRow[];
}

export interface ListParams {
  since?: string;           // ISO 8601
  until?: string;           // ISO 8601
  source_tool?: string;
  status?: 'active' | 'undone' | 'expired' | 'all';
  limit?: number;           // default 20, max 100
}

export interface ListResult {
  operations: UndoOperationRow[];
  truncated: boolean;
}

export function listOperations(db: Database.Database, params: ListParams = {}): ListResult {
  const limit = Math.min(params.limit ?? 20, 100);
  const clauses: string[] = [];
  const values: (string | number)[] = [];

  const status = params.status ?? 'active';
  if (status !== 'all') {
    clauses.push('status = ?');
    values.push(status);
  }
  if (params.source_tool) {
    clauses.push('source_tool = ?');
    values.push(params.source_tool);
  }
  if (params.since) {
    clauses.push('timestamp >= ?');
    values.push(new Date(params.since).getTime());
  }
  if (params.until) {
    clauses.push('timestamp <= ?');
    values.push(new Date(params.until).getTime());
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const schemaCountProjection = columnExists(db, 'undo_operations', 'schema_count')
    ? 'schema_count'
    : '0 AS schema_count';
  const globalFieldCountProjection = columnExists(db, 'undo_operations', 'global_field_count')
    ? 'global_field_count'
    : '0 AS global_field_count';

  const rows = db.prepare(
    `SELECT operation_id, timestamp, source_tool, description,
            node_count, ${schemaCountProjection}, ${globalFieldCountProjection}, status
     FROM undo_operations ${where}
     ORDER BY timestamp DESC LIMIT ?`
  ).all(...values, limit + 1) as UndoOperationRow[];

  return {
    operations: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .some(c => c.name === columnName);
}
