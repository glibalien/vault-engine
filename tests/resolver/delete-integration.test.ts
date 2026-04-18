import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { deleteNodeByPath } from '../../src/indexer/indexer.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

describe('delete lifecycle', () => {
  it('ON DELETE SET NULL nullifies resolved_target_id for incoming edges', () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('tgt', 'Target.md', 'Target', '', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src', 'Source.md', 'Source', '', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src', 'Target', 'wiki-link', 'tgt');

    deleteNodeByPath('Target.md', db);

    const row = db.prepare(
      'SELECT resolved_target_id, target FROM relationships WHERE source_id = ?'
    ).get('src') as { resolved_target_id: string | null; target: string };
    expect(row.resolved_target_id).toBeNull();
    expect(row.target).toBe('Target'); // raw target text preserved
  });
});
