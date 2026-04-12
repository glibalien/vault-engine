import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startWatcher } from '../../src/sync/watcher.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { WriteGate } from '../../src/sync/write-gate.js';
import type { FSWatcher } from 'chokidar';

let db: Database.Database;
let vaultPath: string;
let watcher: FSWatcher;
let mutex: IndexMutex;

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-e2e-'));
  mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
  db = new Database(join(vaultPath, '.vault-engine', 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  writeFileSync(join(vaultPath, 'meeting.md'), `---
title: Team Standup
types:
  - meeting
  - note
project: "[[Vault Engine]]"
attendees:
  - "[[Alice]]"
---

Discussed Phase 1 with [[Bob]].
`);

  writeFileSync(join(vaultPath, 'project.md'), `---
title: Vault Engine
types:
  - project
status: active
---

The vault engine project.
`);

  fullIndex(vaultPath, db);

  mutex = new IndexMutex();
  watcher = startWatcher(vaultPath, db, mutex, new WriteLockManager(), new WriteGate({ quietPeriodMs: 50 }), {
    debounceMs: 50, maxWaitMs: 200,
  });
  await new Promise(r => setTimeout(r, 100));
});

afterEach(async () => {
  await watcher.close();
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('end-to-end', () => {
  it('indexes vault, stores correct data, detects new files', async () => {
    // Verify initial index
    expect((db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c).toBe(2);

    // Verify types
    const types = db.prepare('SELECT DISTINCT schema_type FROM node_types ORDER BY schema_type')
      .all() as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'note', 'project']);

    // Verify relationships
    const rels = db.prepare('SELECT target, rel_type FROM relationships ORDER BY target')
      .all() as { target: string; rel_type: string }[];
    expect(rels.some(r => r.target === 'Vault Engine')).toBe(true);
    expect(rels.some(r => r.target === 'Alice')).toBe(true);
    expect(rels.some(r => r.target === 'Bob' && r.rel_type === 'wiki-link')).toBe(true);

    // Verify typed field storage
    const statusField = db.prepare(
      "SELECT value_text FROM node_fields nf JOIN nodes n ON n.id = nf.node_id WHERE n.title = 'Vault Engine' AND nf.field_name = 'status'"
    ).get() as { value_text: string };
    expect(statusField.value_text).toBe('active');

    // Add a new file, verify watcher picks it up
    writeFileSync(join(vaultPath, 'new-note.md'), `---
title: New Discovery
types:
  - note
project: "[[Vault Engine]]"
---

Found something about [[SQLite FTS5]].
`);

    await new Promise(r => setTimeout(r, 150));
    await mutex.onIdle();

    expect((db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c).toBe(3);

    const newNode = db.prepare("SELECT id FROM nodes WHERE title = 'New Discovery'").get() as { id: string };
    expect(newNode).toBeDefined();

    const newRels = db.prepare('SELECT target FROM relationships WHERE source_id = ?')
      .all(newNode.id) as { target: string }[];
    expect(newRels.some(r => r.target === 'Vault Engine')).toBe(true);
    expect(newRels.some(r => r.target === 'SQLite FTS5')).toBe(true);
  });
});
