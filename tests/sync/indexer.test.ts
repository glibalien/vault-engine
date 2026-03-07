import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile, rebuildIndex, deleteFile, incrementalIndex } from '../../src/sync/indexer.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function loadAndParse(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    return { parsed: parseFile(relativePath, raw), raw };
  }

  it('inserts a node row with correct fields', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review-vendor-proposals.md');
    indexFile(db, parsed, 'tasks/review-vendor-proposals.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('tasks/review-vendor-proposals.md') as any;
    expect(node).toBeDefined();
    expect(node.file_path).toBe('tasks/review-vendor-proposals.md');
    expect(node.node_type).toBe('file');
    expect(node.content_text).toContain('Review the three vendor proposals');
    expect(node.content_md).toContain('[[Acme Corp Proposal]]');
    expect(node.depth).toBe(0);
    expect(node.parent_id).toBeNull();
  });

  it('inserts node_types for each type', () => {
    const { parsed, raw } = loadAndParse('sample-meeting.md', 'meetings/q1-planning.md');
    indexFile(db, parsed, 'meetings/q1-planning.md', '2025-03-06T00:00:00.000Z', raw);

    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type')
      .all('meetings/q1-planning.md') as any[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'task']);
  });

  it('inserts no node_types when types array is empty', () => {
    const raw = 'Just a plain note.';
    const parsed = parseFile('notes/plain.md', raw);
    indexFile(db, parsed, 'notes/plain.md', '2025-03-10T00:00:00.000Z', raw);

    const types = db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('notes/plain.md');
    expect(types).toHaveLength(0);
  });

  it('inserts fields with correct value mappings', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const fields = db.prepare('SELECT * FROM fields WHERE node_id = ? ORDER BY key')
      .all('tasks/review.md') as any[];
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));

    // string field
    expect(byKey.status.value_text).toBe('todo');
    expect(byKey.status.value_type).toBe('string');

    // reference field
    expect(byKey.assignee.value_type).toBe('reference');
    expect(byKey.assignee.value_text).toBe('[[Bob Jones]]');

    // number field — priority is 'high' (string), not a number
    expect(byKey.priority.value_type).toBe('string');
  });

  it('populates value_number for number fields', () => {
    const raw = '---\ntitle: Test\ncount: 42\n---\nBody.';
    const parsed = parseFile('test.md', raw);
    indexFile(db, parsed, 'test.md', '2025-03-10T00:00:00.000Z', raw);

    const field = db.prepare('SELECT * FROM fields WHERE node_id = ? AND key = ?')
      .get('test.md', 'count') as any;
    expect(field.value_type).toBe('number');
    expect(field.value_number).toBe(42);
    expect(field.value_text).toBe('42');
  });

  it('populates value_date for date fields', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const field = db.prepare('SELECT * FROM fields WHERE node_id = ? AND key = ?')
      .get('tasks/review.md', 'due_date') as any;
    expect(field.value_type).toBe('date');
    expect(field.value_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('serializes list fields as JSON', () => {
    const { parsed, raw } = loadAndParse('sample-person.md', 'people/alice.md');
    indexFile(db, parsed, 'people/alice.md', '2025-03-10T00:00:00.000Z', raw);

    const field = db.prepare('SELECT * FROM fields WHERE node_id = ? AND key = ?')
      .get('people/alice.md', 'tags') as any;
    expect(field.value_type).toBe('list');
    expect(JSON.parse(field.value_text)).toEqual(['engineering', 'leadership']);
  });

  it('inserts relationships for frontmatter wiki-links with field name as rel_type', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const rels = db.prepare('SELECT * FROM relationships WHERE source_id = ? ORDER BY target_id')
      .all('tasks/review.md') as any[];
    const assignee = rels.find(r => r.target_id === 'Bob Jones');
    expect(assignee).toBeDefined();
    expect(assignee.rel_type).toBe('assignee');

    const source = rels.find(r => r.target_id === 'Q1 Planning Meeting');
    expect(source).toBeDefined();
    expect(source.rel_type).toBe('source');
  });

  it('inserts relationships for body wiki-links with rel_type "wiki-link"', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const rels = db.prepare(
      "SELECT * FROM relationships WHERE source_id = ? AND rel_type = 'wiki-link'"
    ).all('tasks/review.md') as any[];
    const targets = rels.map(r => r.target_id);
    expect(targets).toContain('Acme Corp Proposal');
    expect(targets).toContain('Globex Proposal');
    expect(targets).toContain('Alice Smith');
  });

  it('inserts into the files table with mtime and hash', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const file = db.prepare('SELECT * FROM files WHERE path = ?').get('tasks/review.md') as any;
    expect(file).toBeDefined();
    expect(file.mtime).toBe('2025-03-10T00:00:00.000Z');
    expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is idempotent — re-indexing replaces old data cleanly', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-11T00:00:00.000Z', raw);

    const nodes = db.prepare('SELECT * FROM nodes WHERE id = ?').all('tasks/review.md');
    expect(nodes).toHaveLength(1);

    const types = db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('tasks/review.md');
    expect(types).toHaveLength(1); // task

    const file = db.prepare('SELECT * FROM files WHERE path = ?').get('tasks/review.md') as any;
    expect(file.mtime).toBe('2025-03-11T00:00:00.000Z');
  });
});

describe('deleteFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedFile(path: string, raw: string) {
    const parsed = parseFile(path, raw);
    indexFile(db, parsed, path, '2025-03-10T00:00:00.000Z', raw);
  }

  it('removes node, types, fields, relationships, and files rows', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    seedFile('tasks/review.md', raw);

    deleteFile(db, 'tasks/review.md');

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('tasks/review.md')).toBeUndefined();
    expect(db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('tasks/review.md')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM fields WHERE node_id = ?').all('tasks/review.md')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM relationships WHERE source_id = ?').all('tasks/review.md')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('tasks/review.md')).toBeUndefined();
  });

  it('does not affect other files', () => {
    const raw1 = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const raw2 = readFileSync(resolve(fixturesDir, 'sample-person.md'), 'utf-8');
    seedFile('tasks/review.md', raw1);
    seedFile('people/alice.md', raw2);

    deleteFile(db, 'tasks/review.md');

    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('people/alice.md')).toBeDefined();
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('people/alice.md')).toBeDefined();
  });

  it('is a no-op for nonexistent paths', () => {
    expect(() => deleteFile(db, 'nonexistent.md')).not.toThrow();
  });
});

describe('rebuildIndex', () => {
  let db: Database.Database;
  const vaultDir = resolve(import.meta.dirname, '../fixtures/vault');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('indexes all .md files in the vault directory', () => {
    const result = rebuildIndex(db, vaultDir);

    expect(result.filesIndexed).toBe(3);

    const nodes = db.prepare('SELECT id FROM nodes ORDER BY id').all() as any[];
    expect(nodes.map(n => n.id)).toEqual([
      'notes/plain-note.md',
      'people/alice-smith.md',
      'tasks/review-vendor-proposals.md',
    ]);
  });

  it('populates node_types from frontmatter', () => {
    rebuildIndex(db, vaultDir);

    const taskTypes = db.prepare(
      "SELECT schema_type FROM node_types WHERE node_id = 'tasks/review-vendor-proposals.md'"
    ).all() as any[];
    expect(taskTypes.map(t => t.schema_type)).toEqual(['task']);

    const personTypes = db.prepare(
      "SELECT schema_type FROM node_types WHERE node_id = 'people/alice-smith.md'"
    ).all() as any[];
    expect(personTypes.map(t => t.schema_type)).toEqual(['person']);
  });

  it('populates relationships across files', () => {
    rebuildIndex(db, vaultDir);

    const rels = db.prepare('SELECT source_id, target_id, rel_type FROM relationships ORDER BY source_id, target_id')
      .all() as any[];
    expect(rels.length).toBeGreaterThan(0);

    const assignee = rels.find(r => r.source_id === 'tasks/review-vendor-proposals.md' && r.target_id === 'Bob Jones');
    expect(assignee).toBeDefined();
    expect(assignee.rel_type).toBe('assignee');
  });

  it('populates the files table with mtime and hash', () => {
    rebuildIndex(db, vaultDir);

    const files = db.prepare('SELECT * FROM files ORDER BY path').all() as any[];
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(f.mtime).toBeTruthy();
      expect(f.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('clears old data on rebuild', () => {
    rebuildIndex(db, vaultDir);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('stale.md', 'stale.md', 'file', 'old', '# old')`
    ).run();

    rebuildIndex(db, vaultDir);

    const stale = db.prepare('SELECT * FROM nodes WHERE id = ?').get('stale.md');
    expect(stale).toBeUndefined();
  });

  it('FTS5 indexes content from rebuilt vault', () => {
    rebuildIndex(db, vaultDir);

    const results = db.prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'vendor'").all();
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('incrementalIndex', () => {
  let db: Database.Database;
  let tmpVault: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  function writeVaultFile(relPath: string, content: string) {
    const abs = join(tmpVault, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('indexes all files when DB is empty', () => {
    writeVaultFile('notes/hello.md', '# Hello\nWorld.');
    writeVaultFile('notes/bye.md', '# Bye\nSee you.');

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);

    const nodes = db.prepare('SELECT id FROM nodes ORDER BY id').all() as any[];
    expect(nodes.map(n => n.id)).toEqual(['notes/bye.md', 'notes/hello.md']);
  });

  it('populates files table with mtime and hash', () => {
    writeVaultFile('test.md', '# Test');

    incrementalIndex(db, tmpVault);

    const file = db.prepare('SELECT * FROM files WHERE path = ?').get('test.md') as any;
    expect(file).toBeDefined();
    expect(file.mtime).toBeTruthy();
    expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('skips files with matching mtime', () => {
    writeVaultFile('notes/hello.md', '# Hello');
    incrementalIndex(db, tmpVault);

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('updates mtime but skips re-index when content is unchanged', () => {
    writeVaultFile('notes/hello.md', '# Hello');
    incrementalIndex(db, tmpVault);

    // Touch the file (change mtime without changing content)
    const filePath = join(tmpVault, 'notes/hello.md');
    const future = new Date(Date.now() + 10000);
    utimesSync(filePath, future, future);

    const result = incrementalIndex(db, tmpVault);

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(1);

    // Mtime should be updated in DB
    const file = db.prepare('SELECT mtime FROM files WHERE path = ?').get('notes/hello.md') as any;
    expect(file.mtime).toBe(future.toISOString());
  });
});
