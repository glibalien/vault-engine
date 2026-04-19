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

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

function getLatestDeleteDetails(db: Database.Database, nodeId: string): Record<string, unknown> {
  const row = db.prepare(
    "SELECT details FROM edits_log WHERE event_type = 'file-deleted' AND node_id = ? ORDER BY timestamp DESC LIMIT 1",
  ).get(nodeId) as { details: string } | undefined;
  if (!row) throw new Error(`no file-deleted entry for ${nodeId}`);
  return JSON.parse(row.details);
}

describe('unified deletion routing', () => {
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

  it('fullIndex bulk-delete stamps source=fullIndex in edits_log', () => {
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n---\n# A\n', 'utf-8');
    fullIndex(vaultPath, db);
    const nodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('a.md') as { id: string }).id;

    rmSync(join(vaultPath, 'a.md'));
    fullIndex(vaultPath, db);

    const details = getLatestDeleteDetails(db, nodeId);
    expect(details.source).toBe('fullIndex');
    expect(details.file_path).toBe('a.md');
  });

  it('reconciler sweep stamps source=reconciler in edits_log', async () => {
    writeFileSync(join(vaultPath, 'b.md'), '---\ntypes:\n---\n# B\n', 'utf-8');
    fullIndex(vaultPath, db);
    const nodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('b.md') as { id: string }).id;

    const mutex = new IndexMutex();
    const writeLock = new WriteLockManager();
    const reconciler = startReconciler(
      vaultPath,
      db,
      mutex,
      writeLock,
      undefined,
      undefined,
      { initialDelayMs: 10, intervalMs: 60_000 },
    );

    rmSync(join(vaultPath, 'b.md'));
    await new Promise(resolve => setTimeout(resolve, 100));
    reconciler.stop();

    const details = getLatestDeleteDetails(db, nodeId);
    expect(details.source).toBe('reconciler');
  });

  it('reconciler sweep completes cleanly with multiple files in the same pass', async () => {
    writeFileSync(join(vaultPath, 'to-delete.md'), '---\ntypes:\n---\n# D\n', 'utf-8');
    writeFileSync(join(vaultPath, 'normal.md'), '---\ntypes:\n---\n# N\n', 'utf-8');
    fullIndex(vaultPath, db);
    const deletedId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('to-delete.md') as { id: string }).id;

    rmSync(join(vaultPath, 'to-delete.md'));

    const mutex = new IndexMutex();
    const writeLock = new WriteLockManager();
    const reconciler = startReconciler(
      vaultPath,
      db,
      mutex,
      writeLock,
      undefined,
      undefined,
      { initialDelayMs: 10, intervalMs: 60_000 },
    );

    await new Promise(resolve => setTimeout(resolve, 150));
    reconciler.stop();

    expect(db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE id = ?').get(deletedId)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE file_path = ?').get('normal.md')).toEqual({ c: 1 });
    const details = getLatestDeleteDetails(db, deletedId);
    expect(details.source).toBe('reconciler');
  });
});
