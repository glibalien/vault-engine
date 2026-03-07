import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('schema changes for reference resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('nodes table has a title column', () => {
    const cols = db.prepare("PRAGMA table_info('nodes')").all() as any[];
    const titleCol = cols.find((c: any) => c.name === 'title');
    expect(titleCol).toBeDefined();
    expect(titleCol.type).toBe('TEXT');
  });

  it('relationships table has a resolved_target_id column', () => {
    const cols = db.prepare("PRAGMA table_info('relationships')").all() as any[];
    const resolvedCol = cols.find((c: any) => c.name === 'resolved_target_id');
    expect(resolvedCol).toBeDefined();
    expect(resolvedCol.type).toBe('TEXT');
  });
});

describe('title population in indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('uses frontmatter title when present', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('tasks/review.md') as any;
    expect(node.title).toBe('Review vendor proposals');
  });

  it('derives title from filename stem when no frontmatter title', () => {
    const raw = '# Just a note\n\nSome content.';
    const parsed = parseFile('notes/My Great Note.md', raw);
    indexFile(db, parsed, 'notes/My Great Note.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('notes/My Great Note.md') as any;
    expect(node.title).toBe('My Great Note');
  });

  it('derives title from nested path filename stem', () => {
    const raw = 'Plain content.';
    const parsed = parseFile('deep/nested/path/Cool File.md', raw);
    indexFile(db, parsed, 'deep/nested/path/Cool File.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get('deep/nested/path/Cool File.md') as any;
    expect(node.title).toBe('Cool File');
  });
});
