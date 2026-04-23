import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';

describe('addUndoTables', () => {
  it('creates undo_operations and undo_snapshots with expected columns and indexes', () => {
    const db = createTestDb();
    addUndoTables(db);

    const opCols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>);
    expect(opCols.map(c => c.name).sort()).toEqual(
      ['description', 'node_count', 'operation_id', 'schema_count', 'source_tool', 'status', 'timestamp'],
    );
    expect(opCols.find(c => c.name === 'operation_id')?.pk).toBe(1);

    const snapCols = (db.prepare('PRAGMA table_info(undo_snapshots)').all() as Array<{ name: string; pk: number }>);
    expect(snapCols.map(c => c.name).sort()).toEqual(
      ['body', 'fields', 'file_path', 'node_id', 'operation_id', 'post_mutation_hash', 'relationships', 'title', 'types', 'was_deleted'],
    );

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('undo_operations','undo_snapshots')").all() as Array<{ name: string }>).map(r => r.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_undo_operations_timestamp',
      'idx_undo_operations_status',
      'idx_undo_snapshots_node',
    ]));
  });

  it('is idempotent — safe to run twice', () => {
    const db = createTestDb();
    addUndoTables(db);
    expect(() => addUndoTables(db)).not.toThrow();
  });

  it('cascades snapshot deletion when operation is deleted', () => {
    const db = createTestDb();
    addUndoTables(db);
    db.prepare('INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('op1', 1, 'create-node', 'desc', 1, 'active');
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, ?)')
      .run('op1', 'n1', 'a.md', 1);

    db.prepare('DELETE FROM undo_operations WHERE operation_id = ?').run('op1');
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});
