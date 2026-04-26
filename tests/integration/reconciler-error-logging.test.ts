import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
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

describe('reconciler error logging', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-reconciler-err-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('writes a reconciler-error edits_log entry when a file sweep throws', async () => {
    // Write a file but remove read permission so statSync / readFileSync throws.
    const bad = join(vaultPath, 'unreadable.md');
    writeFileSync(bad, '---\ntypes:\n---\n# X\n', 'utf-8');
    chmodSync(bad, 0o000);

    try {
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

      const entries = db.prepare(
        "SELECT details FROM edits_log WHERE event_type = 'reconciler-error'"
      ).all() as Array<{ details: string }>;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some(e => e.details.includes('unreadable.md'))).toBe(true);
    } finally {
      // Restore permissions so cleanup can delete the file.
      chmodSync(bad, 0o644);
    }
  });

  it('emits a console.error tagged [reconciler] when a per-file sweep throws', async () => {
    const bad = join(vaultPath, 'unreadable.md');
    writeFileSync(bad, '---\ntypes:\n---\n# X\n', 'utf-8');
    chmodSync(bad, 0o000);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
    };

    try {
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

      expect(errors.some(line => line.includes('[reconciler]') && line.includes('unreadable.md'))).toBe(true);
    } finally {
      console.error = originalError;
      chmodSync(bad, 0o644);
    }
  });
});
