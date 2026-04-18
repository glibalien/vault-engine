import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { refreshOnCreate, refreshOnRename } from '../../src/resolver/refresh.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

function insertNode(id: string, file_path: string, title: string | null) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, file_path, title, null, null, null, null);
}
function insertRel(source_id: string, target: string, rel_type = 'wiki-link') {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, NULL)'
  ).run(source_id, target, rel_type, null);
}
function resolvedFor(source_id: string, target: string): string | null {
  const row = db.prepare(
    'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
  ).get(source_id, target) as { resolved_target_id: string | null } | undefined;
  return row?.resolved_target_id ?? null;
}

describe('refreshOnCreate', () => {
  it('resolves unresolved edges pointing at the new node by file_path', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Projects/Acme.md');
    insertNode('new1', 'Projects/Acme.md', 'Acme');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Projects/Acme.md')).toBe('new1');
  });

  it('resolves by exact title', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Acme Corp');
    insertNode('new1', 'deeply/nested/Acme Corp.md', 'Acme Corp');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Acme Corp')).toBe('new1');
  });

  it('resolves by basename', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Acme');
    insertNode('new1', 'dir/Acme.md', null);
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Acme')).toBe('new1');
  });

  it('resolves by case-folded basename', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'acme');
    insertNode('new1', 'dir/Acme.md', null);
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'acme')).toBe('new1');
  });

  it('leaves already-resolved edges alone', () => {
    insertNode('existing', 'dir/Thing.md', 'Thing');
    insertNode('src1', 'writer.md', 'Writer');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Thing', 'wiki-link', 'existing');
    insertNode('new1', 'another/Thing.md', 'Thing');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Thing')).toBe('existing'); // not superseded (documented v1 limitation)
  });

  it('does not touch edges whose target does not match any key', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'UnrelatedName');
    insertNode('new1', 'dir/Acme.md', 'Acme');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'UnrelatedName')).toBeNull();
  });
});

describe('refreshOnRename', () => {
  it('nulls edges pointing at the old resolution and re-resolves via resolveTarget', () => {
    // Start state: nodeA at Foo.md/title Foo. src1 links to "Foo" via wiki-link.
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('src1', 'writer.md', 'Writer');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');

    // Rename A: Foo.md -> Bar.md, title Foo -> Bar.
    db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run('Bar.md', 'Bar', 'A');
    refreshOnRename(db, 'A');

    // The "Foo" edge no longer matches A's new keys; it becomes NULL (no other node matches).
    expect(resolvedFor('src1', 'Foo')).toBeNull();
  });

  it('edges using the new name get resolved after rename', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('src1', 'writer.md', 'Writer');
    // Pre-rename: src1 links to "Bar" — unresolved.
    insertRel('src1', 'Bar');

    db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run('Bar.md', 'Bar', 'A');
    refreshOnRename(db, 'A');

    expect(resolvedFor('src1', 'Bar')).toBe('A');
  });

  it('other unique targets in the NULL set re-resolve to a different node if possible', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('B', 'Baz.md', 'Baz');
    insertNode('src1', 'writer.md', 'Writer');
    // Pre-rename: src1 links to "Foo" (resolved=A) and "Baz" (resolved=A erroneously, as a stand-in).
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Baz', 'wiki-link', 'A');

    db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run('Qux.md', 'Qux', 'A');
    refreshOnRename(db, 'A');

    // "Baz" should re-resolve to B via resolveTarget.
    expect(resolvedFor('src1', 'Baz')).toBe('B');
    // "Foo" has no matching node; stays NULL.
    expect(resolvedFor('src1', 'Foo')).toBeNull();
  });
});
