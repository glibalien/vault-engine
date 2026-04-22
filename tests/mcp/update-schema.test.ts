import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

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
  registerUpdateSchema(fakeServer, db, { writeLock, vaultPath });
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();

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
