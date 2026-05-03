import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startWatcher } from '../../src/sync/watcher.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('watcher path version bump', () => {
  let vaultPath: string;
  let db: Database.Database;
  let mutex: IndexMutex;
  let watcher: FSWatcher;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-version-watch-'));
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, 'watched.md'), '---\ntitle: Watched\n---\nInitial body\n', 'utf-8');

    db = new Database(join(vaultPath, '.vault-engine', 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    fullIndex(vaultPath, db);

    mutex = new IndexMutex();
    watcher = startWatcher(vaultPath, db, mutex, new WriteLockManager(), undefined, undefined, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
    });
    await delay(100);
  });

  afterEach(async () => {
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('bumps node version when a file is edited on disk', async () => {
    const before = db.prepare("SELECT id, version FROM nodes WHERE file_path = 'watched.md'")
      .get() as { id: string; version: number };
    expect(before.version).toBe(1);

    writeFileSync(join(vaultPath, 'watched.md'), '---\ntitle: Watched\n---\nEdited body\n', 'utf-8');
    await delay(DEBOUNCE_MS + 100);
    await mutex.onIdle();

    const after = db.prepare('SELECT version, body FROM nodes WHERE id = ?')
      .get(before.id) as { version: number; body: string };
    expect(after.version).toBeGreaterThan(1);
    expect(after.body).toContain('Edited body');
  });
});
