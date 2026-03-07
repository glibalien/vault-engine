import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';

describe('createSchema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  const expectedTables = [
    'nodes',
    'node_types',
    'fields',
    'relationships',
    'schemas',
    'files',
  ];

  it('creates all tables', () => {
    createSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const table of expectedTables) {
      expect(tables).toContain(table);
    }
  });

  it('creates the FTS5 virtual table', () => {
    createSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates all indices', () => {
    createSchema(db);
    const indices = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((r: any) => r.name);
    const expectedIndices = [
      'idx_nodes_file',
      'idx_nodes_parent',
      'idx_node_types_schema',
      'idx_fields_key_value',
      'idx_fields_key_number',
      'idx_fields_key_date',
      'idx_rel_source',
      'idx_rel_target',
      'idx_rel_type',
    ];
    for (const idx of expectedIndices) {
      expect(indices).toContain(idx);
    }
  });

  it('is idempotent — running twice does not throw', () => {
    createSchema(db);
    expect(() => createSchema(db)).not.toThrow();
  });

  it('creates FTS5 triggers for content sync', () => {
    createSchema(db);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((r: any) => r.name);
    expect(triggers).toContain('nodes_fts_insert');
    expect(triggers).toContain('nodes_fts_delete');
    expect(triggers).toContain('nodes_fts_update');
  });

  it('FTS5 indexes content inserted into nodes', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'hello world search test', '# Hello')`
    ).run();

    const results = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'search'")
      .all();
    expect(results).toHaveLength(1);
  });

  it('FTS5 reflects deletions from nodes', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'unique findme text', '# Test')`
    ).run();

    db.prepare("DELETE FROM nodes WHERE id = 'n1'").run();

    const results = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'findme'")
      .all();
    expect(results).toHaveLength(0);
  });

  it('FTS5 reflects updates to nodes', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'original text', '# Test')`
    ).run();

    db.prepare(
      "UPDATE nodes SET content_text = 'updated replacement' WHERE id = 'n1'"
    ).run();

    const old = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'original'")
      .all();
    expect(old).toHaveLength(0);

    const updated = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'replacement'")
      .all();
    expect(updated).toHaveLength(1);
  });

  it('enforces foreign key on node_types', () => {
    createSchema(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO node_types (node_id, schema_type) VALUES ('nonexistent', 'task')"
        )
        .run()
    ).toThrow(/FOREIGN KEY/);
  });

  it('cascades deletes from nodes to node_types and fields', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'text', '# Test')`
    ).run();
    db.prepare(
      "INSERT INTO node_types (node_id, schema_type) VALUES ('n1', 'task')"
    ).run();
    db.prepare(
      "INSERT INTO fields (node_id, key, value_text, value_type) VALUES ('n1', 'status', 'todo', 'string')"
    ).run();

    db.prepare("DELETE FROM nodes WHERE id = 'n1'").run();

    const types = db
      .prepare("SELECT * FROM node_types WHERE node_id = 'n1'")
      .all();
    const fields = db
      .prepare("SELECT * FROM fields WHERE node_id = 'n1'")
      .all();
    expect(types).toHaveLength(0);
    expect(fields).toHaveLength(0);
  });
});
