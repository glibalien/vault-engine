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
  it('fresh createSchema includes resolved_target_id column and indexes', () => {
    const db = openDb();
    createSchema(db);
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('resolved_target_id');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relationships'").all() as Array<{ name: string }>;
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_relationships_resolved_target_id');
    expect(names).toContain('idx_relationships_source_resolved');
  });

  it('upgradeForResolvedTargetId is idempotent on DB missing the column', () => {
    const db = openDb();
    // Simulate an old DB: create relationships without resolved_target_id.
    db.prepare(
      'CREATE TABLE nodes (id TEXT PRIMARY KEY, file_path TEXT, title TEXT, body TEXT, content_hash TEXT, file_mtime INTEGER, indexed_at INTEGER, created_at INTEGER)'
    ).run();
    db.prepare(
      'CREATE TABLE relationships (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, target TEXT NOT NULL, rel_type TEXT NOT NULL, context TEXT, UNIQUE(source_id, target, rel_type))'
    ).run();
    db.prepare(
      'CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)'
    ).run();
    upgradeForResolvedTargetId(db);
    upgradeForResolvedTargetId(db); // second call should be a no-op
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('resolved_target_id');
  });

  it('version accessor reads/writes meta.resolved_targets_version', () => {
    const db = openDb();
    createSchema(db);
    expect(getResolvedTargetsVersion(db)).toBe(0); // default when absent
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);
    expect(getResolvedTargetsVersion(db)).toBe(CURRENT_RESOLVED_TARGETS_VERSION);
  });
});
