import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createSchema } from '../../src/db/schema.js';

describe('createSchema', () => {
  it('creates all required tables', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('nodes');
    expect(names).toContain('node_types');
    expect(names).toContain('global_fields');
    expect(names).toContain('schemas');
    expect(names).toContain('node_fields');
    expect(names).toContain('relationships');
    expect(names).toContain('edits_log');
    expect(names).toContain('embeddings');
  });

  it('creates nodes_fts virtual table', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('enforces nodes.file_path uniqueness', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('id1', 'test.md', 'Test', '', 'hash1', 1000, 1000);

    expect(() =>
      db.prepare(
        "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('id2', 'test.md', 'Test 2', '', 'hash2', 1000, 1000)
    ).toThrow();
  });

  it('cascades node deletion to node_types', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)").run('n1', 'note');

    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');

    const types = db.prepare("SELECT * FROM node_types WHERE node_id = ?").all('n1');
    expect(types).toHaveLength(0);
  });

  it('cascades node deletion to node_fields', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare(
      "INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)"
    ).run('n1', 'project', 'Vault Engine', 'frontmatter');

    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');

    const fields = db.prepare("SELECT * FROM node_fields WHERE node_id = ?").all('n1');
    expect(fields).toHaveLength(0);
  });

  it('cascades node deletion to relationships', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)"
    ).run('n1', 'Other Note', 'wiki-link');

    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');

    const rels = db.prepare("SELECT * FROM relationships WHERE source_id = ?").all('n1');
    expect(rels).toHaveLength(0);
  });

  it('enforces relationship uniqueness on (source_id, target, rel_type)', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)"
    ).run('n1', 'Other', 'wiki-link');

    expect(() =>
      db.prepare(
        "INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)"
      ).run('n1', 'Other', 'wiki-link')
    ).toThrow();
  });

  it('is idempotent (calling createSchema twice does not error)', () => {
    const db = createTestDb();
    expect(() => createSchema(db)).not.toThrow();
  });
});
