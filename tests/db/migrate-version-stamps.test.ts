import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToVersionStamps } from '../../src/db/migrate.js';

function createPreVersionDb(): Database.Database {
  const db = new Database(':memory:');
  db.prepare(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT,
      body TEXT,
      content_hash TEXT,
      file_mtime INTEGER,
      indexed_at INTEGER,
      created_at INTEGER
    )
  `).run();
  return db;
}

describe('upgradeToVersionStamps', () => {
  it('adds the version column and backfills existing rows to 1', () => {
    const db = createPreVersionDb();
    db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run('a', 'a.md');
    db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run('b', 'b.md');

    upgradeToVersionStamps(db);

    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('version');

    const rows = db.prepare('SELECT id, version FROM nodes ORDER BY id').all() as { id: string; version: number }[];
    expect(rows).toEqual([
      { id: 'a', version: 1 },
      { id: 'b', version: 1 },
    ]);
    db.close();
  });

  it('is idempotent (safe to run twice)', () => {
    const db = createPreVersionDb();
    upgradeToVersionStamps(db);
    expect(() => upgradeToVersionStamps(db)).not.toThrow();
    db.close();
  });

  it('leaves version values untouched on re-run', () => {
    const db = createPreVersionDb();
    db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run('a', 'a.md');
    upgradeToVersionStamps(db);
    db.prepare('UPDATE nodes SET version = 42 WHERE id = ?').run('a');
    upgradeToVersionStamps(db);
    const v = (db.prepare('SELECT version FROM nodes WHERE id = ?').get('a') as { version: number }).version;
    expect(v).toBe(42);
    db.close();
  });

  it('fresh schema includes the version column', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('version');
    db.close();
  });
});
