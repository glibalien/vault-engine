import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { acquireWriteLock, releaseWriteLock, isWriteLocked, watchVault } from '../../src/sync/watcher.js';
import { indexFile } from '../../src/sync/indexer.js';
import { parseFile } from '../../src/parser/index.js';

describe('write lock', () => {
  afterEach(() => {
    releaseWriteLock('test.md');
  });

  it('isWriteLocked returns false for unlocked path', () => {
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('isWriteLocked returns true after acquireWriteLock', () => {
    acquireWriteLock('test.md');
    expect(isWriteLocked('test.md')).toBe(true);
  });

  it('isWriteLocked returns false after releaseWriteLock', () => {
    acquireWriteLock('test.md');
    releaseWriteLock('test.md');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releaseWriteLock is a no-op for unlocked path', () => {
    expect(() => releaseWriteLock('nonexistent.md')).not.toThrow();
  });
});

// Helper: poll a condition until it's true or timeout
function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('watchVault', () => {
  let db: Database.Database;
  let tmpVault: string;
  let handle: { close(): Promise<void>; ready: Promise<void> } | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-watch-'));
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('indexes a new .md file', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    writeFileSync(join(tmpVault, 'test.md'), '# Hello\nWorld.');

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') !== undefined,
    );

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') as any;
    expect(node).toBeDefined();
    expect(node.content_text).toContain('Hello');
  });

  it('updates DB when a .md file is modified', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    writeFileSync(join(tmpVault, 'test.md'), '# Original');

    // Wait for initial add to be processed
    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') !== undefined,
    );

    writeFileSync(join(tmpVault, 'test.md'), '# Updated\nNew content.');

    await waitFor(() => {
      const node = db.prepare('SELECT content_text FROM nodes WHERE id = ?').get('test.md') as any;
      return node?.content_text?.includes('Updated');
    });

    const node = db.prepare('SELECT content_text FROM nodes WHERE id = ?').get('test.md') as any;
    expect(node.content_text).toContain('Updated');
  });

  it('removes node from DB when .md file is deleted', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    writeFileSync(join(tmpVault, 'test.md'), '# ToDelete');

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') !== undefined,
    );

    unlinkSync(join(tmpVault, 'test.md'));

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') === undefined,
    );

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md')).toBeUndefined();
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('test.md')).toBeUndefined();
  });

  it('ignores non-.md files', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    writeFileSync(join(tmpVault, 'readme.txt'), 'Not markdown.');
    writeFileSync(join(tmpVault, 'data.json'), '{}');
    writeFileSync(join(tmpVault, 'real.md'), '# Real');

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('real.md') !== undefined,
    );

    // Give extra time for any stray events
    await new Promise((r) => setTimeout(r, 200));

    const allNodes = db.prepare('SELECT id FROM nodes').all() as any[];
    expect(allNodes).toHaveLength(1);
    expect(allNodes[0].id).toBe('real.md');
  });

  it('skips indexing when path has active write lock', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    acquireWriteLock('locked.md');
    writeFileSync(join(tmpVault, 'locked.md'), '# Locked');

    // Write an unlocked file to prove the watcher is working
    writeFileSync(join(tmpVault, 'unlocked.md'), '# Unlocked');

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('unlocked.md') !== undefined,
    );

    // Give extra time for any stray events
    await new Promise((r) => setTimeout(r, 200));

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('locked.md')).toBeUndefined();

    releaseWriteLock('locked.md');
  });

  it('debounces rapid writes to the same file', async () => {
    handle = watchVault(db, tmpVault, { debounceMs: 100 });
    await handle.ready;

    // Write the same file 5 times rapidly
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmpVault, 'rapid.md'), `# Version ${i}`);
    }

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('rapid.md') !== undefined,
    );

    // The final content should be the last write
    const node = db.prepare('SELECT content_text FROM nodes WHERE id = ?').get('rapid.md') as any;
    expect(node.content_text).toContain('Version 4');

    // Only one files row should exist (not duplicates from multiple indexes)
    const files = db.prepare('SELECT * FROM files WHERE path = ?').all('rapid.md');
    expect(files).toHaveLength(1);
  });

  it('indexes files in subdirectories', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    mkdirSync(join(tmpVault, 'notes'), { recursive: true });
    writeFileSync(join(tmpVault, 'notes/deep.md'), '# Deep Note');

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('notes/deep.md') !== undefined,
    );

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('notes/deep.md') as any;
    expect(node).toBeDefined();
    expect(node.file_path).toBe('notes/deep.md');
  });

  it('skips re-index when file content unchanged (hash match)', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    const content = '---\ntitle: Stable\n---\n';
    const rel = 'stable.md';
    const absPath = join(tmpVault, rel);

    // Pre-index the file in the DB
    writeFileSync(absPath, content);
    const parsed = parseFile(rel, content);
    const mtime = statSync(absPath).mtime.toISOString();
    db.transaction(() => {
      indexFile(db, parsed, rel, mtime, content);
    })();

    // Touch the file (rewrite same content) — triggers chokidar change event
    // but hash should match, so watcher skips re-index
    writeFileSync(absPath, content);

    // Write a different file to prove the watcher is processing events
    writeFileSync(join(tmpVault, 'marker.md'), '# Marker');
    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('marker.md') !== undefined,
    );

    // Give time for any stray events
    await new Promise((r) => setTimeout(r, 200));

    // The stable file's DB entry should still have the original mtime
    // (watcher didn't re-index it)
    const filesRow = db.prepare('SELECT mtime FROM files WHERE path = ?').get(rel) as any;
    expect(filesRow.mtime).toBe(mtime);
  });
});
