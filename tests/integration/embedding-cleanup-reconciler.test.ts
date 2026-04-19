import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startReconciler } from '../../src/sync/reconciler.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';

// Using mkdtempSync (empty vault) instead of createTempVault (fixture vault) to
// avoid racing against pre-existing fixture files. The test only needs to assert
// that the specific deleted node's ID appears in mock.removed, so isolation is
// more important than fixture realism here.

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

function createMockEmbeddingIndexer(): Pick<EmbeddingIndexer, 'removeNode'> & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    removeNode(nodeId: string) { removed.push(nodeId); },
  };
}

describe('reconciler embedding cleanup', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('calls embeddingIndexer.removeNode on sweep-detected deletions', async () => {
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n---\n# A\n', 'utf-8');
    fullIndex(vaultPath, db);
    const nodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('a.md') as { id: string }).id;

    const mock = createMockEmbeddingIndexer();
    const mutex = new IndexMutex();
    const writeLock = new WriteLockManager();
    const reconciler = startReconciler(
      vaultPath,
      db,
      mutex,
      writeLock,
      undefined,
      mock as unknown as EmbeddingIndexer,
      { initialDelayMs: 10, intervalMs: 60_000 },
    );

    // Delete file, wait for initial sweep to fire.
    rmSync(join(vaultPath, 'a.md'));
    await new Promise(resolve => setTimeout(resolve, 100));
    reconciler.stop();

    expect(mock.removed).toContain(nodeId);
  });
});
