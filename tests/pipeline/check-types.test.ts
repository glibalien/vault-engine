import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { checkTypesHaveSchemas } from '../../src/pipeline/check-types.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
});

describe('checkTypesHaveSchemas', () => {
  it('returns valid for empty types array', () => {
    const result = checkTypesHaveSchemas(db, []);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when all types have schemas', () => {
    const result = checkTypesHaveSchemas(db, ['note', 'task']);
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid with unknown types listed', () => {
    const result = checkTypesHaveSchemas(db, ['reference']);
    expect(result).toEqual({
      valid: false,
      unknown: ['reference'],
      available: ['note', 'task'],
    });
  });

  it('returns only unknown types in mixed array', () => {
    const result = checkTypesHaveSchemas(db, ['note', 'reference', 'spec']);
    expect(result).toEqual({
      valid: false,
      unknown: ['reference', 'spec'],
      available: ['note', 'task'],
    });
  });

  it('returns sorted available schemas', () => {
    createSchemaDefinition(db, { name: 'apple', field_claims: [] });
    const result = checkTypesHaveSchemas(db, ['zzz']);
    expect((result as any).available).toEqual(['apple', 'note', 'task']);
  });
});
