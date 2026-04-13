import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToPhase4 } from '../../src/db/migrate.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  return db;
}

describe('Phase 4 schema: embedding_meta', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    createSchema(db);
  });

  it('embedding_meta table exists with correct columns', () => {
    const cols = (
      db.prepare('PRAGMA table_info(embedding_meta)').all() as { name: string }[]
    ).map(c => c.name);

    expect(cols).toContain('id');
    expect(cols).toContain('node_id');
    expect(cols).toContain('source_type');
    expect(cols).toContain('source_hash');
    expect(cols).toContain('chunk_index');
    expect(cols).toContain('extraction_ref');
    expect(cols).toContain('embedded_at');
  });

  it('embeddings table no longer exists', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
      .get();
    expect(row).toBeUndefined();
  });

  it('embedding_vec virtual table exists', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_vec'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('embedding_vec');
  });

  it('unique constraint on (node_id, source_type, extraction_ref, chunk_index)', () => {
    db.prepare(
      "INSERT INTO nodes (id, file_path) VALUES ('n1', '/a.md')"
    ).run();

    // Use non-NULL extraction_ref: SQLite treats NULL as distinct from all values
    // (two NULLs are never equal), so the constraint only fires on non-NULL values.
    db.prepare(`
      INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
      VALUES ('n1', 'body', 'abc', 0, 'ref-1', '2026-01-01T00:00:00Z')
    `).run();

    expect(() => {
      db.prepare(`
        INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
        VALUES ('n1', 'body', 'xyz', 0, 'ref-1', '2026-01-02T00:00:00Z')
      `).run();
    }).toThrow();
  });

  it('chunk_index defaults to 0', () => {
    db.prepare(
      "INSERT INTO nodes (id, file_path) VALUES ('n2', '/b.md')"
    ).run();

    db.prepare(`
      INSERT INTO embedding_meta (node_id, source_type, source_hash, embedded_at)
      VALUES ('n2', 'title', 'def', '2026-01-01T00:00:00Z')
    `).run();

    const row = db
      .prepare("SELECT chunk_index FROM embedding_meta WHERE node_id='n2'")
      .get() as { chunk_index: number };
    expect(row.chunk_index).toBe(0);
  });
});

describe('upgradeToPhase4', () => {
  it('creates embedding_meta and embedding_vec on a fresh db (no embeddings table)', () => {
    const db = makeDb();
    createSchema(db);
    upgradeToPhase4(db);

    const cols = (
      db.prepare('PRAGMA table_info(embedding_meta)').all() as { name: string }[]
    ).map(c => c.name);
    expect(cols).toContain('node_id');

    const vecRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_vec'")
      .get();
    expect(vecRow).toBeDefined();
  });

  it('is idempotent — safe to run multiple times', () => {
    const db = makeDb();
    createSchema(db);

    expect(() => {
      upgradeToPhase4(db);
      upgradeToPhase4(db);
      upgradeToPhase4(db);
    }).not.toThrow();
  });

  it('drops old embeddings table if it exists', () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        file_path TEXT UNIQUE NOT NULL,
        title TEXT,
        body TEXT,
        content_hash TEXT,
        file_mtime INTEGER,
        indexed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        content_text TEXT,
        embedded_at INTEGER
      );
    `);

    upgradeToPhase4(db);

    const oldRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
      .get();
    expect(oldRow).toBeUndefined();

    const cols = (
      db.prepare('PRAGMA table_info(embedding_meta)').all() as { name: string }[]
    ).map(c => c.name);
    expect(cols).toContain('node_id');
  });
});
