import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { executeDeletion } from '../../src/pipeline/delete.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createOperation, finalizeOperation, getSnapshots } from '../../src/undo/operation.js';
import { detectConflicts, restoreOperation, restoreMany } from '../../src/undo/restore.js';
import type Database from 'better-sqlite3';

describe('detectConflicts', () => {
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

  it('flags modified_after_operation when current content_hash differs', () => {
    const opId = createOperation(db, { source_tool: 'update-node', description: 'u' });
    // Create node
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'c.md', title: 'C', types: ['note'], fields: {}, body: 'v1',
    });
    // Update capturing snapshot
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'c.md', title: 'C', types: ['note'], fields: {}, body: 'v2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);
    // External drift: mutate the node again (bypasses undo context)
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'c.md', title: 'C', types: ['note'], fields: {}, body: 'v3',
    });

    const snaps = getSnapshots(db, opId);
    const conflicts = detectConflicts(db, vaultPath, opId, snaps, new Set([opId]));
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason).toBe('modified_after_operation');
  });

  it('flags path_occupied when a deleted file\'s path is re-used by another node', () => {
    const opId = createOperation(db, { source_tool: 'delete-node', description: 'd' });
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'p.md', title: 'P', types: ['note'], fields: {}, body: '',
    });
    executeDeletion(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'p.md', unlink_file: true,
    }, { operation_id: opId });
    finalizeOperation(db, opId);
    // Create a different node at the same path
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'p.md', title: 'P', types: ['note'], fields: {}, body: 'different',
    });

    const snaps = getSnapshots(db, opId);
    const conflicts = detectConflicts(db, vaultPath, opId, snaps, new Set([opId]));
    expect(conflicts.find(c => c.reason === 'path_occupied')).toBeDefined();
  });

  it('flags superseded_by_later_op when a later active op has a snapshot for the same node', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'q.md', title: 'Q', types: ['note'], fields: {}, body: 'a',
    });
    const opEarly = createOperation(db, { source_tool: 'update-node', description: 'early' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'q.md', title: 'Q', types: ['note'], fields: {}, body: 'b',
    }, undefined, { operation_id: opEarly });
    finalizeOperation(db, opEarly);

    const opLate = createOperation(db, { source_tool: 'update-node', description: 'late' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'q.md', title: 'Q', types: ['note'], fields: {}, body: 'c',
    }, undefined, { operation_id: opLate });
    finalizeOperation(db, opLate);

    // Undoing only the earlier op; the later op is NOT in the set
    const snaps = getSnapshots(db, opEarly);
    const conflicts = detectConflicts(db, vaultPath, opEarly, snaps, new Set([opEarly]));
    expect(conflicts.find(c => c.reason === 'superseded_by_later_op')).toBeDefined();
  });

  it('does not flag superseded_by_later_op when later op is part of same undo call', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'r.md', title: 'R', types: ['note'], fields: {}, body: 'a',
    });
    const opEarly = createOperation(db, { source_tool: 'update-node', description: 'early' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'r.md', title: 'R', types: ['note'], fields: {}, body: 'b',
    }, undefined, { operation_id: opEarly });
    finalizeOperation(db, opEarly);
    const opLate = createOperation(db, { source_tool: 'update-node', description: 'late' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'r.md', title: 'R', types: ['note'], fields: {}, body: 'c',
    }, undefined, { operation_id: opLate });
    finalizeOperation(db, opLate);

    const snaps = getSnapshots(db, opEarly);
    const conflicts = detectConflicts(db, vaultPath, opEarly, snaps, new Set([opEarly, opLate]));
    expect(conflicts.find(c => c.reason === 'superseded_by_later_op')).toBeUndefined();
  });
});

describe('restoreOperation', () => {
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

  it('undoes a create by deleting the node', () => {
    const opId = createOperation(db, { source_tool: 'create-node', description: 'c' });
    const res = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'a.md', title: 'A', types: ['note'], fields: {}, body: 'x',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    const result = restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    expect(result.total_undone).toBe(1);
    const row = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(res.node_id);
    expect(row).toBeUndefined();
  });

  it('undoes an update by restoring pre-state body', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'b.md', title: 'B', types: ['note'], fields: {}, body: 'v1',
    });
    const opId = createOperation(db, { source_tool: 'update-node', description: 'u' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'b.md', title: 'B', types: ['note'], fields: {}, body: 'v2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(r1.node_id) as { body: string };
    expect(row.body).toBe('v1');
  });

  it('undoes a delete by recreating the node with its original id', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'd.md', title: 'D', types: ['note'], fields: {}, body: 'orig',
    });
    const opId = createOperation(db, { source_tool: 'delete-node', description: 'd' });
    executeDeletion(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'd.md', unlink_file: true,
    }, { operation_id: opId });
    finalizeOperation(db, opId);

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT body, id FROM nodes WHERE id = ?').get(r1.node_id) as { body: string; id: string };
    expect(row.id).toBe(r1.node_id);
    expect(row.body).toBe('orig');
  });

  it('dry-run returns zero total_undone but computes conflicts', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'e.md', title: 'E', types: ['note'], fields: {}, body: 'v1',
    });
    const opId = createOperation(db, { source_tool: 'update-node', description: 'u' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'e.md', title: 'E', types: ['note'], fields: {}, body: 'v2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    const result = restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]), { dry_run: true });
    expect(result.total_undone).toBe(0);
    expect(result.operations[0].status).toBe('would_undo');
    const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(r1.node_id) as { body: string };
    expect(row.body).toBe('v2'); // not changed
  });

  it('rolls back DB restores when a later snapshot restore fails', () => {
    const a = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'a.md', title: 'A', types: ['note'], fields: {}, body: 'a1',
    });
    const b = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'b.md', title: 'B', types: ['note'], fields: {}, body: 'b1',
    });

    const opId = createOperation(db, { source_tool: 'batch-mutate', description: 'multi-update' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: a.node_id, file_path: 'a.md', title: 'A', types: ['note'], fields: {}, body: 'a2',
    }, undefined, { operation_id: opId });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: b.node_id, file_path: 'b.md', title: 'B', types: ['note'], fields: {}, body: 'b2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    db.prepare('UPDATE undo_snapshots SET file_path = ? WHERE operation_id = ? AND node_id = ?')
      .run('../escape.md', opId, b.node_id);

    expect(() => restoreOperation(db, writeLock, vaultPath, opId, new Set([opId])))
      .toThrow('Path traversal blocked');

    const aRow = db.prepare('SELECT body FROM nodes WHERE id = ?').get(a.node_id) as { body: string };
    const bRow = db.prepare('SELECT body FROM nodes WHERE id = ?').get(b.node_id) as { body: string };
    const opRow = db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get(opId) as { status: string };
    const aFile = readFileSync(join(vaultPath, 'a.md'), 'utf-8');
    expect(aRow.body).toBe('a2');
    expect(bRow.body).toBe('b2');
    expect(opRow.status).toBe('active');
    expect(aFile).toContain('a2');
  });
});
