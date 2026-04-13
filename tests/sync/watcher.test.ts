import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { WriteGate } from '../../src/sync/write-gate.js';
import { startWatcher, processFileChange } from '../../src/sync/watcher.js';

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
  let writeGate: WriteGate;
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
    writeGate = new WriteGate({ quietPeriodMs: 50 }); // fast for tests

    watcher = startWatcher(vaultPath, db, mutex, writeLock, writeGate, undefined, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
    });

    // Wait for chokidar to be ready
    await delay(100);
  });

  afterEach(async () => {
    writeGate.dispose();
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

  it('rapid edit after create: WriteGate does not clobber user edits', async () => {
    // Regression: creating a file then quickly editing it caused the
    // WriteGate to fire with stale DB state, overwriting the edit.
    const filePath = join(vaultPath, 'Person.md');

    // Step 1: create file (simulates Obsidian creating a new note)
    writeFileSync(filePath, '---\ntitle: Person\ntypes:\n---\n', 'utf-8');

    // Wait for watcher to process the create
    await delay(DEBOUNCE_MS + 100);
    await mutex.onIdle();

    // Step 2: user edits file quickly (adds types: person)
    writeFileSync(filePath, '---\ntitle: Person\ntypes:\n  - person\n---\n', 'utf-8');

    // Wait for watcher to process the edit + WriteGate quiet period
    await delay(DEBOUNCE_MS + 100);
    await mutex.onIdle();
    // WriteGate quiet period (50ms in test config) + buffer
    await delay(200);

    // DB should have the user's types
    const types = db.prepare(
      "SELECT schema_type FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE file_path = 'Person.md')"
    ).all() as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toContain('person');

    // File on disk should also have the type
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('person');
  });
});

// ── WriteGate deferred-write tests (using processFileChange directly) ──

describe('processFileChange — WriteGate deferred writes', () => {
  let vaultPath: string;
  let dbPath: string;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let writeGate: WriteGate;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-gate-test-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    dbPath = join(vaultPath, '.vault-engine', 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    writeGate = new WriteGate({ quietPeriodMs: 100 });
  });

  afterEach(() => {
    writeGate.dispose();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('with WriteGate: DB updates immediately, file write deferred', () => {
    const filePath = join(vaultPath, 'Note.md');
    writeFileSync(filePath, '---\ntitle: Note\n---\nOriginal body.\n', 'utf-8');
    fullIndex(vaultPath, db);

    writeFileSync(filePath, '---\ntitle: Note\n---\nUpdated body.\n', 'utf-8');

    processFileChange(filePath, 'Note.md', db, writeLock, vaultPath, writeGate);

    // DB is updated immediately
    const node = db.prepare("SELECT body FROM nodes WHERE file_path = 'Note.md'").get() as { body: string };
    expect(node.body.trim()).toBe('Updated body.');

    // A deferred write is pending
    expect(writeGate.isPending('Note.md')).toBe(true);
  });

  it('without WriteGate: file write is immediate', () => {
    const filePath = join(vaultPath, 'Note.md');
    writeFileSync(filePath, '---\ntitle: Note\n---\nOriginal body.\n', 'utf-8');
    fullIndex(vaultPath, db);

    writeFileSync(filePath, '---\ntitle: Note\n---\nUpdated body.\n', 'utf-8');

    // No writeGate passed — writes immediately
    processFileChange(filePath, 'Note.md', db, writeLock, vaultPath);

    const afterContent = readFileSync(filePath, 'utf-8');
    expect(afterContent).toContain('Updated body.');
  });

  it('processes new types and updates DB (deferred write pending)', () => {
    const filePath = join(vaultPath, 'Person.md');
    writeFileSync(filePath, 'Body text.\n', 'utf-8');
    fullIndex(vaultPath, db);

    writeFileSync(filePath, '---\ntypes:\n  - person\n---\nBody text.\n', 'utf-8');

    processFileChange(filePath, 'Person.md', db, writeLock, vaultPath, writeGate);

    // DB updated with types
    const types = db.prepare(
      "SELECT schema_type FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE file_path = 'Person.md')"
    ).all() as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toContain('person');
  });
});
