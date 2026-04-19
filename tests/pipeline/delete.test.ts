import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeDeletion } from '../../src/pipeline/delete.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

function seedNode(db: Database.Database, id: string, filePath: string, title: string): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, filePath, title, '', 'hash', now, now, now);
  const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(rowInfo.rowid, title, '');
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, 'note');
  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)',
  ).run(id, 'status', 'open', 'frontmatter');
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Other', 'wiki-link', null, null);
}

describe('executeDeletion', () => {
  let vaultPath: string;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    db = openDb();
    writeLock = new WriteLockManager();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('removes node, FTS, cascaded children, and writes one file-deleted edits_log row', () => {
    seedNode(db, 'n1', 'a.md', 'A');

    const result = executeDeletion(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n1',
      file_path: 'a.md',
      unlink_file: false,
    });

    expect(result.node_id).toBe('n1');
    expect(result.file_path).toBe('a.md');
    expect(result.file_unlinked).toBe(false);

    expect(db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE id = ?').get('n1')).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM node_types WHERE node_id = ?').get('n1')).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM node_fields WHERE node_id = ?').get('n1')).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM relationships WHERE source_id = ?').get('n1')).toEqual({ c: 0 });

    const logs = db.prepare(
      "SELECT details FROM edits_log WHERE event_type = 'file-deleted' AND node_id = ?",
    ).all('n1') as { details: string }[];
    expect(logs).toHaveLength(1);
    const details = JSON.parse(logs[0].details);
    expect(details).toEqual({ file_path: 'a.md', source: 'tool' });
  });

  it('includes reason in edits_log details when supplied', () => {
    seedNode(db, 'n1', 'a.md', 'A');

    executeDeletion(db, writeLock, vaultPath, {
      source: 'reconciler',
      node_id: 'n1',
      file_path: 'a.md',
      unlink_file: false,
      reason: 'file missing during sweep',
    });

    const row = db.prepare(
      "SELECT details FROM edits_log WHERE event_type = 'file-deleted' AND node_id = ?",
    ).get('n1') as { details: string };
    const details = JSON.parse(row.details);
    expect(details).toEqual({
      file_path: 'a.md',
      source: 'reconciler',
      reason: 'file missing during sweep',
    });
  });

  it('unlinks the file when unlink_file is true and file is present', () => {
    seedNode(db, 'n1', 'a.md', 'A');
    const abs = join(vaultPath, 'a.md');
    writeFileSync(abs, '# A\n', 'utf-8');
    expect(existsSync(abs)).toBe(true);

    const result = executeDeletion(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n1',
      file_path: 'a.md',
      unlink_file: true,
    });

    expect(result.file_unlinked).toBe(true);
    expect(existsSync(abs)).toBe(false);
  });

  it('returns file_unlinked=true for ENOENT (file already gone)', () => {
    seedNode(db, 'n1', 'a.md', 'A');
    // File intentionally NOT created on disk.

    const result = executeDeletion(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n1',
      file_path: 'a.md',
      unlink_file: true,
    });

    expect(result.file_unlinked).toBe(true);
  });

  it('does not touch the filesystem when unlink_file is false', () => {
    seedNode(db, 'n1', 'a.md', 'A');
    const abs = join(vaultPath, 'a.md');
    writeFileSync(abs, '# A\n', 'utf-8');

    const result = executeDeletion(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: 'n1',
      file_path: 'a.md',
      unlink_file: false,
    });

    expect(result.file_unlinked).toBe(false);
    expect(existsSync(abs)).toBe(true);
  });

  it('is a no-op safe call when the node does not exist', () => {
    const result = executeDeletion(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'does-not-exist',
      file_path: 'missing.md',
      unlink_file: false,
    });

    expect(result.node_id).toBe('does-not-exist');
    // No edits_log entry should be created for a no-op
    const logs = db.prepare(
      "SELECT COUNT(*) AS c FROM edits_log WHERE event_type = 'file-deleted'",
    ).get() as { c: number };
    expect(logs.c).toBe(0);
  });
});
