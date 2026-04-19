import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type Database from 'better-sqlite3';

describe('executeMutation — undo snapshot capture', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    // Seed the undo operation
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op1', Date.now(), 'create-node', 'test');
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('writes a was_deleted=1 snapshot for a create (node_id null)', () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'foo.md',
      title: 'Foo',
      types: ['note'],
      fields: {},
      body: 'hello',
    }, undefined, { operation_id: 'op1' });

    const snaps = db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?').all('op1') as Array<{ was_deleted: number; post_mutation_hash: string | null; file_path: string }>;
    expect(snaps.length).toBe(1);
    expect(snaps[0].was_deleted).toBe(1);
    expect(snaps[0].file_path).toBe('foo.md');
    expect(snaps[0].post_mutation_hash).not.toBeNull();
  });

  it('writes a was_deleted=0 snapshot capturing pre-state for an update', () => {
    // First create
    const createRes = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'bar.md',
      title: 'Bar', types: ['note'], fields: {}, body: 'first',
    });
    const nodeId = createRes.node_id;

    // Seed a second operation
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op2', Date.now(), 'update-node', 'update');

    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: nodeId, file_path: 'bar.md',
      title: 'Bar', types: ['note'], fields: {}, body: 'second',
    }, undefined, { operation_id: 'op2' });

    const snap = db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?').get('op2') as { was_deleted: number; body: string; post_mutation_hash: string | null };
    expect(snap.was_deleted).toBe(0);
    expect(snap.body).toBe('first');  // pre-state, not post
    expect(snap.post_mutation_hash).not.toBeNull();
  });

  it('does not write a snapshot when undoContext is absent', () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'baz.md',
      title: 'Baz', types: ['note'], fields: {}, body: '',
    });
    const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
