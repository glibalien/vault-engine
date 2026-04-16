import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { sha256 } from '../../src/indexer/hash.js';
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

// ── Tool path: create-node ────────────────────────────────────────────

describe('executeMutation — tool path create', () => {
  it('creates a node: file written, DB populated, hash matches', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation());

    expect(result.file_written).toBe(true);
    expect(result.node_id).toBeTruthy();

    // File exists on disk
    const filePath = join(vaultPath, 'test-node.md');
    expect(existsSync(filePath)).toBe(true);

    // DB has the node
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.node_id) as { title: string; content_hash: string };
    expect(node.title).toBe('Test Node');
    expect(node.content_hash).toBe(result.rendered_hash);

    // File content matches rendered hash
    const fileContent = readFileSync(filePath, 'utf-8');
    expect(sha256(fileContent)).toBe(result.rendered_hash);
  });

  it('creates a node with types and fields', () => {
    // Set up schema
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 100 }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { status: 'open' },
    }));

    expect(result.file_written).toBe(true);

    // Check DB fields
    const fields = db.prepare('SELECT field_name, value_text FROM node_fields WHERE node_id = ?').all(result.node_id) as { field_name: string; value_text: string }[];
    expect(fields.find(f => f.field_name === 'status')?.value_text).toBe('open');

    // Check DB types
    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(result.node_id) as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['task']);
  });

  it('rejects on missing required field', () => {
    createGlobalField(db, { name: 'title_field', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'note', field_claims: [{ field: 'title_field' }] });

    expect(() => executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['note'],
      fields: {},
    }))).toThrow(PipelineError);

    // No file written
    expect(existsSync(join(vaultPath, 'test-node.md'))).toBe(false);
  });

  it('coerces value and records in coerced_state', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'count' }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { count: '42' },
    }));

    expect(result.validation.coerced_state.count.changed).toBe(true);
    expect(result.validation.coerced_state.count.value).toBe(42);

    // DB has the coerced value
    const field = db.prepare('SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?').get(result.node_id, 'count') as { value_number: number };
    expect(field.value_number).toBe(42);
  });

  it('resolves conflicting required overrides via cancellation', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', overrides_allowed: { required: true } });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', required: true }] });
    createSchemaDefinition(db, { name: 'project', field_claims: [{ field: 'status', required: false }] });

    // Conflicting required overrides cancel out — global default wins (required: false)
    // No MERGE_CONFLICT issue is raised; the value is accepted normally
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task', 'project'],
      fields: { status: 'open' },
    }));

    expect(result.file_written).toBe(true);
    expect(result.validation.issues.some(i => i.code === 'MERGE_CONFLICT')).toBe(false);
    expect(result.validation.coerced_state.status.value).toBe('open');
  });

  it('handles orphan fields correctly', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: [],
      fields: { custom: 'my-value' },
    }));

    expect(result.validation.orphan_fields).toContain('custom');
    expect(result.validation.coerced_state.custom.source).toBe('orphan');

    // Check file contains the orphan field
    const content = readFileSync(join(vaultPath, 'test-node.md'), 'utf-8');
    expect(content).toContain('custom: my-value');
  });

  it('populates defaults for missing required fields', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: {},
    }));

    expect(result.validation.coerced_state.status.value).toBe('open');
    expect(result.validation.coerced_state.status.source).toBe('defaulted');
  });
});

// ── Tool path: update (existing node) ─────────────────────────────────

describe('executeMutation — tool path update', () => {
  it('updates an existing node', () => {
    // Create first
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());

    // Update
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: created.node_id,
      title: 'Updated Title',
      body: 'New body content.',
    }));

    expect(result.file_written).toBe(true);
    expect(result.node_id).toBe(created.node_id);

    const node = db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(result.node_id) as { title: string; body: string };
    expect(node.title).toBe('Updated Title');
    expect(node.body).toBe('New body content.');
  });
});

// ── Null deletion of defaulted fields ──────────────────────────────────

describe('executeMutation — null deletion intent', () => {
  it('explicit null on a field with a default removes the field (no re-default)', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    // Create with the default
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { status: 'open' },
    }));

    // "Update" with explicit null — should delete the field, NOT re-default
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: created.node_id,
      types: ['task'],
      fields: { status: null },
    }));

    // status should NOT be in coerced_state (null = deletion intent)
    expect(result.validation.coerced_state.status).toBeUndefined();

    // status should NOT be in DB
    const field = db.prepare('SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'status');
    expect(field).toBeUndefined();
  });
});

// ── No-op write rule ──────────────────────────────────────────────────

describe('executeMutation — no-op write rule', () => {
  it('no-op when rendered hash matches on-disk file', () => {
    // Create the node first
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());
    expect(created.file_written).toBe(true);

    // Run the same mutation again — should be no-op
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: created.node_id,
    }));

    expect(result.file_written).toBe(false);
    expect(result.edits_logged).toBe(0);
  });
});

// ── Watcher path ──────────────────────────────────────────────────────

describe('executeMutation — watcher path', () => {
  it('watcher with db_only updates DB without writing file', () => {
    // Create via tool
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      body: 'Original body.',
    }));

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      body: 'Updated body from editor.',
      source_content_hash: sha256(readFileSync(join(vaultPath, 'test-node.md'), 'utf-8')),
      db_only: true,
    }));

    // File NOT written (db_only)
    expect(result.file_written).toBe(false);
    // DB IS updated
    const node = db.prepare('SELECT body FROM nodes WHERE id = ?').get(result.node_id) as { body: string };
    expect(node.body).toBe('Updated body from editor.');
  });

  it('watcher without db_only writes file (tool-equivalent behavior)', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      body: 'Original body.',
    }));

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      body: 'Updated body.',
    }));

    // File IS written (no db_only flag)
    expect(result.file_written).toBe(true);
  });

  it('watcher db_only updates DB without writing file', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      db_only: true,
      types: ['task'],
      fields: { priority: 'normal' },
    }));

    expect(result.file_written).toBe(false);

    // DB IS populated
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'priority') as { value_text: string };
    expect(field.value_text).toBe('normal');
  });

  it('watcher db_only coerces values', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'count', sort_order: 100 }] });

    // Create node with numeric count
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { count: 5 },
    }));

    // Watcher sends string '10' — needs coercion to number
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      types: ['task'],
      fields: { count: '10' },
      source_content_hash: sha256(readFileSync(join(vaultPath, 'test-node.md'), 'utf-8')),
      db_only: true,
    }));

    expect(result.file_written).toBe(false);
    expect(result.validation.coerced_state.count.changed).toBe(true);
    expect(result.validation.coerced_state.count.value).toBe(10);
  });

  it('watcher retains DB value for rejected field', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    // Create with valid value
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { status: 'open' },
    }));

    // Simulate user editing the file to have an invalid value
    const filePath = join(vaultPath, 'test-node.md');
    writeFileSync(filePath, '---\ntitle: Test Node\ntypes:\n  - task\nstatus: invalid-value\n---\n', 'utf-8');

    // Watcher sends invalid value — without db_only, writes the corrected file
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      types: ['task'],
      fields: { status: 'invalid-value' },
    }));

    expect(result.file_written).toBe(true);

    // DB should retain 'open'
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?').get(result.node_id, 'status') as { value_text: string };
    expect(field.value_text).toBe('open');

    // Should have a value-rejected edits log entry
    const logs = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'value-rejected'"
    ).all(result.node_id) as { details: string }[];
    expect(logs.length).toBeGreaterThan(0);
    const details = JSON.parse(logs[0].details);
    expect(details.rejected_value).toBe('invalid-value');
    expect(details.retained_value).toBe('open');
  });
});

// ── Tool path always writes ─────────────────────────────────────────

describe('executeMutation — tool path always writes file', () => {
  it('tool path writes file regardless of prior state', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'tool',
      node_id: created.node_id,
      body: 'Updated via tool.',
    }));

    expect(result.file_written).toBe(true);
  });
});

// ── db_only mode ──────────────────────────────────────────────────────

describe('executeMutation — db_only mode', () => {
  it('updates DB but does not write file when db_only is true', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      db_only: true,
      body: 'Some content.',
    }));

    expect(result.file_written).toBe(false);

    // DB IS populated
    const node = db.prepare('SELECT title, body FROM nodes WHERE id = ?')
      .get(result.node_id) as { title: string; body: string };
    expect(node.title).toBe('Test Node');
    expect(node.body).toBe('Some content.');

    // File does NOT exist on disk
    expect(existsSync(join(vaultPath, 'test-node.md'))).toBe(false);
  });

  it('db_only no-op when rendered matches DB hash', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      db_only: true,
    }));

    expect(result.file_written).toBe(false);
  });
});

// ── Relationships ─────────────────────────────────────────────────────

describe('executeMutation — relationships', () => {
  it('derives relationships from reference fields', () => {
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { project: 'Vault Engine' },
    }));

    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ?').all(result.node_id) as { target: string; rel_type: string }[];
    expect(rels.some(r => r.target === 'Vault Engine' && r.rel_type === 'project')).toBe(true);
  });

  it('derives relationships from orphan fields with wiki-links', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      fields: { random_ref: '[[Some Node]]' },
    }));

    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ?').all(result.node_id) as { target: string; rel_type: string }[];
    expect(rels.some(r => r.target === 'Some Node' && r.rel_type === 'random_ref')).toBe(true);
  });

  it('derives relationships from body wiki-links', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      body: 'Check out [[Other Note]] for details.',
    }));

    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ?').all(result.node_id) as { target: string; rel_type: string }[];
    expect(rels.some(r => r.target === 'Other Note' && r.rel_type === 'wiki-link')).toBe(true);
  });
});

// ── Normalizer path ──────────────────────────────────────────────────

describe('executeMutation — normalizer path', () => {
  it('normalizer source writes file like tool path', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'normalizer',
    }));

    expect(result.file_written).toBe(true);
    expect(result.node_id).toBeTruthy();

    const filePath = join(vaultPath, 'test-node.md');
    expect(existsSync(filePath)).toBe(true);

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.node_id) as { content_hash: string };
    expect(node.content_hash).toBe(result.rendered_hash);
  });

  it('normalizer source coerces values like tool path', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'count', sort_order: 100 }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'normalizer',
      types: ['task'],
      fields: { count: '42' },
    }));

    expect(result.file_written).toBe(true);
    // Value should be coerced to number
    const field = db.prepare('SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'count') as { value_number: number };
    expect(field.value_number).toBe(42);
  });
});
