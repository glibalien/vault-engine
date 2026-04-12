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

  it('allows merge conflict when value is provided', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', per_type_overrides_allowed: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', required: true }] });
    createSchemaDefinition(db, { name: 'project', field_claims: [{ field: 'status', required: false }] });

    // Should NOT throw despite MERGE_CONFLICT — value is provided
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task', 'project'],
      fields: { status: 'open' },
    }));

    expect(result.file_written).toBe(true);
    expect(result.validation.issues.some(i => i.code === 'MERGE_CONFLICT')).toBe(true);
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

  it('populates defaults for missing fields', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
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
  it('watcher absorbs valid edit (DB updated, file not rewritten)', () => {
    // Create via tool
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      body: 'Original body.',
    }));

    // Simulate watcher edit — change body. No fields to coerce, no
    // defaults to add, so the watcher should skip the file write.
    const filePath = join(vaultPath, 'test-node.md');
    const fileContentBefore = readFileSync(filePath, 'utf-8');

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      body: 'Updated body from editor.',
      source_content_hash: sha256(fileContentBefore),
    }));

    // File NOT rewritten (no substantive pipeline changes)
    expect(result.file_written).toBe(false);
    // But DB IS updated
    const node = db.prepare('SELECT body FROM nodes WHERE id = ?').get(result.node_id) as { body: string };
    expect(node.body).toBe('Updated body from editor.');
  });

  it('watcher skips file write when no substantive changes', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 100 }] });

    // Create node via tool
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { status: 'open' },
    }));

    const filePath = join(vaultPath, 'test-node.md');
    const fileContentBefore = readFileSync(filePath, 'utf-8');

    // Watcher sends same data — no changes
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      types: ['task'],
      fields: { status: 'open' },
      source_content_hash: sha256(fileContentBefore),
    }));

    // File NOT rewritten
    expect(result.file_written).toBe(false);
    // File unchanged on disk
    expect(readFileSync(filePath, 'utf-8')).toBe(fileContentBefore);
    // DB hash matches source file (not rendered hash)
    const node = db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(result.node_id) as { content_hash: string };
    expect(node.content_hash).toBe(sha256(fileContentBefore));
  });

  it('watcher writes file when defaults are added (new type)', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // Create node via tool without types
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());
    const filePath = join(vaultPath, 'test-node.md');

    // Simulate user adding 'task' type in Obsidian — processFileChange
    // populates defaults and sets has_populated_defaults.
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      types: ['task'],
      fields: { priority: 'normal' },
      source_content_hash: sha256(readFileSync(filePath, 'utf-8')),
      has_populated_defaults: true,
    }));

    // File IS rewritten (defaults were populated by processFileChange)
    expect(result.file_written).toBe(true);
  });

  it('watcher writes file when values are coerced', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'count', sort_order: 100 }] });

    // Create node with numeric count
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      types: ['task'],
      fields: { count: 5 },
    }));
    const filePath = join(vaultPath, 'test-node.md');

    // Watcher sends string '10' — needs coercion to number
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      types: ['task'],
      fields: { count: '10' },
      source_content_hash: sha256(readFileSync(filePath, 'utf-8')),
    }));

    // File IS rewritten (value was coerced)
    expect(result.file_written).toBe(true);
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
    // (in real flow, the watcher reads the edited file)
    const filePath = join(vaultPath, 'test-node.md');
    writeFileSync(filePath, '---\ntitle: Test Node\ntypes:\n  - task\nstatus: invalid-value\n---\n', 'utf-8');

    // Watcher sends invalid value (parsed from the edited file)
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      types: ['task'],
      fields: { status: 'invalid-value' },
    }));

    // Should write (re-renders the file with the retained value)
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

// ── Stale-file guard ─────────────────────────────────────────────────

describe('executeMutation — stale-file guard', () => {
  it('aborts write when file changed since parsing', () => {
    // Create a node first
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      body: 'Original body.',
    }));
    expect(created.file_written).toBe(true);

    // Read the file hash as the watcher would at parse time
    const filePath = join(vaultPath, 'test-node.md');
    const originalContent = readFileSync(filePath, 'utf-8');
    const originalHash = sha256(originalContent);

    // Simulate the file being edited by Obsidian AFTER the watcher parsed it
    writeFileSync(filePath, '---\ntitle: Test Node\ntypes:\n  - task\n---\nEdited by Obsidian.\n', 'utf-8');

    // Watcher mutation with the OLD hash — file is now stale
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      body: 'Original body.',
      source_content_hash: originalHash,
    }));

    // Should NOT write — file changed since parsing
    expect(result.file_written).toBe(false);

    // File on disk should still be the Obsidian edit, NOT overwritten
    const fileAfter = readFileSync(filePath, 'utf-8');
    expect(fileAfter).toContain('Edited by Obsidian.');

    // Should have a stale-file-skipped log entry
    const logs = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'stale-file-skipped'"
    ).all(created.node_id) as { details: string }[];
    expect(logs.length).toBe(1);
  });

  it('proceeds past stale guard when source_content_hash matches', () => {
    // Create a node
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());
    const filePath = join(vaultPath, 'test-node.md');
    const currentContent = readFileSync(filePath, 'utf-8');
    const currentHash = sha256(currentContent);

    // Watcher mutation with matching hash — not stale. No fields to
    // coerce, so watcher write-skip applies (file not rewritten).
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      body: 'Updated body.',
      source_content_hash: currentHash,
    }));

    // Not stale, so DB was updated (body changed)
    expect(result.file_written).toBe(false);
    const node = db.prepare('SELECT body FROM nodes WHERE id = ?').get(result.node_id) as { body: string };
    expect(node.body).toBe('Updated body.');
  });

  it('tool path ignores source_content_hash (not set)', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());

    // Tool path never sets source_content_hash — should always write
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'tool',
      node_id: created.node_id,
      body: 'Updated via tool.',
    }));

    expect(result.file_written).toBe(true);
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
