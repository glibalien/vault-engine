import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToPhase2 } from '../../src/db/migrate.js';
import { getNodeConformance } from '../../src/validation/conformance.js';

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

  it('creates schema_field_claims table', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_field_claims'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('global_fields has required, per_type_overrides_allowed, and list_item_type columns', () => {
    const db = createTestDb();
    const columns = db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[];
    const names = columns.map(c => c.name);
    expect(names).toContain('required');
    expect(names).toContain('per_type_overrides_allowed');
    expect(names).toContain('list_item_type');
  });

  it('cascades schema deletion to schema_field_claims', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO schemas (name) VALUES (?)").run('note');
    db.prepare("INSERT INTO global_fields (name, field_type) VALUES (?, ?)").run('project', 'text');
    db.prepare(
      "INSERT INTO schema_field_claims (schema_name, field) VALUES (?, ?)"
    ).run('note', 'project');

    db.prepare("DELETE FROM schemas WHERE name = ?").run('note');

    const claims = db.prepare(
      "SELECT * FROM schema_field_claims WHERE schema_name = ?"
    ).all('note');
    expect(claims).toHaveLength(0);
  });

  it('schema_field_claims has idx_sfc_field index', () => {
    const db = createTestDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sfc_field'"
    ).all();
    expect(indexes).toHaveLength(1);
  });
});

describe('upgradeToPhase2', () => {
  it('runs without error on a fresh Phase 2 DB', () => {
    const db = createTestDb();
    expect(() => upgradeToPhase2(db)).not.toThrow();
  });

  it('is idempotent — running twice does not error', () => {
    const db = createTestDb();
    upgradeToPhase2(db);
    expect(() => upgradeToPhase2(db)).not.toThrow();
  });

  it('upgrades a Phase 1 DB (missing new columns) to Phase 2', () => {
    // Simulate Phase 1: create schema without the new columns/table
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Build a minimal Phase 1 schema (no new columns, no schema_field_claims)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS global_fields (
        name TEXT PRIMARY KEY,
        field_type TEXT NOT NULL,
        enum_values TEXT,
        reference_target TEXT,
        description TEXT,
        default_value TEXT
      )
    `).run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS schemas (
        name TEXT PRIMARY KEY,
        display_name TEXT,
        icon TEXT,
        filename_template TEXT,
        field_claims TEXT NOT NULL DEFAULT '[]',
        metadata TEXT
      )
    `).run();

    upgradeToPhase2(db);

    const columns = db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[];
    const names = columns.map(c => c.name);
    expect(names).toContain('required');
    expect(names).toContain('per_type_overrides_allowed');
    expect(names).toContain('list_item_type');

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_field_claims'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('get-node conformance works on a Phase 1 DB upgraded to Phase 2', () => {
    // Reproduce the real failure: Phase 1 DB upgraded in-place, then
    // get-node calls getNodeConformance which queries global_fields.required.
    // This failed in production because upgradeToPhase2 was never called.
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Phase 1 schema (no Phase 2 columns, no schema_field_claims)
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        file_path TEXT UNIQUE NOT NULL,
        title TEXT,
        body TEXT,
        content_hash TEXT,
        file_mtime INTEGER,
        indexed_at INTEGER
      );
      CREATE TABLE node_types (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        schema_type TEXT NOT NULL,
        PRIMARY KEY (node_id, schema_type)
      );
      CREATE TABLE global_fields (
        name TEXT PRIMARY KEY,
        field_type TEXT NOT NULL,
        enum_values TEXT,
        reference_target TEXT,
        description TEXT,
        default_value TEXT
      );
      CREATE TABLE schemas (
        name TEXT PRIMARY KEY,
        display_name TEXT,
        icon TEXT,
        filename_template TEXT,
        field_claims TEXT NOT NULL DEFAULT '[]',
        metadata TEXT
      );
      CREATE TABLE node_fields (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_date TEXT,
        value_json TEXT,
        source TEXT NOT NULL DEFAULT 'frontmatter',
        PRIMARY KEY (node_id, field_name)
      );
    `);

    // Insert a node with a type and a field (like the real vault has)
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run('n1', 'test.md', 'Test', '', 'h', 1000, 2000);
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)").run('n1', 'note');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)").run('n1', 'project', 'Vault Engine', 'frontmatter');

    // Simulate startup: createSchema (IF NOT EXISTS = no-op for existing tables) then upgrade
    createSchema(db);
    upgradeToPhase2(db);

    // This is the call that failed in production before the fix
    const result = getNodeConformance(db, 'n1', ['note']);
    expect(result.types_without_schemas).toContain('note');
    expect(result.orphan_fields).toContain('project');
    expect(result.claimed_fields).toHaveLength(0);
  });
});
