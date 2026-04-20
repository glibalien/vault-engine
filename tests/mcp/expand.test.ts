import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { performExpansion, type ExpandOptions } from '../../src/mcp/expand.js';

let db: Database.Database;

function seedNode(id: string, filePath: string, title: string, body: string, mtime = 1000) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, mtime, 2000);
}

function seedRel(sourceId: string, target: string, relType: string, context: string | null = null) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
  ).run(sourceId, target, relType, context);
}

function seedType(nodeId: string, schemaType: string) {
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(nodeId, schemaType);
}

beforeEach(() => {
  db = createTestDb();
});

describe('performExpansion — skeleton', () => {
  it('returns empty result for a root with no relationships', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    const options: ExpandOptions = { types: ['note'], direction: 'outgoing', max_nodes: 10 };
    const result = performExpansion(db, 'root', options);
    expect(result.expanded).toEqual({});
    expect(result.stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});

describe('performExpansion — outgoing candidates', () => {
  it('collects outgoing targets that resolve to existing nodes', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedNode('b', 'notes/b.md', 'B', 'b body');
    seedType('a', 'note');
    seedType('b', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'B', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(2);
  });

  it('skips outgoing targets that do not resolve', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'Nonexistent', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1);
  });

  it('excludes self-reference', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedType('root', 'note');
    seedRel('root', 'Root', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(0);
  });

  it('dedupes targets reached via multiple rel_types', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'A', 'project');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1);
  });
});

// Note: these tests intentionally assert only on stats.considered at this stage.
// Task 7 adds tests that verify the populated `expanded` map for the same fixtures.
