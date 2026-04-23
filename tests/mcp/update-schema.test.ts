import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { createTempVault } from '../helpers/vault.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateSchema(fakeServer, db, { writeLock, vaultPath, syncLogger });
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);

  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed'],
  });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-schema structured validation errors', () => {
  it('claim-level UNKNOWN_FIELD surfaces VALIDATION_FAILED envelope with groups', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'does_not_exist' }],
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: unknown[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details?.groups).toBeDefined();
    const groups = err.details!.groups as Array<{ reason: string; field: string }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('UNKNOWN_FIELD');
    expect(groups[0].field).toBe('does_not_exist');
  });

  it('propagation ENUM_MISMATCH across multiple nodes surfaces aggregated group', async () => {
    for (const [i, v] of [['a', 'active'], ['b', 'active'], ['c', 'draft']]) {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: `${i}.md`,
        title: i.toUpperCase(),
        types: ['note'],
        fields: { status: v },
        body: '',
      });
    }

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'status', sort_order: 1 }],
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: unknown[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    const groups = err.details!.groups as Array<{
      reason: string;
      field: string;
      count: number;
      invalid_values?: Array<{ value: string; count: number }>;
    }>;
    const enumGroup = groups.find(g => g.reason === 'ENUM_INVALID');
    expect(enumGroup).toBeDefined();
    expect(enumGroup!.count).toBe(3);
    expect(enumGroup!.invalid_values).toEqual([
      { value: 'active', count: 2 },
      { value: 'draft', count: 1 },
    ]);
  });

  it('non-SchemaValidationError still funnels through INVALID_PARAMS', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'does_not_exist',
      display_name: 'x',
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain("'does_not_exist' not found");
  });
});

describe('update-schema dry_run', () => {
  it('dry_run=true returns preview data without committing the change', async () => {
    // Reset default fixtures: we want a string field with a default, not the enum one.
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'open', required: true });
    // Create a task schema and node (note schema already created in beforeEach).
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'a.md',
      title: 'A',
      types: ['task'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'priority' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    const data = (result as { data: { claims_added: string[]; propagation: { defaults_populated: number } } }).data;
    expect(data.claims_added).toEqual(['priority']);
    expect(data.propagation.defaults_populated).toBe(1);

    // Assert no commit happened — no claims persisted.
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toEqual([]);
  });

  it('dry_run=true with claim-level failure returns ok:false with groups + preview data in error.details', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'nonexistent' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details: { groups: Array<{ reason: string }>; claims_added: string[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details.groups.some(g => g.reason === 'UNKNOWN_FIELD')).toBe(true);
    expect(err.details.claims_added).toEqual(['nonexistent']);
  });

  it('commit path (no dry_run) still works — single claim add persists + default populated', async () => {
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'a.md',
      title: 'A',
      types: ['task'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'priority' }],
    }));

    expect(result.ok).toBe(true);

    // Claim persisted.
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['priority']);

    // Node got the default value.
    const field = db.prepare('SELECT value_text FROM node_fields WHERE field_name = ?').get('priority') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('open');
  });
});

describe('update-schema confirm_large_change gate', () => {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function createNode(overrides: { file_path: string; title: string; types: string[]; fields?: Record<string, unknown> }) {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: overrides.file_path,
      title: overrides.title,
      types: overrides.types,
      fields: overrides.fields ?? {},
      body: '',
    });
  }

  beforeEach(() => {
    // Replace the enum `status` created by the outer beforeEach with a string field.
    db.prepare('DELETE FROM global_fields').run();
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    handler = getHandler();
  });

  it('orphan-producing change without confirm_large_change returns CONFIRMATION_REQUIRED', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
    }));

    expect(result.ok).toBe(false);
    expect((result as { error?: { code: string } }).error?.code).toBe('CONFIRMATION_REQUIRED');
    const details = (result as { error: { details: {
      orphaned_field_names: Array<{ field: string; count: number }>;
      propagation: { fields_orphaned: number };
      claims_removed: string[];
    } } }).error.details;
    expect(details.orphaned_field_names).toEqual([{ field: 'status', count: 1 }]);
    expect(details.claims_removed).toEqual(['status']);
    expect(details.propagation.fields_orphaned).toBe(1);

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toHaveLength(1);
  });

  it('same change with confirm_large_change=true succeeds', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      confirm_large_change: true,
    }));

    expect(result.ok).toBe(true);
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toHaveLength(0);
  });

  it('change with zero orphans succeeds without confirm_large_change', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }],
    }));

    expect(result.ok).toBe(true);
  });

  it('dry_run with orphans does not trigger the gate — preview returns normally', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect((result as { data: { propagation: { fields_orphaned: number } } }).data.propagation.fields_orphaned).toBe(1);
  });
});
