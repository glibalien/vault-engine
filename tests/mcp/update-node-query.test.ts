import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function captureHandler() {
  let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, writeLock, vaultPath);
  return capturedHandler!;
}

function createNode(overrides: {
  file_path: string;
  title: string;
  types?: string[];
  fields?: Record<string, unknown>;
  body?: string;
}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: overrides.file_path,
    title: overrides.title,
    types: overrides.types ?? [],
    fields: overrides.fields ?? {},
    body: overrides.body ?? '',
  });
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  handler = captureHandler();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node query mode — add_types', () => {
  it('adds type to all matched nodes', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'] });
    createNode({ file_path: 'c.md', title: 'C', types: ['task'] });

    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.dry_run).toBe(false);
    expect(result.matched).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);

    // Verify DB: both note nodes now have 'clippings' type
    const types = db.prepare("SELECT DISTINCT schema_type FROM node_types WHERE schema_type = 'clippings'").all() as Array<{ schema_type: string }>;
    expect(types.length).toBe(1);
    const clippingsCount = (db.prepare("SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = 'clippings'").get() as { cnt: number }).cnt;
    expect(clippingsCount).toBe(2);
  });

  it('skips nodes that already have the type', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note', 'clippings'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'] });

    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.matched).toBe(2);
    // Node A already has clippings, so it's a no-op
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

describe('update-node query mode — remove_types', () => {
  it('removes type from matched nodes', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note', 'clippings'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note', 'clippings'] });

    const result = parseResult(await handler({
      query: { types: ['note'] },
      remove_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.matched).toBe(2);
    expect(result.updated).toBe(2);

    // Verify clippings type removed
    const clippingsCount = (db.prepare("SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = 'clippings'").get() as { cnt: number }).cnt;
    expect(clippingsCount).toBe(0);
  });
});

describe('update-node query mode — without_types filter + add_types', () => {
  it('filters by without_types and adds type', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note', 'clippings'] });
    createNode({ file_path: 'c.md', title: 'C', types: ['note'] });

    const result = parseResult(await handler({
      query: { types: ['note'], without_types: ['clippings'] },
      add_types: ['clippings'],
      dry_run: false,
    }));

    // Only A and C matched (B has clippings, excluded by without_types)
    expect(result.matched).toBe(2);
    expect(result.updated).toBe(2);

    // All three note nodes now have clippings
    const clippingsCount = (db.prepare("SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = 'clippings'").get() as { cnt: number }).cnt;
    expect(clippingsCount).toBe(3);
  });
});

describe('update-node query mode — dry_run', () => {
  it('defaults dry_run to true in query mode (no changes made)', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });

    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['clippings'],
      // dry_run not specified — should default to true
    }));

    expect(result.dry_run).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.would_update).toBe(1);

    // Verify no actual change
    const clippingsCount = (db.prepare("SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = 'clippings'").get() as { cnt: number }).cnt;
    expect(clippingsCount).toBe(0);
  });

  it('preview returns per-node diffs with types_added', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'] });

    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['clippings'],
      dry_run: true,
    }));

    expect(result.dry_run).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.would_update).toBe(2);
    expect(result.would_skip).toBe(0);
    expect(result.would_fail).toBe(0);
    expect(result.batch_id).toBeTruthy();

    const preview = result.preview as Array<{ node_id: string; file_path: string; title: string; changes: { types_added: string[]; types_removed: string[]; fields_set: Record<string, unknown>; would_fail: boolean } }>;
    expect(preview.length).toBe(2);
    for (const p of preview) {
      expect(p.changes.types_added).toEqual(['clippings']);
      expect(p.changes.types_removed).toEqual([]);
      expect(p.changes.would_fail).toBe(false);
    }
  });
});

describe('update-node query mode — best-effort', () => {
  it('continues past validation errors', async () => {
    // Create a field with enum constraint
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], required: true });
    createSchemaDefinition(db, { name: 'strict', field_claims: [{ field: 'status' }] });

    // Create nodes: one strict (requires valid enum), one plain
    createNode({ file_path: 'strict.md', title: 'Strict', types: ['strict'], fields: { status: 'open' } });
    createNode({ file_path: 'plain.md', title: 'Plain', types: [] });

    // Set status to invalid value across all nodes. The strict node will fail validation.
    const result = parseResult(await handler({
      query: {},
      set_fields: { status: 'invalid-value' },
      dry_run: false,
    }));

    // We expect: strict node errors, plain node succeeds
    expect(result.dry_run).toBe(false);
    // matched includes all nodes in DB (including any from fixture vault)
    const matched = result.matched as number;
    expect(matched).toBeGreaterThanOrEqual(2);

    const errors = result.errors as Array<{ node_id: string; error: string }>;
    // At least the strict node should have errored
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some(e => e.file_path === 'strict.md')).toBe(true);

    // The non-strict node should have been updated despite the error on strict
    const updated = result.updated as number;
    expect(updated).toBeGreaterThanOrEqual(1);
  });
});

describe('update-node query mode — batch size guard', () => {
  it('accepts confirm_large_batch param (guard logic)', async () => {
    // We can't easily create >1000 nodes in a test, but we can verify
    // the param is accepted and doesn't error when not needed
    const result = parseResult(await handler({
      query: { types: ['nonexistent'] },
      add_types: ['tag'],
      dry_run: false,
      confirm_large_batch: true,
    }));

    expect(result.matched).toBe(0);
    expect(result.updated).toBe(0);
  });
});

describe('update-node query mode — set_fields', () => {
  it('patches fields with merge semantics', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: [], fields: { color: 'red', size: 'large' } });

    const result = parseResult(await handler({
      query: { path_prefix: 'a.md' },
      set_fields: { color: 'blue', shape: 'round' },
      dry_run: false,
    }));

    expect(result.updated).toBe(1);

    // Verify DB: color changed, size preserved, shape added
    const fields = db.prepare('SELECT field_name, value_text FROM node_fields WHERE node_id = (SELECT id FROM nodes WHERE file_path = ?)').all('a.md') as Array<{ field_name: string; value_text: string }>;
    const fieldMap = Object.fromEntries(fields.map(f => [f.field_name, f.value_text]));
    expect(fieldMap.color).toBe('blue');
    expect(fieldMap.size).toBe('large');
    expect(fieldMap.shape).toBe('round');
  });

  it('null removes a field', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: [], fields: { color: 'red', size: 'large' } });

    const result = parseResult(await handler({
      query: { path_prefix: 'a.md' },
      set_fields: { color: null },
      dry_run: false,
    }));

    expect(result.updated).toBe(1);

    // Verify DB: color removed, size preserved
    const fields = db.prepare('SELECT field_name FROM node_fields WHERE node_id = (SELECT id FROM nodes WHERE file_path = ?)').all('a.md') as Array<{ field_name: string }>;
    const names = fields.map(f => f.field_name);
    expect(names).not.toContain('color');
    expect(names).toContain('size');
  });
});

describe('update-node query mode — requires operation', () => {
  it('errors when no operation provided', async () => {
    const result = parseResult(await handler({
      query: { types: ['note'] },
    }));

    expect(result.error).toContain('requires at least one operation');
  });
});

describe('update-node query mode — set_path', () => {
  it('rejects set_path in single-node mode', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: [] });

    const result = parseResult(await handler({
      title: 'A',
      set_path: 'Persons',
    }));

    expect(result.error).toContain('rename-node');
  });
});

describe('update-node query mode — edits_log', () => {
  it('writes bulk-mutate entries with batch_id', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });

    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.batch_id).toBeTruthy();

    const logs = db.prepare("SELECT details FROM edits_log WHERE event_type = 'bulk-mutate'").all() as Array<{ details: string }>;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(logs[0].details);
    expect(details.batch_id).toBe(result.batch_id);
  });
});
