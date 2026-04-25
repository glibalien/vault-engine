import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { executeMutation } from '../../src/pipeline/execute.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let server: McpServer;

interface Response {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings: Array<{ code: string; message: string; severity?: string }>;
}

// The MCP SDK handler does not run Zod parsing when called directly, so we
// must supply all params that have defaults explicitly. referencing_nodes_limit
// defaults to 20 in the schema — pass it here so the SQL LIMIT is always a
// number, not undefined.
async function callTool(name: string, args: Record<string, unknown>): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const raw = await tool.handler(args) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(raw.content[0].text) as Response;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();
  server = new McpServer({ name: 'test', version: '0' });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  registerDeleteNode(server, db, writeLock, vaultPath);
});

afterEach(() => { db.close(); cleanup(); });

describe('delete-node dry_run', () => {
  it('dry_run: true returns preview with dry_run flag and does not delete', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'A.md',
      title: 'A', types: ['note'], fields: {}, body: '',
    });
    const result = await callTool('delete-node', {
      node_id: created.node_id,
      dry_run: true,
      confirm: false,
      referencing_nodes_limit: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.node_id).toBe(created.node_id);
    expect(result.data?.file_path).toBe('A.md');
    // Side-effect checks: file present, DB row present, no undo op recorded.
    expect(existsSync(join(vaultPath, 'A.md'))).toBe(true);
    const dbRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(created.node_id);
    expect(dbRow).toBeDefined();
    const undoRows = db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number };
    expect(undoRows.c).toBe(0);
  });

  it('dry_run: true wins over confirm: true (still previews)', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'B.md',
      title: 'B', types: ['note'], fields: {}, body: '',
    });
    const result = await callTool('delete-node', {
      node_id: created.node_id,
      dry_run: true,
      confirm: true,
      referencing_nodes_limit: 20,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(existsSync(join(vaultPath, 'B.md'))).toBe(true);
  });

  it('dry_run omitted (default false): existing behavior unchanged', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'C.md',
      title: 'C', types: ['note'], fields: {}, body: '',
    });
    // confirm:false → existing preview shape (no dry_run field)
    const previewResult = await callTool('delete-node', {
      node_id: created.node_id,
      confirm: false,
      referencing_nodes_limit: 20,
    });
    expect(previewResult.ok).toBe(true);
    expect(previewResult.data?.dry_run).toBeUndefined();
    expect(previewResult.data?.preview).toBe(true);

    // confirm:true → actual deletion
    const deleteResult = await callTool('delete-node', {
      node_id: created.node_id,
      confirm: true,
      referencing_nodes_limit: 20,
    });
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.data?.deleted).toBe(true);
    expect(existsSync(join(vaultPath, 'C.md'))).toBe(false);
  });
});
