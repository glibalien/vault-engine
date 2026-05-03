import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
import { registerRemoveTypeFromNode } from '../../src/mcp/tools/remove-type-from-node.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface ToolResult {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; details?: any };
  warnings: unknown[];
}

function parseResult(result: unknown): ToolResult {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as ToolResult;
}

function getHandler(registerFn: (server: McpServer) => void) {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
    registerTool: (_n: string, _c: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerFn(fakeServer);
  return captured!;
}

function createNode(filePath = 'node.md', title = 'Node', types: string[] = ['note']) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: filePath,
    title,
    types,
    fields: {},
    body: '',
  });
}

function bumpNode(nodeId: string, filePath: string, title = 'Node', types: string[] = ['note']) {
  executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: nodeId,
    file_path: filePath,
    title,
    types,
    fields: {},
    body: 'bump',
  });
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('single-node mutation expected_version', () => {
  it('update-node returns STALE_NODE when expected_version is stale', async () => {
    const created = createNode('update.md', 'Update Me');
    bumpNode(created.node_id, 'update.md', 'Update Me');
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));

    const response = parseResult(await handler({
      node_id: created.node_id,
      set_body: 'stale write',
      expected_version: 1,
    }));

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('STALE_NODE');
    expect(response.error?.details.current_version).toBe(2);
    expect(response.error?.details.expected_version).toBe(1);
    expect(response.error?.details.current_node.id).toBe(created.node_id);
    expect(response.error?.details.current_node.version).toBe(2);
  });

  it('update-node applies when expected_version matches and rejects query mode', async () => {
    const created = createNode('fresh.md', 'Fresh');
    const handler = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));

    const okResponse = parseResult(await handler({
      node_id: created.node_id,
      set_body: 'fresh write',
      expected_version: 1,
    }));
    expect(okResponse.ok).toBe(true);

    const queryResponse = parseResult(await handler({
      query: { types: ['note'] },
      set_fields: { status: 'done' },
      expected_version: 1,
    }));
    expect(queryResponse.ok).toBe(false);
    expect(queryResponse.error?.code).toBe('INVALID_PARAMS');
    expect(queryResponse.error?.message).toMatch(/expected_version/);
  });

  it('add-type-to-node returns STALE_NODE when stale', async () => {
    const created = createNode('add.md', 'Add Type');
    bumpNode(created.node_id, 'add.md', 'Add Type');
    const handler = getHandler(server => registerAddTypeToNode(server, db, writeLock, vaultPath));

    const response = parseResult(await handler({
      node_id: created.node_id,
      type: 'task',
      expected_version: 1,
    }));

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('STALE_NODE');
  });

  it('remove-type-from-node returns STALE_NODE when stale', async () => {
    const created = createNode('remove.md', 'Remove Type', ['note', 'task']);
    bumpNode(created.node_id, 'remove.md', 'Remove Type', ['note', 'task']);
    const handler = getHandler(server => registerRemoveTypeFromNode(server, db, writeLock, vaultPath));

    const response = parseResult(await handler({
      node_id: created.node_id,
      type: 'task',
      expected_version: 1,
    }));

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('STALE_NODE');
  });

  it('delete-node returns STALE_NODE when stale', async () => {
    const created = createNode('delete.md', 'Delete Me');
    bumpNode(created.node_id, 'delete.md', 'Delete Me');
    const handler = getHandler(server => registerDeleteNode(server, db, writeLock, vaultPath));

    const response = parseResult(await handler({
      node_id: created.node_id,
      confirm: true,
      referencing_nodes_limit: 20,
      expected_version: 1,
    }));

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('STALE_NODE');
  });

  it('rename-node returns STALE_NODE when stale', async () => {
    const created = createNode('rename.md', 'Rename Me');
    bumpNode(created.node_id, 'rename.md', 'Rename Me');
    const handler = getHandler(server => registerRenameNode(server, db, writeLock, vaultPath));

    const response = parseResult(await handler({
      node_id: created.node_id,
      new_title: 'Renamed',
      expected_version: 1,
    }));

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('STALE_NODE');
  });
});

describe('batch-mutate per-op expected_version', () => {
  it('reports per-op stale status and applies non-stale ops', async () => {
    const a = createNode('a.md', 'A');
    const b = createNode('b.md', 'B');
    const c = createNode('c.md', 'C');
    bumpNode(b.node_id, 'b.md', 'B');
    const handler = getHandler(server => registerBatchMutate(server, db, writeLock, vaultPath));

    const response = parseResult(await handler({
      operations: [
        { op: 'update', params: { node_id: a.node_id, set_body: 'fresh A', expected_version: 1 } },
        { op: 'update', params: { node_id: b.node_id, set_body: 'stale B', expected_version: 1 } },
        { op: 'update', params: { node_id: c.node_id, set_body: 'fresh C', expected_version: 1 } },
      ],
    }));

    expect(response.ok).toBe(true);
    expect(response.data.results).toHaveLength(3);
    expect(response.data.results[0]).toMatchObject({ op_index: 0, status: 'applied', node_id: a.node_id, new_version: 2 });
    expect(response.data.results[1].status).toBe('stale');
    expect(response.data.results[1].details.current_version).toBe(2);
    expect(response.data.results[1].details.current_node.id).toBe(b.node_id);
    expect(response.data.results[2]).toMatchObject({ op_index: 2, status: 'applied', node_id: c.node_id, new_version: 2 });
  });
});
