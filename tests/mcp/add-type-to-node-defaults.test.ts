import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
import { executeMutation } from '../../src/pipeline/execute.js';

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
  registerAddTypeToNode(fakeServer, db, writeLock, vaultPath);
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
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('add-type-to-node — field-defaulted edits-log emission', () => {
  it("emits field-defaulted with source='tool' and default_source='global' when no override", async () => {
    createGlobalField(db, {
      name: 'category',
      field_type: 'string',
      required: true,
      default_value: 'general',
    });
    createSchemaDefinition(db, {
      name: 'Doc',
      field_claims: [{ field: 'category' }],
    });

    // Create a node WITHOUT the type first (so add-type-to-node has work to do)
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'note.md',
      title: 'Note',
      types: [],
      fields: {},
      body: '',
    });
    const nodeId = result.node_id;

    const handler = getHandler();
    const response = parseResult(await handler({ node_id: nodeId, type: 'Doc' }));
    expect(response.ok).toBe(true);
    expect(response.data?.added_fields).toEqual(['category']);

    const row = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as { details: string };
    const details = JSON.parse(row.details);
    expect(details.source).toBe('tool');
    expect(details.field).toBe('category');
    expect(details.default_value).toBe('general');
    expect(details.default_source).toBe('global');
  });

  it("emits field-defaulted with default_source='claim' when the new type overrides", async () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      default_value: 'normal',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'Urgent',
      field_claims: [{ field: 'priority', default_value: 'high', default_value_overridden: true }],
    });

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'note.md',
      title: 'Note',
      types: [],
      fields: {},
      body: '',
    });
    const nodeId = result.node_id;

    const handler = getHandler();
    const response = parseResult(await handler({ node_id: nodeId, type: 'Urgent' }));
    expect(response.ok).toBe(true);

    const row = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as { details: string };
    const details = JSON.parse(row.details);
    expect(details.source).toBe('tool');
    expect(details.field).toBe('priority');
    expect(details.default_value).toBe('high');
    expect(details.default_source).toBe('claim');
  });

  it('does not emit field-defaulted for re-adopted orphan fields', async () => {
    createGlobalField(db, {
      name: 'tag',
      field_type: 'string',
      required: false,
    });
    createSchemaDefinition(db, {
      name: 'Tagged',
      field_claims: [{ field: 'tag' }],
    });

    // Create a node with 'tag' as orphan (no claiming type)
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'note.md',
      title: 'Note',
      types: [],
      fields: { tag: 'preexisting' },
      body: '',
    });
    const nodeId = result.node_id;

    const handler = getHandler();
    const response = parseResult(await handler({ node_id: nodeId, type: 'Tagged' }));
    expect(response.ok).toBe(true);
    expect(response.data?.readopted_fields).toEqual(['tag']);
    expect(response.data?.added_fields).toEqual([]);

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'"
    ).all(nodeId);
    expect(rows).toEqual([]);
  });
});
