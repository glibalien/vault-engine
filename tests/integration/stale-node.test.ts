import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: unknown): any {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler(registerFn: (server: McpServer) => void) {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerFn(fakeServer);
  return captured!;
}

function createNode(filePath = 'node.md', title = 'Node') {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: filePath,
    title,
    types: ['note'],
    fields: {},
    body: '',
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
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('stale-node end-to-end flow', () => {
  it('reads version, receives STALE_NODE on conflicting write, and retries with current_node', async () => {
    const created = createNode('conflict.md', 'Conflict');
    const getNode = getHandler(server => registerGetNode(server, db));
    const updateNode = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));

    const read = parseResult(await getNode({ node_id: created.node_id }));
    expect(read.ok).toBe(true);
    expect(read.data.version).toBe(1);

    const writerB = parseResult(await updateNode({
      node_id: created.node_id,
      set_body: 'writer B edit',
      expected_version: 1,
    }));
    expect(writerB.ok).toBe(true);

    const stale = parseResult(await updateNode({
      node_id: created.node_id,
      set_body: 'writer A stale edit',
      expected_version: read.data.version,
    }));
    expect(stale.ok).toBe(false);
    expect(stale.error.code).toBe('STALE_NODE');
    expect(stale.error.details.current_version).toBe(2);
    expect(stale.error.details.expected_version).toBe(1);
    expect(stale.error.details.current_node.body).toBe('writer B edit');

    const retry = parseResult(await updateNode({
      node_id: created.node_id,
      set_body: 'writer A retry',
      expected_version: stale.error.details.current_version,
    }));
    expect(retry.ok).toBe(true);

    const finalRead = parseResult(await getNode({ node_id: created.node_id }));
    expect(finalRead.data.version).toBe(3);
    expect(finalRead.data.body).toBe('writer A retry');
  });

  it('handles delete-node staleness the same way', async () => {
    const created = createNode('delete-conflict.md', 'Delete Conflict');
    const updateNode = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
    const deleteNode = getHandler(server => registerDeleteNode(server, db, writeLock, vaultPath));

    const bumped = parseResult(await updateNode({
      node_id: created.node_id,
      set_body: 'newer edit',
      expected_version: 1,
    }));
    expect(bumped.ok).toBe(true);

    const staleDelete = parseResult(await deleteNode({
      node_id: created.node_id,
      confirm: true,
      referencing_nodes_limit: 20,
      expected_version: 1,
    }));
    expect(staleDelete.ok).toBe(false);
    expect(staleDelete.error.code).toBe('STALE_NODE');
    expect(staleDelete.error.details.current_node.id).toBe(created.node_id);
    expect(staleDelete.error.details.current_node.version).toBe(2);
  });

  it('rejects expected_version in update-node query mode', async () => {
    const updateNode = getHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
    const result = parseResult(await updateNode({
      query: { types: ['note'] },
      set_fields: { status: 'done' },
      expected_version: 1,
    }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PARAMS');
  });
});
