import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { WriteGate } from '../../src/sync/write-gate.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { createTempVault } from '../helpers/vault.js';
import { propagateSchemaChange, diffClaims } from '../../src/schema/propagate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition } from '../../src/schema/crud.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let writeGate: WriteGate;
let syncLogger: SyncLogger;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  writeGate = new WriteGate({ quietPeriodMs: 3000 });
  syncLogger = new SyncLogger(db);
});

afterEach(() => {
  writeGate.dispose();
  db.close();
  cleanup();
});

function makeMutation(overrides: Partial<ProposedMutation> = {}): ProposedMutation {
  return {
    source: 'tool',
    node_id: null,
    file_path: 'test-node.md',
    title: 'Test Node',
    types: [],
    fields: {},
    body: '',
    ...overrides,
  };
}

function getSyncLogEvents(filePath: string): Array<{ event: string; details: string }> {
  return db.prepare('SELECT event, details FROM sync_log WHERE file_path = ? ORDER BY id')
    .all(filePath) as Array<{ event: string; details: string }>;
}

describe('WriteGate cancellation in executeMutation', () => {
  it('tool write cancels pending deferred write', () => {
    // Schedule a deferred write
    writeGate.fileChanged('test-node.md', () => {});
    expect(writeGate.isPending('test-node.md')).toBe(true);

    // Tool write through pipeline
    executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    // Deferred write should be cancelled
    expect(writeGate.isPending('test-node.md')).toBe(false);

    // Sync log should show cancellation
    const events = getSyncLogEvents('test-node.md');
    const cancelEvent = events.find(e => e.event === 'deferred-write-cancelled');
    expect(cancelEvent).toBeDefined();
    expect(JSON.parse(cancelEvent!.details).reason).toBe('tool-write');
  });

  it('tool no-op cancels pending deferred write', () => {
    // Create a node first
    const result = executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    // Schedule a deferred write
    writeGate.fileChanged('test-node.md', () => {});
    expect(writeGate.isPending('test-node.md')).toBe(true);

    // Tool mutation that results in no-op (same data)
    executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: result.node_id,
    }), writeGate, syncLogger);

    // Deferred write should be cancelled even on no-op
    expect(writeGate.isPending('test-node.md')).toBe(false);
  });

  it('watcher write (db_only) does NOT cancel pending deferred write', () => {
    // Schedule a deferred write
    writeGate.fileChanged('test-node.md', () => {});

    // Watcher write (db_only)
    executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      db_only: true,
      source_content_hash: 'abc',
    }), writeGate, syncLogger);

    // Deferred write should still be pending
    expect(writeGate.isPending('test-node.md')).toBe(true);
  });

  it('logs file-written event on tool write', () => {
    executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    const events = getSyncLogEvents('test-node.md');
    const writeEvent = events.find(e => e.event === 'file-written');
    expect(writeEvent).toBeDefined();
  });

  it('logs noop event on Stage 5 no-op', () => {
    // Create node
    const result = executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    // Clear sync log for clarity
    db.prepare('DELETE FROM sync_log').run();

    // Same data again = no-op
    executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: result.node_id,
    }), writeGate, syncLogger);

    const events = getSyncLogEvents('test-node.md');
    const noopEvent = events.find(e => e.event === 'noop');
    expect(noopEvent).toBeDefined();
  });
});

describe('WriteGate cancellation in propagation', () => {
  it('propagateSchemaChange cancels pending deferred write', () => {
    // Set up a schema with a node
    createGlobalField(db, { name: 'priority', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // Create a node of type 'task'
    const nodeResult = executeMutation(db, writeLock, vaultPath, makeMutation({
      file_path: 'Tasks/test-task.md',
      title: 'Test Task',
      types: ['task'],
      fields: { priority: 'high' },
    }), writeGate, syncLogger);

    // Clear sync log before the propagation test so we isolate propagation events
    db.prepare('DELETE FROM sync_log').run();

    // Schedule a deferred write for this file
    writeGate.fileChanged('Tasks/test-task.md', () => {});
    expect(writeGate.isPending('Tasks/test-task.md')).toBe(true);

    // Propagate a schema change (add a new claim with default from the global field)
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    const oldClaims = [{ field: 'priority' }];
    const newClaims = [{ field: 'priority' }, { field: 'status' }];
    // Update the schema in DB so mergeFieldClaims returns the new effective fields
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);
    propagateSchemaChange(db, writeLock, vaultPath, 'task', diff, writeGate, syncLogger);

    // Deferred write should be cancelled
    expect(writeGate.isPending('Tasks/test-task.md')).toBe(false);

    // Sync log should show propagation cancellation
    const events = getSyncLogEvents('Tasks/test-task.md');
    const cancelEvent = events.find(e => e.event === 'deferred-write-cancelled');
    expect(cancelEvent).toBeDefined();
    expect(JSON.parse(cancelEvent!.details).reason).toBe('propagation');
  });
});
