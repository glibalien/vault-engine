import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { runUndoCleanup } from '../../src/undo/cleanup.js';
import type Database from 'better-sqlite3';

describe('runUndoCleanup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addUndoTables(db);
  });
  afterEach(() => db.close());

  function seed(id: string, ageMs: number, status: 'active' | 'undone' | 'expired', nodeCount = 1) {
    db.prepare(`INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, 'x', '', ?, ?)`)
      .run(id, Date.now() - ageMs, nodeCount, status);
  }

  it('flips active → expired when past retention window', () => {
    seed('old', 25 * 60 * 60 * 1000, 'active');   // 25h old
    seed('fresh', 1 * 60 * 60 * 1000, 'active');  // 1h old
    runUndoCleanup(db, { retentionHours: 24 });

    expect((db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get('old') as { status: string }).status).toBe('expired');
    expect((db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get('fresh') as { status: string }).status).toBe('active');
  });

  it('deletes already-expired rows on the next pass', () => {
    seed('gone', 25 * 60 * 60 * 1000, 'expired');
    runUndoCleanup(db, { retentionHours: 24 });
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('gone')).toBeUndefined();
  });

  it('deletes undone rows past retention directly', () => {
    seed('done', 25 * 60 * 60 * 1000, 'undone');
    runUndoCleanup(db, { retentionHours: 24 });
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('done')).toBeUndefined();
  });

  it('deletes orphan rows (node_count=0) older than 60s', () => {
    seed('orphan', 2 * 60 * 1000, 'active', 0); // 2 min old, no snapshots
    seed('recent-orphan', 30 * 1000, 'active', 0); // 30s old — still likely in-flight
    runUndoCleanup(db, { retentionHours: 24 });
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('orphan')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('recent-orphan')).toBeDefined();
  });

  it('cascades snapshot deletion when an operation is deleted', () => {
    seed('with-snaps', 25 * 60 * 60 * 1000, 'expired', 2);
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, 1), (?, ?, ?, 1)')
      .run('with-snaps', 'n1', 'a.md', 'with-snaps', 'n2', 'b.md');
    runUndoCleanup(db, { retentionHours: 24 });
    const remain = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(remain).toBe(0);
  });
});
