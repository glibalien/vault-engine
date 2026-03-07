// tests/schema/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas, getSchema, getAllSchemas } from '../../src/schema/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('loadSchemas', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('parses a single schema YAML file', () => {
    loadSchemas(db, fixturesDir);

    const person = getSchema(db, 'person');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('person');
    expect(person!.display_name).toBe('Person');
    expect(person!.icon).toBe('user');
    expect(person!.extends).toBeUndefined();
    expect(person!.ancestors).toEqual([]);
    expect(person!.fields.role).toEqual({ type: 'string' });
    expect(person!.fields.email).toEqual({ type: 'string' });
    expect(person!.fields.tags).toEqual({ type: 'list<string>' });
    expect(person!.serialization?.filename_template).toBe('people/{{title}}.md');
  });
});
