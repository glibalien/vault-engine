import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type Database from 'better-sqlite3';

describe("pipeline source: 'undo'", () => {
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
  });

  afterEach(() => { db.close(); cleanup(); });

  it('does not capture a snapshot when undoContext is provided with source=undo', () => {
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op-undo', Date.now(), 'undo-operations', 'restore');

    executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: null, file_path: 'restored.md',
      title: 'R', types: ['note'], fields: {}, body: 'r',
    }, undefined, { operation_id: 'op-undo' });

    const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('honors a caller-provided node_id on create (source=undo)', () => {
    const res = executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: 'restored_xyz', file_path: 'restored.md',
      title: 'R', types: ['note'], fields: {}, body: 'r',
    });
    expect(res.node_id).toBe('restored_xyz');
    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('restored_xyz');
    expect(row).toBeDefined();
  });

  it('tolerates REQUIRED_MISSING when source=undo (restoring pre-schema state)', () => {
    // Seed a global field + required claim
    db.prepare("INSERT INTO global_fields (name, field_type, required) VALUES ('status', 'string', 0)").run();
    db.prepare("INSERT INTO schema_field_claims (schema_name, field, required_override) VALUES ('note', 'status', 1)").run();

    // source='undo' should NOT throw even though the required field is absent
    expect(() => executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: null, file_path: 'x.md',
      title: 'X', types: ['note'], fields: {}, body: '',
    })).not.toThrow();
  });
});
