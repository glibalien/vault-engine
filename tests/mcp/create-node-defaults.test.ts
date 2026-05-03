import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface Response {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings: Array<{ code: string; message: string; severity?: string }>;
}

function parseResult(result: unknown): Response {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Response;
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerCreateNode(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('create-node — field-defaulted edits-log emission', () => {
  it("emits field-defaulted with source='tool' and default_source='global' when no override", async () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'string',
      required: true,
      default_value: 'open',
    });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status' }],
    });

    const handler = getHandler();
    const response = parseResult(await handler({ title: 'Demo', types: ['task'], fields: {} }));
    expect(response.ok).toBe(true);

    const nodeId = response.data?.node_id as string;
    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id ASC"
    ).all(nodeId) as Array<{ details: string }>;
    expect(rows).toHaveLength(1);

    const details = JSON.parse(rows[0].details);
    expect(details.source).toBe('tool');
    expect(details.field).toBe('status');
    expect(details.default_value).toBe('open');
    expect(details.default_source).toBe('global');
  });

  it("emits field-defaulted with default_source='claim' when the type overrides the default", async () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      default_value: 'normal',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'urgent',
      field_claims: [{ field: 'priority', default_value: 'high', default_value_overridden: true }],
    });

    const handler = getHandler();
    const response = parseResult(await handler({ title: 'Demo', types: ['urgent'], fields: {} }));
    expect(response.ok).toBe(true);

    const nodeId = response.data?.node_id as string;
    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id ASC"
    ).all(nodeId) as Array<{ details: string }>;
    expect(rows).toHaveLength(1);

    const details = JSON.parse(rows[0].details);
    expect(details.source).toBe('tool');
    expect(details.field).toBe('priority');
    expect(details.default_value).toBe('high');
    expect(details.default_source).toBe('claim');
  });
});
