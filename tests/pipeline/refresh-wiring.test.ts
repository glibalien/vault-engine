import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

let vault: string;
let db: Database.Database;
let lock: WriteLockManager;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'refresh-wire-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  lock = new WriteLockManager();
});
afterEach(() => {
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

function runMutation(mutation: Parameters<typeof executeMutation>[3]) {
  return executeMutation(db, lock, vault, mutation);
}

describe('executeMutation wires refresh helpers', () => {
  it('creating a node resolves pre-existing unresolved edges pointing at it', () => {
    // Seed an existing node with an unresolved edge.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src1', 'Writer.md', 'Writer', 'Body mentions [[Acme Corp]]', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('src1', 'Acme Corp', 'wiki-link');

    // Create the target via mutation.
    const result = runMutation({
      source: 'tool',
      node_id: null,
      file_path: 'Acme Corp.md',
      title: 'Acme Corp',
      types: [],
      fields: {},
      body: '# Acme Corp\n',
    });
    expect(result.node_id).toBeTruthy();

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
    ).get('src1', 'Acme Corp') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).not.toBeNull();
  });

  it('renaming a node re-resolves edges bound to its old identity', () => {
    // Setup: A (Foo.md, title Foo), src1 links "Foo" → resolved=A.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('A', 'Foo.md', 'Foo', '# Foo\n', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src1', 'Writer.md', 'Writer', 'Body', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');

    // Rename A: file_path and title change.
    runMutation({
      source: 'tool',
      node_id: 'A',
      file_path: 'Bar.md',
      title: 'Bar',
      types: [],
      fields: {},
      body: '# Bar\n',
    });

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
    ).get('src1', 'Foo') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).toBeNull(); // "Foo" no longer matches A's new identity
  });
});
