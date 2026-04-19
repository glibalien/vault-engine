import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition } from '../../src/schema/crud.js';
import { propagateSchemaChange, diffClaims, rerenderNodesWithField } from '../../src/schema/propagate.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

function createNode(overrides: Partial<ProposedMutation> = {}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: 'test.md',
    title: 'Test',
    types: [],
    fields: {},
    body: '',
    ...overrides,
  });
}

function readDetails(row: { details: string }): Record<string, unknown> {
  return JSON.parse(row.details);
}

describe('propagateSchemaChange — adoption', () => {
  it("added required+default claim populates the field and emits field-defaulted with source='propagation'", () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const node = createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: {} });

    // Add 'status' claim
    const oldClaims: Array<{ field: string; sort_order?: number }> = [];
    const newClaims = [{ field: 'status', sort_order: 1000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(1);
    expect(result.nodes_rerendered).toBe(1);

    // Field was persisted
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'status') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('open');

    // field-defaulted row emitted with source='propagation'
    const logRow = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY timestamp DESC, id DESC LIMIT 1",
    ).get(node.node_id) as { details: string };
    const details = readDetails(logRow);
    expect(details.source).toBe('propagation');
    expect(details.field).toBe('status');
    expect(details.default_value).toBe('open');
    expect(details.trigger).toBe('update-schema: task');
    expect(details.default_source).toBe('global');
  });

  it('added non-required claim: no default populated, no field-defaulted row', () => {
    createGlobalField(db, { name: 'notes', field_type: 'string', default_value: 'n/a' });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const node = createNode({ file_path: 'b.md', title: 'B', types: ['task'], fields: {} });

    const oldClaims: Array<{ field: string; sort_order?: number }> = [];
    const newClaims = [{ field: 'notes', sort_order: 1000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(0);

    const field = db.prepare('SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'notes');
    expect(field).toBeUndefined();

    const logRow = db.prepare(
      "SELECT * FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'",
    ).get(node.node_id);
    expect(logRow).toBeUndefined();
  });

  it('re-adopted claim (field already on node) does NOT emit field-defaulted or overwrite', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'c.md', title: 'C', types: ['task'], fields: { status: 'closed' } });

    // Remove the claim then re-add it
    updateSchemaDefinition(db, 'task', { field_claims: [] });
    propagateSchemaChange(db, writeLock, vaultPath, 'task', diffClaims(
      [{ field: 'status', sort_order: 1000 }],
      [],
    ));
    updateSchemaDefinition(db, 'task', { field_claims: [{ field: 'status', sort_order: 1000 }] });
    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diffClaims(
      [],
      [{ field: 'status', sort_order: 1000 }],
    ));

    // Re-adoption: no default populated (value was preserved as orphan during removal)
    expect(result.defaults_populated).toBe(0);

    // Value preserved — still 'closed'
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'status') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('closed');
  });
});

describe('propagateSchemaChange — orphaning', () => {
  it("removed claim emits fields-orphaned with source='propagation'", () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'd.md', title: 'D', types: ['task'], fields: { status: 'open' } });

    updateSchemaDefinition(db, 'task', { field_claims: [] });
    const diff = diffClaims([{ field: 'status', sort_order: 1000 }], []);
    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.fields_orphaned).toBe(1);

    // Value still preserved
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'status') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('open');

    // fields-orphaned row has source='propagation'
    const logRow = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'fields-orphaned' ORDER BY timestamp DESC, id DESC LIMIT 1",
    ).get(node.node_id) as { details: string };
    const details = readDetails(logRow);
    expect(details.source).toBe('propagation');
    expect(details.orphaned_fields).toEqual(['status']);
    expect(details.trigger).toBe('update-schema: task');
  });
});

describe('propagateSchemaChange — edge cases', () => {
  it('changed claim (metadata only) re-renders but emits no adoption/orphan rows', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'e.md', title: 'E', types: ['task'], fields: { status: 'open' } });

    const oldClaims = [{ field: 'status', sort_order: 1000 }];
    const newClaims = [{ field: 'status', sort_order: 500 }];  // sort_order changed
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(0);
    expect(result.fields_orphaned).toBe(0);

    const adoptionRow = db.prepare(
      "SELECT * FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'",
    ).get(node.node_id);
    expect(adoptionRow).toBeUndefined();

    const orphanRow = db.prepare(
      "SELECT * FROM edits_log WHERE node_id = ? AND event_type = 'fields-orphaned'",
    ).get(node.node_id);
    expect(orphanRow).toBeUndefined();
  });

  it('pre-existing REQUIRED_MISSING on unrelated field does not block propagation', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority', sort_order: 1000 }] });

    // Create the node via normalizer (bypasses REQUIRED_MISSING)
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'normalizer',
      node_id: null,
      file_path: 'f.md',
      title: 'F',
      types: ['task'],
      fields: {},  // priority is missing
      body: '',
    });

    // Now add 'status' claim — should succeed despite pre-existing REQUIRED_MISSING
    const oldClaims = [{ field: 'priority', sort_order: 1000 }];
    const newClaims = [
      { field: 'priority', sort_order: 1000 },
      { field: 'status', sort_order: 2000 },
    ];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.nodes_affected).toBe(1);
    // Node was processed — file on disk exists
    expect(existsSync(join(vaultPath, 'f.md'))).toBe(true);
  });

  it('empty diff returns zero-result and does not touch DB', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'g.md', title: 'G', types: ['task'], fields: { status: 'open' } });

    const logCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM edits_log').get() as { c: number }).c;

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', { added: [], removed: [], changed: [] });

    expect(result.nodes_affected).toBe(0);
    expect(result.nodes_rerendered).toBe(0);
    expect(result.defaults_populated).toBe(0);
    expect(result.fields_orphaned).toBe(0);

    const logCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM edits_log').get() as { c: number }).c;
    expect(logCountAfter).toBe(logCountBefore);
  });
});
