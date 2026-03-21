import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadVecExtension, createVecTable, getVecDimensions, dropVecTable } from '../../src/embeddings/vec.js';

describe('sqlite-vec setup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
  });

  afterEach(() => {
    db.close();
  });

  it('loads sqlite-vec extension without error', () => {
    const result = db.prepare("SELECT vec_version()").get() as any;
    expect(result).toBeDefined();
  });

  it('creates vec_chunks virtual table with specified dimensions', () => {
    createVecTable(db, 768);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).get();
    expect(row).toBeDefined();
  });

  it('getVecDimensions returns null when vec_chunks does not exist', () => {
    expect(getVecDimensions(db)).toBeNull();
  });

  it('getVecDimensions returns dimensions when vec_chunks exists', () => {
    createVecTable(db, 768);
    expect(getVecDimensions(db)).toBe(768);
  });

  it('dropVecTable removes the table', () => {
    createVecTable(db, 768);
    dropVecTable(db);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).get();
    expect(row).toBeUndefined();
  });

  it('can insert and query vectors', () => {
    createVecTable(db, 3);
    const vec1 = Buffer.from(new Float32Array([1.0, 0.0, 0.0]).buffer);
    const vec2 = Buffer.from(new Float32Array([0.0, 1.0, 0.0]).buffer);

    db.prepare(
      'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)'
    ).run('test#full', vec1);
    db.prepare(
      'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)'
    ).run('test2#full', vec2);

    const queryVec = Buffer.from(new Float32Array([1.0, 0.0, 0.0]).buffer);
    const rows = db.prepare(
      'SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 2'
    ).all(queryVec) as any[];

    expect(rows).toHaveLength(2);
    expect(rows[0].chunk_id).toBe('test#full');
    expect(rows[0].distance).toBeCloseTo(0, 5);
  });
});
