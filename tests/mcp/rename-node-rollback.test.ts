import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';
import { executeRename, registerRenameNode } from '../../src/mcp/tools/rename-node.js';
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

  it('registerRenameNode catch path: rolls back file and returns INTERNAL_ERROR', async () => {
    // Add undo tables + sort-order column (required by registerRenameNode →
    // createOperation and node_types sort_order queries).
    addUndoTables(db);
    addNodeTypesSortOrder(db);

    // Use a normal lock for setup so the node is created cleanly.
    const setupLock = new WriteLockManager();

    // Create the node. After this, Notes/RollbackOrig.md is on disk and in the DB.
    const oldFilePath = 'Notes/RollbackOrig.md';
    executeMutation(db, setupLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'RollbackOrig',
      types: [],
      fields: {},
      body: '',
    });
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);

    // Stale the DB content_hash so the no-op guard in executeMutation doesn't
    // short-circuit the write path inside executeRename's re-render step.
    // Without this, rendered content is identical to disk content and the
    // pipeline exits early, never reaching writeLock.withLockSync().
    db.prepare("UPDATE nodes SET content_hash = 'stale' WHERE file_path = ?")
      .run(oldFilePath);

    // Now build a WriteLockManager that throws on its very first withLockSync
    // call. Since the setup executeMutation used a separate lock, the first
    // call this lock sees is the re-render inside executeRename (after
    // renameSync has already moved the file to the new path).
    class FailingWriteLockManager extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        throw new Error('simulated write-lock failure on re-render');
      }
    }
    const failingLock = new FailingWriteLockManager();

    // Capture the registered handler via a fake McpServer (same pattern as
    // rename-node-directory.test.ts).
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
        handler = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerRenameNode(fakeServer, db, failingLock, vaultPath);

    const newFilePath = 'Notes/RollbackNew.md';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Invoke the full handler. Inside executeRename:
    //   step 1 — renameSync moves the file to RollbackNew.md (already on disk)
    //   step 2 — UPDATE nodes SET file_path … (in txn)
    //   step 3 — executeMutation re-renders → withLockSync throws → txn rolls back
    // The catch block in registerRenameNode runs fsUndos in reverse, restoring the file.
    const raw = await handler({ title: 'RollbackOrig', new_title: 'RollbackNew' });
    const result = JSON.parse(
      (raw as { content: Array<{ text: string }> }).content[0].text,
    );

    errorSpy.mockRestore();

    // 1. Handler returns INTERNAL_ERROR.
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INTERNAL_ERROR');

    // 2. DB row still points at the old path.
    const row = db.prepare('SELECT file_path FROM nodes WHERE title = ?')
      .get('RollbackOrig') as { file_path: string } | undefined;
    expect(row?.file_path).toBe(oldFilePath);

    // 3. File restored on disk.
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, newFilePath))).toBe(false);
  });

  it('registerRenameNode catch path: restores executeMutation file writes before rolling back the rename', async () => {
    addUndoTables(db);
    addNodeTypesSortOrder(db);

    const setupLock = new WriteLockManager();

    const oldFilePath = 'Notes/RollbackOrig.md';
    executeMutation(db, setupLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'RollbackOrig',
      types: [],
      fields: {},
      body: '',
    });

    const refFilePath = 'Notes/Ref.md';
    executeMutation(db, setupLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: refFilePath,
      title: 'Ref',
      types: [],
      fields: {},
      body: 'See [[RollbackOrig]].',
    });

    class FailingAfterWriteLockManager extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        const result = fn();
        throw new Error(`simulated post-write failure for ${filePath}`);
      }
    }
    const failingLock = new FailingAfterWriteLockManager();

    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
        handler = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerRenameNode(fakeServer, db, failingLock, vaultPath);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = await handler({ title: 'RollbackOrig', new_title: 'RollbackNew' });
    const result = JSON.parse(
      (raw as { content: Array<{ text: string }> }).content[0].text,
    );
    errorSpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INTERNAL_ERROR');

    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/RollbackNew.md'))).toBe(false);
    expect(readFileSync(join(vaultPath, refFilePath), 'utf-8')).toContain('[[RollbackOrig]]');
    expect(readFileSync(join(vaultPath, refFilePath), 'utf-8')).not.toContain('[[RollbackNew]]');
  });
});
