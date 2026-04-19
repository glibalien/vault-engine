import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';
import {
  createOperation,
  finalizeOperation,
  listOperations,
  getOperation,
  getSnapshots,
  markUndone,
} from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

describe('src/undo/operation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addUndoTables(db);
  });
  afterEach(() => db.close());

  it('createOperation inserts with node_count=0 and status active', () => {
    const id = createOperation(db, { source_tool: 'create-node', description: 'desc' });
    const row = db.prepare('SELECT * FROM undo_operations WHERE operation_id = ?').get(id) as { status: string; node_count: number; timestamp: number };
    expect(row.status).toBe('active');
    expect(row.node_count).toBe(0);
    expect(row.timestamp).toBeGreaterThan(0);
  });

  it('finalizeOperation counts snapshots', () => {
    const id = createOperation(db, { source_tool: 'batch-mutate', description: 'batch' });
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, 1), (?, ?, ?, 0)')
      .run(id, 'n1', 'a.md', id, 'n2', 'b.md');
    finalizeOperation(db, id);
    const row = db.prepare('SELECT node_count FROM undo_operations WHERE operation_id = ?').get(id) as { node_count: number };
    expect(row.node_count).toBe(2);
  });

  it('listOperations returns active operations by default, sorted desc by timestamp', () => {
    const id1 = createOperation(db, { source_tool: 'a', description: 'a' });
    // Ensure distinct timestamps
    db.prepare('UPDATE undo_operations SET timestamp = 1000 WHERE operation_id = ?').run(id1);
    const id2 = createOperation(db, { source_tool: 'b', description: 'b' });
    db.prepare('UPDATE undo_operations SET timestamp = 2000 WHERE operation_id = ?').run(id2);

    const out = listOperations(db, { status: 'active', limit: 10 });
    expect(out.operations.map(o => o.operation_id)).toEqual([id2, id1]);
    expect(out.truncated).toBe(false);
  });

  it('listOperations filters by since/until/source_tool', () => {
    const id1 = createOperation(db, { source_tool: 'create-node', description: '' });
    const id2 = createOperation(db, { source_tool: 'update-node', description: '' });
    db.prepare('UPDATE undo_operations SET timestamp = 500 WHERE operation_id = ?').run(id1);
    db.prepare('UPDATE undo_operations SET timestamp = 1500 WHERE operation_id = ?').run(id2);

    const out = listOperations(db, { since: new Date(1000).toISOString(), source_tool: 'update-node' });
    expect(out.operations.map(o => o.operation_id)).toEqual([id2]);
  });

  it('listOperations truncates at limit and reports truncated=true', () => {
    for (let i = 0; i < 3; i++) createOperation(db, { source_tool: 't', description: String(i) });
    const out = listOperations(db, { limit: 2 });
    expect(out.operations.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it('getSnapshots returns snapshots for an op', () => {
    const id = createOperation(db, { source_tool: 't', description: '' });
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, 1)').run(id, 'n1', 'a.md');
    const snaps = getSnapshots(db, id);
    expect(snaps.length).toBe(1);
    expect(snaps[0].node_id).toBe('n1');
  });

  it('markUndone flips status', () => {
    const id = createOperation(db, { source_tool: 't', description: '' });
    markUndone(db, id);
    const row = db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get(id) as { status: string };
    expect(row.status).toBe('undone');
  });

  it('getOperation returns null for missing id', () => {
    expect(getOperation(db, 'nope')).toBeNull();
  });
});
