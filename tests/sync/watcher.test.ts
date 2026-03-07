import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { acquireWriteLock, releaseWriteLock, isWriteLocked, watchVault } from '../../src/sync/watcher.js';

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
});
