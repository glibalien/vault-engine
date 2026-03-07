import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { mergeSchemaFields } from '../../src/schema/merger.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('mergeSchemaFields', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty result for empty types array', () => {
    const result = mergeSchemaFields(db, []);
    expect(result.fields).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it('wraps single type fields as MergedFields', () => {
    const result = mergeSchemaFields(db, ['person']);
    expect(result.conflicts).toEqual([]);
    expect(result.fields.role).toEqual({
      type: 'string',
      sources: ['person'],
    });
    expect(result.fields.email).toEqual({
      type: 'string',
      sources: ['person'],
    });
    expect(result.fields.tags).toEqual({
      type: 'list<string>',
      sources: ['person'],
    });
  });

  it('preserves required and default on single type', () => {
    const result = mergeSchemaFields(db, ['task']);
    expect(result.fields.status.required).toBe(true);
    expect(result.fields.status.default).toBe('todo');
    expect(result.fields.status.values).toEqual(
      ['todo', 'in-progress', 'blocked', 'done', 'cancelled']
    );
    expect(result.fields.status.sources).toEqual(['task']);
  });
});
