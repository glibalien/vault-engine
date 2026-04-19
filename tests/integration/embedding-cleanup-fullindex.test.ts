import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('fullIndex embedding cleanup', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('invokes onNodeDeleted callback for every bulk-deleted node', () => {
    // Seed: add two markdown files, index them, capture their node IDs.
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n---\n# A\n', 'utf-8');
    writeFileSync(join(vaultPath, 'b.md'), '---\ntypes:\n---\n# B\n', 'utf-8');
    fullIndex(vaultPath, db);
    const before = db.prepare('SELECT id, file_path FROM nodes').all() as Array<{ id: string; file_path: string }>;
    expect(before.length).toBe(2);
    const idByPath = new Map(before.map(r => [r.file_path, r.id]));

    // Delete a.md from disk, re-index — should trigger onNodeDeleted for A.
    rmSync(join(vaultPath, 'a.md'));
    const deletedIds: string[] = [];
    fullIndex(vaultPath, db, { onNodeDeleted: (nodeId) => deletedIds.push(nodeId) });

    expect(deletedIds).toEqual([idByPath.get('a.md')]);
    const after = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
    expect(after.length).toBe(1);
  });
});
