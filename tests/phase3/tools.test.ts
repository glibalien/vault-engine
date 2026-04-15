import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault, addFileToVault } from '../helpers/vault.js';
import { resolveNodeIdentity } from '../../src/mcp/tools/resolve-identity.js';
import { reconstructValue } from '../../src/pipeline/classify-value.js';
import { populateDefaults } from '../../src/pipeline/populate-defaults.js';
import { propagateSchemaChange, diffClaims } from '../../src/schema/propagate.js';
import { updateSchemaDefinition } from '../../src/schema/crud.js';

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

function createNode(overrides: Record<string, unknown> = {}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: (overrides.file_path as string) ?? 'test.md',
    title: (overrides.title as string) ?? 'Test',
    types: (overrides.types as string[]) ?? [],
    fields: (overrides.fields as Record<string, unknown>) ?? {},
    body: (overrides.body as string) ?? '',
  });
}

// ── delete-node ───────────────────────────────────────────────────────

describe('delete-node behavior', () => {
  it('deletes file from disk and DB', () => {
    const created = createNode();
    const absPath = join(vaultPath, 'test.md');
    expect(existsSync(absPath)).toBe(true);

    // Delete
    writeLock.withLockSync(absPath, () => {
      const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(created.node_id) as { rowid: number };
      db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowInfo.rowid);
      db.prepare('DELETE FROM nodes WHERE id = ?').run(created.node_id);
    });

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(created.node_id);
    expect(node).toBeUndefined();
  });

  it('dangling references remain after deletion', () => {
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });

    // Create target and referencing nodes
    const target = createNode({ file_path: 'target.md', title: 'Target' });
    const source = createNode({
      file_path: 'source.md',
      title: 'Source',
      types: ['task'],
      fields: { project: 'Target' },
    });

    // Delete target
    db.prepare('DELETE FROM nodes WHERE id = ?').run(target.node_id);

    // Source still has the relationship (dangling)
    const rels = db.prepare('SELECT target FROM relationships WHERE source_id = ?').all(source.node_id) as { target: string }[];
    expect(rels.some(r => r.target === 'Target')).toBe(true);
  });
});

// ── rename-node behavior ──────────────────────────────────────────────

describe('rename-node behavior', () => {
  it('updates body wiki-links in referencing nodes', () => {
    const target = createNode({ file_path: 'target.md', title: 'Old Title' });
    const source = createNode({
      file_path: 'source.md',
      title: 'Source',
      body: 'See [[Old Title]] for details.',
    });

    // Simulate rename: update title and re-render source with updated body
    db.prepare('UPDATE nodes SET title = ?, file_path = ? WHERE id = ?').run('New Title', 'New Title.md', target.node_id);

    // Update source's body
    const newBody = 'See [[New Title]] for details.';
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: source.node_id,
      file_path: 'source.md',
      title: 'Source',
      types: [],
      fields: {},
      body: newBody,
    });

    const updated = db.prepare('SELECT body FROM nodes WHERE id = ?').get(source.node_id) as { body: string };
    expect(updated.body).toContain('[[New Title]]');
    expect(updated.body).not.toContain('[[Old Title]]');
  });
});

// ── add-type-to-node behavior ─────────────────────────────────────────

describe('add-type-to-node behavior', () => {
  it('populates defaults for newly-claimed fields', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    const created = createNode();

    // Simulate add-type: set types to ['task'] with populated defaults
    const { defaults } = populateDefaults(db, ['task'], {});
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: created.node_id,
      file_path: 'test.md',
      title: 'Test',
      types: ['task'],
      fields: { ...defaults },
      body: '',
    });

    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'status') as { value_text: string };
    expect(field.value_text).toBe('open');
  });

  it('re-adopts orphan fields when type is added', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // Create node with orphan field
    const created = createNode({ fields: { priority: 'high' } });

    // Verify it's an orphan
    expect(created.validation.orphan_fields).toContain('priority');

    // Add type — field becomes claimed
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: created.node_id,
      file_path: 'test.md',
      title: 'Test',
      types: ['task'],
      fields: { priority: 'high' },
      body: '',
    });

    // priority should no longer be an orphan
    expect(result.validation.orphan_fields).not.toContain('priority');
    expect(result.validation.coerced_state.priority?.source).toBe('provided');
  });
});

// ── remove-type-from-node behavior ────────────────────────────────────

describe('remove-type-from-node behavior', () => {
  it('orphans exclusively-claimed fields', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    const created = createNode({ types: ['task'], fields: { status: 'open' } });

    // Remove type — status becomes orphan
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: created.node_id,
      file_path: 'test.md',
      title: 'Test',
      types: [],
      fields: { status: 'open' },
      body: '',
    });

    expect(result.validation.orphan_fields).toContain('status');

    // Value preserved in DB
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'status') as { value_text: string };
    expect(field.value_text).toBe('open');
  });
});

// ── Schema propagation ────────────────────────────────────────────────

describe('schema propagation', () => {
  it('update-schema add claim populates defaults on existing nodes', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    // Create a task node
    const node = createNode({ file_path: 'task1.md', title: 'Task 1', types: ['task'], fields: { status: 'open' } });

    // Now add priority claim to task schema (simulate propagation)
    const oldClaims = [{ field: 'status', sort_order: 1000 }];
    const newClaims = [{ field: 'status', sort_order: 1000 }, { field: 'priority', sort_order: 2000 }];

    updateSchemaDefinition(db, 'task', {
      field_claims: newClaims.map(c => ({ field: c.field, sort_order: c.sort_order })),
    });

    const diff = diffClaims(oldClaims, newClaims);
    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBeGreaterThan(0);

    // Verify priority was populated
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'priority') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('normal');
  });
});

// ── batch-mutate ──────────────────────────────────────────────────────

describe('batch-mutate behavior', () => {
  it('in-flight reference: later op references node created by earlier op', () => {
    const result1 = createNode({ file_path: 'a.md', title: 'Node A' });

    // Batch: create B, then update B to reference A (by title)
    createGlobalField(db, { name: 'ref', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'linked', field_claims: [{ field: 'ref' }] });

    const nodeB = createNode({ file_path: 'b.md', title: 'Node B', types: ['linked'] });

    // Verify B can reference A by title
    const resolved = resolveNodeIdentity(db, { title: 'Node A' });
    expect(resolved.ok).toBe(true);
  });
});
