// tests/serializer/path.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/index.js';
import { resolve } from 'path';
import { generateFilePath } from '../../src/serializer/path.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('generateFilePath', () => {
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

  it('resolves a simple title template', () => {
    const result = generateFilePath('Review proposal', ['task'], {}, db);
    expect(result).toBe('tasks/Review proposal.md');
  });

  it('resolves a date+title template', () => {
    const result = generateFilePath(
      'Q1 Planning',
      ['meeting'],
      { date: new Date('2025-03-06') },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Q1 Planning.md');
  });

  it('falls back to title.md when no schema exists', () => {
    const result = generateFilePath('Random note', ['unknown'], {}, db);
    expect(result).toBe('Random note.md');
  });

  it('falls back to title.md when schema has no filename_template', () => {
    const result = generateFilePath('Note', [], {}, db);
    expect(result).toBe('Note.md');
  });

  it('throws when a template variable is missing', () => {
    // meeting template requires {{date}} but we don't provide it
    expect(() => {
      generateFilePath('Q1 Planning', ['meeting'], {}, db);
    }).toThrow(/date/);
  });

  it('picks template from first schema alphabetically for multi-type', () => {
    // meeting (alphabetically before task) has template "meetings/{{date}}-{{title}}.md"
    const result = generateFilePath(
      'Sprint Review',
      ['task', 'meeting'],
      { date: new Date('2025-03-06') },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Sprint Review.md');
  });

  it('sanitizes unsafe filename characters', () => {
    const result = generateFilePath('What: Why? *How*', ['task'], {}, db);
    expect(result).toBe('tasks/What Why How.md');
    expect(result).not.toContain(':');
    expect(result).not.toContain('?');
    expect(result).not.toContain('*');
  });

  it('handles date fields passed as strings', () => {
    const result = generateFilePath(
      'Q1 Planning',
      ['meeting'],
      { date: '2025-03-06' },
      db,
    );
    expect(result).toBe('meetings/2025-03-06-Q1 Planning.md');
  });
});
