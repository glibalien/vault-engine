import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { startWatcher } from '../../src/sync/watcher.js';

const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nodeCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) as cnt FROM nodes').get() as { cnt: number };
  return row.cnt;
}

describe('watcher integration', () => {
  let vaultPath: string;
  let dbPath: string;
  let db: Database.Database;
  let mutex: IndexMutex;
  let writeLock: WriteLockManager;
  let watcher: FSWatcher;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-watcher-test-'));
    dbPath = join(vaultPath, '.vault-engine', 'test.db');

    // Write an initial file before indexing
    writeFileSync(
      join(vaultPath, 'initial.md'),
      '---\ntitle: Initial\n---\nSome content\n',
      'utf-8',
    );

    // File-based SQLite (not :memory:) so watcher and indexer share it
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    fullIndex(vaultPath, db);

    mutex = new IndexMutex();
    writeLock = new WriteLockManager();

    watcher = startWatcher(vaultPath, db, mutex, writeLock, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
    });

    // Wait for chokidar to be ready
    await delay(100);
  });

  afterEach(async () => {
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('indexes a new file', async () => {
    const before = nodeCount(db);

    writeFileSync(
      join(vaultPath, 'new-file.md'),
      '---\ntitle: New File\n---\nNew content\n',
      'utf-8',
    );

    await delay(DEBOUNCE_MS + 100);
    await mutex.onIdle();

    expect(nodeCount(db)).toBe(before + 1);
  });

  it('re-indexes a changed file', async () => {
    const before = db.prepare("SELECT title FROM nodes WHERE file_path = 'initial.md'").get() as {
      title: string;
    };
    expect(before.title).toBe('Initial');

    writeFileSync(
      join(vaultPath, 'initial.md'),
      '---\ntitle: Updated Title\n---\nUpdated content\n',
      'utf-8',
    );

    await delay(DEBOUNCE_MS + 100);
    await mutex.onIdle();

    const after = db.prepare("SELECT title FROM nodes WHERE file_path = 'initial.md'").get() as {
      title: string;
    };
    expect(after.title).toBe('Updated Title');
  });

  it('deletes a removed file', async () => {
    const before = nodeCount(db);
    expect(before).toBeGreaterThanOrEqual(1);

    unlinkSync(join(vaultPath, 'initial.md'));

    // Unlink is immediate (no debounce), but chokidar needs time to detect
    await delay(300);
    await mutex.onIdle();

    expect(nodeCount(db)).toBe(before - 1);
  });

  it('ignores non-.md files', async () => {
    const before = nodeCount(db);

    writeFileSync(join(vaultPath, 'readme.txt'), 'Just a text file\n', 'utf-8');

    await delay(DEBOUNCE_MS + 100);
    // No mutex.onIdle needed since the event should be ignored entirely
    await delay(100);

    expect(nodeCount(db)).toBe(before);
  });
});
