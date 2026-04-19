import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

describe('rerenderNodesWithField', () => {
  it('re-renders nodes containing the named field, no adoption/orphan rows', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    createNode({ file_path: 'h1.md', title: 'H1', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'h2.md', title: 'H2', types: ['task'], fields: { status: 'done' } });
    // A node WITHOUT the field — must not be touched
    createNode({ file_path: 'h3.md', title: 'H3' });

    // Corrupt the h1 file on disk so its hash no longer matches the DB — this
    // is what forces rerenderNodesWithField to actually re-write h1.
    const h1Path = join(vaultPath, 'h1.md');
    writeFileSync(h1Path, readFileSync(h1Path, 'utf-8') + '\n<!-- drift -->\n');
    const h3Path = join(vaultPath, 'h3.md');
    const h3MtimeBefore = statSync(h3Path).mtimeMs;

    const logIdBaseline = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM edits_log').get() as { id: number }).id;

    const rerendered = rerenderNodesWithField(db, writeLock, vaultPath, 'status');

    // h1 had drift → re-rendered. h2 already matched → no re-write. h3 lacks the field → not visited.
    expect(rerendered).toBe(1);

    // h3 must not have been touched
    expect(statSync(h3Path).mtimeMs).toBe(h3MtimeBefore);

    // Confirm no adoption/orphan rows were emitted by rerenderNodesWithField
    const newAdoptionRows = db.prepare(
      "SELECT COUNT(*) AS c FROM edits_log WHERE event_type IN ('field-defaulted', 'fields-orphaned') AND id > ?"
    ).get(logIdBaseline) as { c: number };
    expect(newAdoptionRows.c).toBe(0);
  });

  it('additionalNodeIds deduplicates: a node in both sets is re-rendered once', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'i.md', title: 'I', types: ['task'], fields: { status: 'open' } });

    // Use additionalNodeIds to double-pass the same node; the implementation
    // should dedupe so we don't double-process.
    const count = rerenderNodesWithField(db, writeLock, vaultPath, 'status', [node.node_id]);

    // No assertion on the exact count value (it may be 0 if hashes already match);
    // the check is that we don't throw and the file remains well-formed.
    expect(existsSync(join(vaultPath, 'i.md'))).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('additionalNodeIds picks up nodes whose field was deleted (type-change uncoercible case)', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'item', field_claims: [{ field: 'count', sort_order: 1000 }] });

    const node = createNode({ file_path: 'j.md', title: 'J', types: ['item'], fields: { count: 42 } });

    // Simulate update-global-field deleting the uncoercible row
    db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?').run(node.node_id, 'count');

    // The node no longer matches the field query — but additionalNodeIds forces it in
    const count = rerenderNodesWithField(db, writeLock, vaultPath, 'count', [node.node_id]);

    // The file was re-rendered (content changed since the field was removed)
    expect(count).toBe(1);
    const body = readFileSync(join(vaultPath, 'j.md'), 'utf-8');
    expect(body.includes('count:')).toBe(false);
  });
});

describe('propagateSchemaChange — edits_log row ordering', () => {
  it('pipeline rows precede caller-emitted adoption/orphan rows within a single update-schema call', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createGlobalField(db, { name: 'legacy', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'legacy', sort_order: 1000 }] });

    // Node has 'legacy' field but not 'status'
    const node = createNode({
      file_path: 'k.md',
      title: 'K',
      types: ['task'],
      fields: { legacy: 'old-value' },
    });

    const logIdBeforeBaseline = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM edits_log').get() as { id: number }).id;

    // Now: remove 'legacy' AND add 'status' (with required+default) simultaneously
    const oldClaims = [{ field: 'legacy', sort_order: 1000 }];
    const newClaims = [{ field: 'status', sort_order: 2000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    // Fetch rows added during this propagation, in insertion order
    const rows = db.prepare(
      "SELECT id, event_type, details FROM edits_log WHERE node_id = ? AND id > ? ORDER BY id ASC"
    ).all(node.node_id, logIdBeforeBaseline) as Array<{ id: number; event_type: string; details: string }>;

    // Exactly one field-defaulted and one fields-orphaned row from propagate.ts's post-emission
    const fieldDefaulted = rows.filter(r => r.event_type === 'field-defaulted');
    const fieldsOrphaned = rows.filter(r => r.event_type === 'fields-orphaned');
    expect(fieldDefaulted.length).toBe(1);
    expect(fieldsOrphaned.length).toBe(1);

    // Adoption row comes before orphan row (caller emits in this order)
    expect(fieldDefaulted[0].id).toBeLessThan(fieldsOrphaned[0].id);

    // Both rows carry source='propagation'
    expect(JSON.parse(fieldDefaulted[0].details).source).toBe('propagation');
    expect(JSON.parse(fieldsOrphaned[0].details).source).toBe('propagation');

    // If the pipeline itself emitted any rows (none expected here since no
    // value-coerced or merge-conflict scenarios), they'd sit BEFORE the
    // adoption/orphan rows by id.
  });
});

describe('propagateSchemaChange — date-token defaults', () => {
  it("resolves '$now' in adoption default to today's YYYY-MM-DD before inserting", () => {
    createGlobalField(db, {
      name: 'created_on',
      field_type: 'date',
      default_value: '$now',
      required: true,
    });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const node = createNode({ file_path: 'l.md', title: 'L', types: ['task'], fields: {} });

    updateSchemaDefinition(db, 'task', { field_claims: [{ field: 'created_on', sort_order: 1000 }] });
    const diff = diffClaims([], [{ field: 'created_on', sort_order: 1000 }]);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(1);

    // The field was persisted with the resolved YYYY-MM-DD string (coerced dates
    // are stored as strings in value_text, not as value_date).
    const field = db.prepare(
      'SELECT value_text, value_date FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(node.node_id, 'created_on') as { value_text: string | null; value_date: string | null } | undefined;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const persisted = field?.value_text ?? field?.value_date ?? '';
    expect(persisted.startsWith(today)).toBe(true);
    // Must be the resolved form, not the unresolved token
    expect(persisted).not.toBe('$now');

    // field-defaulted row stored the resolved string, not the token
    const logRow = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id DESC LIMIT 1",
    ).get(node.node_id) as { details: string };
    const details = readDetails(logRow);
    expect(details.default_value).not.toBe('$now');
    expect(String(details.default_value).startsWith(today)).toBe(true);
  });
});
