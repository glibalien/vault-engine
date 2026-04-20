import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { performExpansion, type ExpandOptions } from '../../src/mcp/expand.js';
import { resolveTarget } from '../../src/resolver/resolve.js';

let db: Database.Database;

function seedNode(id: string, filePath: string, title: string, body: string, mtime = 1000) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, mtime, 2000);
}

function seedRel(sourceId: string, target: string, relType: string, context: string | null = null) {
  const resolved = resolveTarget(db, target);
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
  ).run(sourceId, target, relType, context, resolved?.id ?? null);
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

describe('performExpansion — direction', () => {
  it('direction=incoming collects sources that link to the root', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('x', 'notes/x.md', 'X', 'x body');
    seedNode('y', 'notes/y.md', 'Y', 'y body');
    seedType('x', 'note');
    seedType('y', 'note');
    seedRel('x', 'Root', 'wiki-link');
    seedRel('y', 'root', 'wiki-link'); // basename of notes/root.md

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'incoming', max_nodes: 10 });
    expect(result.stats.considered).toBe(2);
  });

  it('direction=both unions and dedupes', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedNode('b', 'notes/b.md', 'B', 'b body');
    seedType('a', 'note');
    seedType('b', 'note');
    seedRel('root', 'A', 'wiki-link'); // outgoing
    seedRel('b', 'Root', 'wiki-link'); // incoming
    seedRel('a', 'Root', 'wiki-link'); // also incoming — dedupe with outgoing 'a'

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'both', max_nodes: 10 });
    expect(result.stats.considered).toBe(2); // a and b — not 3
  });
});

// Note: these tests intentionally assert only on stats.considered at this stage.
// Task 7 adds tests that verify the populated `expanded` map for the same fixtures.

describe('performExpansion — type filter', () => {
  it('drops candidates without a matching type', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('p', 'notes/p.md', 'P', 'person body');
    seedNode('m', 'notes/m.md', 'M', 'M body');
    seedType('p', 'person');
    seedType('m', 'meeting');
    seedRel('root', 'P', 'wiki-link');
    seedRel('root', 'M', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['meeting'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1); // p filtered out pre-sort
  });

  it('keeps candidates whose types intersect the filter', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('mt', 'notes/mt.md', 'MT', 'multi-typed body');
    seedType('mt', 'person');
    seedType('mt', 'meeting');
    seedRel('root', 'MT', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['meeting'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1);
  });

  it('returns empty when no candidate matches any requested type', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('p', 'notes/p.md', 'P', 'person body');
    seedType('p', 'person');
    seedRel('root', 'P', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['meeting'], direction: 'outgoing', max_nodes: 10 });
    expect(result.expanded).toEqual({});
    expect(result.stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});

describe('performExpansion — ranking and truncation', () => {
  it('sorts candidates by file_mtime DESC', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('old', 'notes/old.md', 'Old', 'old body', 500);
    seedNode('new', 'notes/new.md', 'New', 'new body', 2000);
    seedNode('mid', 'notes/mid.md', 'Mid', 'mid body', 1000);
    seedType('old', 'note');
    seedType('new', 'note');
    seedType('mid', 'note');
    seedRel('root', 'Old', 'wiki-link');
    seedRel('root', 'New', 'wiki-link');
    seedRel('root', 'Mid', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 2 });
    // Top 2 by mtime desc: new (2000), mid (1000)
    const ids = Object.keys(result.expanded);
    expect(ids.sort()).toEqual(['mid', 'new']);
    expect(result.stats).toEqual({ returned: 2, considered: 3, truncated: true });
  });

  it('sorts null file_mtime last', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('hasmtime', 'notes/h.md', 'H', 'h body', 1000);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('nullmtime', 'notes/nm.md', 'NM', 'nm body', 'hash-nm', null, 2000);
    seedType('hasmtime', 'note');
    seedType('nullmtime', 'note');
    seedRel('root', 'H', 'wiki-link');
    seedRel('root', 'NM', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 1 });
    expect(Object.keys(result.expanded)).toEqual(['hasmtime']);
    expect(result.stats).toEqual({ returned: 1, considered: 2, truncated: true });
  });

  it('breaks mtime ties by id ASC deterministically', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('zzz', 'notes/zzz.md', 'Zzz', 'z body', 1000);
    seedNode('aaa', 'notes/aaa.md', 'Aaa', 'a body', 1000);
    seedType('zzz', 'note');
    seedType('aaa', 'note');
    seedRel('root', 'Zzz', 'wiki-link');
    seedRel('root', 'Aaa', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 1 });
    expect(Object.keys(result.expanded)).toEqual(['aaa']);
  });

  it('truncated=false when candidates fit under max_nodes', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats).toEqual({ returned: 1, considered: 1, truncated: false });
  });
});

describe('performExpansion — payload shape', () => {
  it('returns full {id, title, types, fields, body} per expanded node', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedType('a', 'note');
    seedType('a', 'meeting');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a', 'status', 'open', null, null, null, 'frontmatter');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a', 'date', null, null, '2026-04-20', null, 'frontmatter');
    seedRel('root', 'A', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    const entry = result.expanded['a'];
    expect(entry).toBeDefined();
    expect(entry.id).toBe('a');
    expect(entry.title).toBe('A');
    expect(entry.body).toBe('a body');
    // Types returned in insertion order (rowid)
    expect(entry.types).toEqual(['note', 'meeting']);
    expect(entry.fields.status).toEqual({ value: 'open', type: 'text', source: 'frontmatter' });
    expect(entry.fields.date).toEqual({ value: '2026-04-20', type: 'date', source: 'frontmatter' });
  });

  it('expanded entries have empty fields map when node has none', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.expanded['a'].fields).toEqual({});
  });

  it('Task 3 fixtures now populate expanded map', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedNode('b', 'notes/b.md', 'B', 'b body', 1500);
    seedType('a', 'note');
    seedType('b', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'B', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(Object.keys(result.expanded).sort()).toEqual(['a', 'b']);
    expect(result.stats.returned).toBe(2);
  });
});
