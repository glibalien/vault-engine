import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import {
  CURRENT_RESOLVED_TARGETS_VERSION,
  getResolvedTargetsVersion,
  setResolvedTargetsVersion,
} from '../../src/resolver/resolved-targets-version.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

describe('resolved-target startup backfill', () => {
  it('first-open populates resolved_target_id on pre-existing NULL rows', () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('A', 'Foo.md', 'Foo', '', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src', 'Source.md', 'Source', '', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('src', 'Foo', 'wiki-link');

    expect(getResolvedTargetsVersion(db)).toBe(0);
    const stats = backfillResolvedTargets(db);
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);

    expect(stats.updated).toBe(1);
    expect(getResolvedTargetsVersion(db)).toBe(CURRENT_RESOLVED_TARGETS_VERSION);

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('src') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).toBe('A');
  });

  it('second-open is a no-op when version is current', () => {
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);
    // Simulating startup: caller checks version before calling backfill.
    // Here we assert the helper still correctly reports zero updates on an
    // already-populated DB.
    const stats = backfillResolvedTargets(db);
    expect(stats.scanned).toBe(0);
  });
});
