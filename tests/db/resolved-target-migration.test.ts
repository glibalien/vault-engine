import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForResolvedTargetId } from '../../src/db/migrate.js';
import {
  CURRENT_RESOLVED_TARGETS_VERSION,
  getResolvedTargetsVersion,
  setResolvedTargetsVersion,
} from '../../src/resolver/resolved-targets-version.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('resolved_target_id schema + migration', () => {
  it('fresh createSchema + migration yields resolved_target_id column and both indexes', () => {
    const db = openDb();
    createSchema(db);
    upgradeForResolvedTargetId(db);
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('resolved_target_id');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relationships'").all() as Array<{ name: string }>;
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_relationships_resolved_target_id');
    expect(names).toContain('idx_relationships_source_resolved');
  });

  it('existing-DB startup path: createSchema over a pre-migration table + migration succeeds', () => {
    // Regression: production failed here because createSchema's `CREATE INDEX ON
    // relationships(resolved_target_id)` fired against a table that pre-existed
    // without the column. Mirrors the real systemd startup order.
    const db = openDb();
    db.prepare(
      'CREATE TABLE nodes (id TEXT PRIMARY KEY, file_path TEXT, title TEXT, body TEXT, content_hash TEXT, file_mtime INTEGER, indexed_at INTEGER, created_at INTEGER)'
    ).run();
    db.prepare(
      'CREATE TABLE relationships (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, target TEXT NOT NULL, rel_type TEXT NOT NULL, context TEXT, UNIQUE(source_id, target, rel_type))'
    ).run();
    db.prepare(
      'CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)'
    ).run();

    expect(() => createSchema(db)).not.toThrow();
    expect(() => upgradeForResolvedTargetId(db)).not.toThrow();
    expect(() => upgradeForResolvedTargetId(db)).not.toThrow(); // idempotent

    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('resolved_target_id');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relationships'").all() as Array<{ name: string }>;
    expect(names.map(i => i.name)).toEqual(expect.arrayContaining([
      'idx_relationships_resolved_target_id',
      'idx_relationships_source_resolved',
    ]));
  });

  it('version accessor reads/writes meta.resolved_targets_version', () => {
    const db = openDb();
    createSchema(db);
    expect(getResolvedTargetsVersion(db)).toBe(0); // default when absent
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);
    expect(getResolvedTargetsVersion(db)).toBe(CURRENT_RESOLVED_TARGETS_VERSION);
  });
});
