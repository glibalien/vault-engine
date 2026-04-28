import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { startWatcher } from '../../src/sync/watcher.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('watcher — field-defaulted emission', () => {
  let vaultPath: string;
  let dbPath: string;
  let db: Database.Database;
  let mutex: IndexMutex;
  let writeLock: WriteLockManager;
  let watcher: FSWatcher;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-watcher-defaults-test-'));
    dbPath = join(vaultPath, '.vault-engine', 'test.db');
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    // Set up a schema with a required-with-default field
    createGlobalField(db, {
      name: 'status',
      field_type: 'string',
      required: true,
      default_value: 'draft',
    });
    createSchemaDefinition(db, {
      name: 'Doc',
      field_claims: [{ field: 'status' }],
    });

    fullIndex(vaultPath, db);

    mutex = new IndexMutex();
    writeLock = new WriteLockManager();
    watcher = startWatcher(vaultPath, db, mutex, writeLock, undefined, undefined, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
    });
    await delay(100);
  });

  afterEach(async () => {
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it("emits field-defaulted with source='watcher' for a newly-typed file missing a required default", async () => {
    writeFileSync(
      join(vaultPath, 'new-doc.md'),
      '---\ntitle: New Doc\ntypes: [Doc]\n---\nbody\n',
      'utf-8',
    );
    await delay(DEBOUNCE_MS + MAX_WAIT_MS + 200);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?')
      .get('new-doc.md') as { id: string } | undefined;
    expect(node).toBeDefined();
    if (!node) return;

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'"
    ).all(node.id) as Array<{ details: string }>;
    expect(rows.length).toBeGreaterThan(0);

    const details = JSON.parse(rows[0].details);
    expect(details.source).toBe('watcher');
    expect(details.field).toBe('status');
    expect(details.default_value).toBe('draft');
    expect(details.default_source).toBe('global');
  });

  it('does not emit field-defaulted when the field is already present in the parsed file', async () => {
    writeFileSync(
      join(vaultPath, 'already-set.md'),
      '---\ntitle: Already Set\ntypes: [Doc]\nstatus: published\n---\nbody\n',
      'utf-8',
    );
    await delay(DEBOUNCE_MS + MAX_WAIT_MS + 200);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?')
      .get('already-set.md') as { id: string } | undefined;
    expect(node).toBeDefined();
    if (!node) return;

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'"
    ).all(node.id);
    expect(rows).toEqual([]);
  });
});
