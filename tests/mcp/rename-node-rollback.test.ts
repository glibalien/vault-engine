import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('rename-node filesystem rollback', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-rename-rollback-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('reverses the on-disk rename when the outer transaction throws', () => {
    const writeLock = new WriteLockManager();

    // Create a node at Notes/old.md via the pipeline so DB and disk agree.
    const oldFilePath = 'Notes/old.md';
    const initial = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'old',
      types: [],
      fields: {},
      body: '# old',
    });
    const nodeId = initial.node_id;
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);

    const newFilePath = 'Notes/new.md';
    const fsUndos: Array<() => void> = [];
    const fsRollback = { push: (u: () => void) => fsUndos.push(u) };

    const txn = db.transaction(() => {
      executeRename(
        db,
        writeLock,
        vaultPath,
        { node_id: nodeId, file_path: oldFilePath, title: 'old' },
        'new',
        newFilePath,
        undefined,
        undefined,
        fsRollback,
      );
      throw new Error('simulated downstream failure after rename');
    });

    expect(() => txn()).toThrow('simulated downstream failure after rename');

    // Run the rollback (mimics what registerRenameNode does in the catch block).
    for (let i = fsUndos.length - 1; i >= 0; i--) {
      fsUndos[i]();
    }

    // DB-level: nodes row should still be at the old path.
    const row = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?')
      .get(nodeId) as { file_path: string; title: string };
    expect(row.file_path).toBe(oldFilePath);
    expect(row.title).toBe('old');

    // Filesystem: file should be back at the old path, not at the new path.
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, newFilePath))).toBe(false);
  });
});
