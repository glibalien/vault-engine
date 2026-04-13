import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToPhase2, upgradeToPhase3, upgradeToPhase6 } from '../../src/db/migrate.js';
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

  it('node_fields has value_raw_text column', () => {
    const db = createTestDb();
    const columns = db.prepare('PRAGMA table_info(node_fields)').all() as { name: string }[];
    const names = columns.map(c => c.name);
    expect(names).toContain('value_raw_text');
  });

  it('creates schema_file_hashes table', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_file_hashes'"
    ).all();
    expect(tables).toHaveLength(1);

    const columns = db.prepare('PRAGMA table_info(schema_file_hashes)').all() as { name: string }[];
    const names = columns.map(c => c.name);
    expect(names).toContain('file_path');
    expect(names).toContain('content_hash');
    expect(names).toContain('rendered_at');
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

describe('upgradeToPhase3', () => {
  it('runs without error on a fresh Phase 3 DB', () => {
    const db = createTestDb();
    expect(() => upgradeToPhase3(db)).not.toThrow();
  });

  it('is idempotent — running twice does not error', () => {
    const db = createTestDb();
    upgradeToPhase3(db);
    expect(() => upgradeToPhase3(db)).not.toThrow();
  });

  it('upgrades a Phase 2 DB (missing value_raw_text and schema_file_hashes) to Phase 3', () => {
    // Simulate Phase 2: node_fields without value_raw_text, no schema_file_hashes
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // db.exec is the better-sqlite3 method for running multi-statement SQL,
    // not child_process.exec — this is safe, no shell involved.
    const runSql = db.exec.bind(db);
    runSql(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        file_path TEXT UNIQUE NOT NULL,
        title TEXT,
        body TEXT,
        content_hash TEXT,
        file_mtime INTEGER,
        indexed_at INTEGER
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

    // Insert a row before migration to verify existing data is preserved
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)").run('n1', 'test.md', 'Test');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)").run('n1', 'project', 'VE', 'frontmatter');

    upgradeToPhase3(db);

    // value_raw_text column exists and defaults to NULL
    const columns = db.prepare('PRAGMA table_info(node_fields)').all() as { name: string }[];
    expect(columns.map(c => c.name)).toContain('value_raw_text');

    const row = db.prepare("SELECT value_raw_text FROM node_fields WHERE node_id = 'n1'").get() as { value_raw_text: string | null };
    expect(row.value_raw_text).toBeNull();

    // schema_file_hashes table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_file_hashes'"
    ).all();
    expect(tables).toHaveLength(1);
  });
});

describe('upgradeToPhase6', () => {
  it('runs without error on a fresh Phase 6 DB', () => {
    const db = createTestDb();
    expect(() => upgradeToPhase6(db)).not.toThrow();
  });

  it('is idempotent — running twice does not error', () => {
    const db = createTestDb();
    upgradeToPhase6(db);
    expect(() => upgradeToPhase6(db)).not.toThrow();
  });

  it('creates extraction_cache table on a DB that does not have it', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    upgradeToPhase6(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
    ).all();
    expect(tables).toHaveLength(1);
  });
});

describe('createSchema — sync_log', () => {
  it('creates sync_log table with expected columns', () => {
    const db = createTestDb();
    const info = db.prepare("PRAGMA table_info('sync_log')").all() as Array<{ name: string }>;
    const cols = info.map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('timestamp');
    expect(cols).toContain('file_path');
    expect(cols).toContain('event');
    expect(cols).toContain('source');
    expect(cols).toContain('details');
  });

  it('has indexes on sync_log file_path and timestamp', () => {
    const db = createTestDb();
    const indexes = db.prepare("PRAGMA index_list('sync_log')").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_sync_log_file_path');
    expect(names).toContain('idx_sync_log_timestamp');
  });
});

describe('createSchema — extraction_cache', () => {
  it('creates extraction_cache table', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('extraction_cache has all expected columns', () => {
    const db = createTestDb();
    const columns = db.prepare('PRAGMA table_info(extraction_cache)').all() as { name: string }[];
    const names = columns.map(c => c.name);
    expect(names).toContain('content_hash');
    expect(names).toContain('file_path');
    expect(names).toContain('media_type');
    expect(names).toContain('extractor_id');
    expect(names).toContain('extracted_text');
    expect(names).toContain('metadata_json');
    expect(names).toContain('extracted_at');
  });
});
