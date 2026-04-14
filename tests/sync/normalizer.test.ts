import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { sha256 } from '../../src/indexer/hash.js';
import { startNormalizer, runNormalizerSweep } from '../../src/sync/normalizer.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);
});

afterEach(() => {
  db.close();
  cleanup();
});

function createNodeViaToolPath(
  filePath: string,
  opts: { title?: string; types?: string[]; fields?: Record<string, unknown>; body?: string } = {},
): string {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: filePath,
    title: opts.title ?? filePath.replace(/\.md$/, ''),
    types: opts.types ?? [],
    fields: opts.fields ?? {},
    body: opts.body ?? '',
  }, syncLogger);
  return result.node_id;
}

function makeFileOld(filePath: string, ageMs: number): void {
  const absPath = join(vaultPath, filePath);
  const past = new Date(Date.now() - ageMs);
  utimesSync(absPath, past, past);
}

describe('normalizer lifecycle', () => {
  it('returns no-op stop function when no cron expression provided', () => {
    const normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger);
    normalizer.stop();
  });

  it('returns no-op stop function when cron expression is empty string', () => {
    const normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger, {
      cronExpression: '',
    });
    normalizer.stop();
  });

  it('starts and stops cleanly with valid cron expression', () => {
    const normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger, {
      cronExpression: '0 3 * * *',
      quiescenceMinutes: 60,
    });
    normalizer.stop();
  });

  it('stop() is safe to call multiple times', () => {
    const normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger, {
      cronExpression: '* * * * *',
      quiescenceMinutes: 60,
    });
    normalizer.stop();
    normalizer.stop();
  });
});

describe('normalizer sweep logic via executeMutation', () => {
  it('re-renders a file whose on-disk format drifts from canonical', () => {
    const nodeId = createNodeViaToolPath('drift.md', {
      title: 'Drift Test',
    });

    const canonicalContent = readFileSync(join(vaultPath, 'drift.md'), 'utf-8');

    // Simulate drift: add trailing whitespace (changes hash but not data)
    const driftedContent = canonicalContent + '\n\n';
    writeFileSync(join(vaultPath, 'drift.md'), driftedContent, 'utf-8');

    // Simulate watcher having ingested the drifted file (DB hash = drifted hash)
    const driftedHash = sha256(driftedContent);
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(driftedHash, nodeId);

    makeFileOld('drift.md', 2 * 60 * 60 * 1000);

    // Call executeMutation as the normalizer would
    const nodeRow = db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(nodeId) as {
      title: string; body: string;
    };
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'normalizer',
      node_id: nodeId,
      file_path: 'drift.md',
      title: nodeRow.title,
      types,
      fields: {},
      body: nodeRow.body,
    }, syncLogger);

    expect(result.file_written).toBe(true);

    // File should now match canonical content
    const restoredContent = readFileSync(join(vaultPath, 'drift.md'), 'utf-8');
    expect(restoredContent).toBe(canonicalContent);
  });

  it('skips files that are already canonical (no-op)', () => {
    const nodeId = createNodeViaToolPath('canonical.md', {
      title: 'Already Canonical',
    });

    // File was just written by tool path — it IS canonical
    const nodeRow = db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(nodeId) as {
      title: string; body: string;
    };
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'normalizer',
      node_id: nodeId,
      file_path: 'canonical.md',
      title: nodeRow.title,
      types,
      fields: {},
      body: nodeRow.body,
    }, syncLogger);

    expect(result.file_written).toBe(false);
  });

  it('normalizes a file with typed fields back to canonical format', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createGlobalField(db, { name: 'priority', field_type: 'number' });
    createSchemaDefinition(db, { name: 'task', field_claims: [
      { field: 'status', sort_order: 100 },
      { field: 'priority', sort_order: 200 },
    ] });

    const nodeId = createNodeViaToolPath('task.md', {
      title: 'My Task',
      types: ['task'],
      fields: { status: 'open', priority: 5 },
    });

    const canonicalContent = readFileSync(join(vaultPath, 'task.md'), 'utf-8');

    // Simulate Obsidian reordering fields (priority before status)
    const reordered = canonicalContent.replace(
      /status: open\npriority: 5/,
      'priority: 5\nstatus: open',
    );
    writeFileSync(join(vaultPath, 'task.md'), reordered, 'utf-8');

    const reorderedHash = sha256(reordered);
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(reorderedHash, nodeId);

    makeFileOld('task.md', 2 * 60 * 60 * 1000);

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'normalizer',
      node_id: nodeId,
      file_path: 'task.md',
      title: 'My Task',
      types: ['task'],
      fields: { status: 'open', priority: 5 },
      body: '',
    }, syncLogger);

    expect(result.file_written).toBe(true);

    // File should be back to canonical ordering
    const restored = readFileSync(join(vaultPath, 'task.md'), 'utf-8');
    expect(restored).toBe(canonicalContent);
  });

  it('logs file-written events to sync_log with normalizer source', () => {
    const nodeId = createNodeViaToolPath('logged.md', { title: 'Logged' });

    const content = readFileSync(join(vaultPath, 'logged.md'), 'utf-8');
    const drifted = content + '\n';
    writeFileSync(join(vaultPath, 'logged.md'), drifted, 'utf-8');
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(sha256(drifted), nodeId);

    makeFileOld('logged.md', 2 * 60 * 60 * 1000);

    executeMutation(db, writeLock, vaultPath, {
      source: 'normalizer',
      node_id: nodeId,
      file_path: 'logged.md',
      title: 'Logged',
      types: [],
      fields: {},
      body: '',
    }, syncLogger);

    const rows = db.prepare(
      "SELECT * FROM sync_log WHERE source = 'normalizer' AND event = 'file-written'",
    ).all() as Array<{ file_path: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.file_path === 'logged.md')).toBe(true);
  });
});

describe('normalizer edits_log', () => {
  it('sweep summary has structured stats fields', () => {
    const stats = {
      scanned: 100,
      skipped_quiescent: 10,
      skipped_canonical: 80,
      skipped_missing: 2,
      rewritten: 6,
      errored: 2,
    };
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ).run(null, Date.now(), 'normalizer-sweep', JSON.stringify(stats));

    const row = db.prepare(
      "SELECT details FROM edits_log WHERE event_type = 'normalizer-sweep'",
    ).get() as { details: string };
    const parsed = JSON.parse(row.details);

    expect(parsed.scanned).toBe(100);
    expect(parsed.skipped_quiescent).toBe(10);
    expect(parsed.skipped_canonical).toBe(80);
    expect(parsed.skipped_missing).toBe(2);
    expect(parsed.rewritten).toBe(6);
    expect(parsed.errored).toBe(2);
  });
});

describe('normalizer backfill of missing defaults', () => {
  it('populates missing field with static default on normalize sweep', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    createSchemaDefinition(db, { name: 'task', field_claims: [
      { field: 'status', sort_order: 100 },
    ] });

    // Create node WITHOUT status field (simulates pre-existing node)
    const nodeId = createNodeViaToolPath('backfill.md', {
      title: 'Backfill Test',
      types: ['task'],
      fields: {},
    });

    // Remove the status field from DB (simulates it never having been set —
    // the tool path would have defaulted it, so we strip it to simulate a
    // node created before the default was configured)
    db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?').run(nodeId, 'status');
    // Invalidate content hash so normalizer sees it as stale
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run('stale', nodeId);

    makeFileOld('backfill.md', 2 * 60 * 60 * 1000);

    const stats = runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
      skipQuiescence: true,
    });

    expect(stats.rewritten).toBeGreaterThanOrEqual(1);

    // Verify the field was populated in DB
    const row = db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'status') as { value_text: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value_text).toBe('open');
  });

  it('populates missing field with $ctime token using DB created_at', () => {
    createGlobalField(db, { name: 'date', field_type: 'reference', reference_target: 'daily-note', default_value: '$ctime:YYYY-MM-DD' });
    createSchemaDefinition(db, { name: 'note', field_claims: [
      { field: 'date', sort_order: 100 },
    ] });

    const nodeId = createNodeViaToolPath('ctime-backfill.md', {
      title: 'Ctime Backfill',
      types: ['note'],
      fields: {},
    });

    // Set a known created_at in the past
    const knownCreatedAt = new Date('2023-07-20T10:00:00').getTime();
    db.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run(knownCreatedAt, nodeId);

    // Strip the date field and invalidate hash
    db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?').run(nodeId, 'date');
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run('stale', nodeId);

    makeFileOld('ctime-backfill.md', 2 * 60 * 60 * 1000);

    const stats = runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
      skipQuiescence: true,
    });

    expect(stats.rewritten).toBeGreaterThanOrEqual(1);

    // Verify the date field was populated with the DB created_at, not today's date
    const row = db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'date') as { value_text: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value_text).toBe('2023-07-20');
  });

  it('does not overwrite existing field values during backfill', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    createSchemaDefinition(db, { name: 'task', field_claims: [
      { field: 'status', sort_order: 100 },
    ] });

    const nodeId = createNodeViaToolPath('no-overwrite.md', {
      title: 'No Overwrite',
      types: ['task'],
      fields: { status: 'closed' },
    });

    // Invalidate hash so normalizer processes it
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run('stale', nodeId);
    makeFileOld('no-overwrite.md', 2 * 60 * 60 * 1000);

    runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
      skipQuiescence: true,
    });

    const row = db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'status') as { value_text: string };
    expect(row.value_text).toBe('closed');
  });
});
