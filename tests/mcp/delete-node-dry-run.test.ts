import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  registerDeleteNode(fakeServer, db, writeLock, vaultPath);
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
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('delete-node dry_run', () => {
  it('dry_run: true returns preview with dry_run flag and does not delete', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'A.md',
      title: 'A', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id,
      dry_run: true,
      confirm: false,
      referencing_nodes_limit: 20,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.node_id).toBe(created.node_id);
    expect(result.data?.file_path).toBe('A.md');
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
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id,
      dry_run: true,
      confirm: true,
      referencing_nodes_limit: 20,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(existsSync(join(vaultPath, 'B.md'))).toBe(true);
  });

  it('dry_run omitted (default false): existing behavior unchanged', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'C.md',
      title: 'C', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    // confirm:false (with dry_run:false explicit) → existing preview shape, no dry_run field
    const previewResult = parseResult(await handler({
      node_id: created.node_id,
      dry_run: false,
      confirm: false,
      referencing_nodes_limit: 20,
    }));
    expect(previewResult.ok).toBe(true);
    expect(previewResult.data?.dry_run).toBeUndefined();
    expect(previewResult.data?.preview).toBe(true);

    // confirm:true → actual deletion
    const deleteResult = parseResult(await handler({
      node_id: created.node_id,
      dry_run: false,
      confirm: true,
      referencing_nodes_limit: 20,
    }));
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.data?.deleted).toBe(true);
    expect(existsSync(join(vaultPath, 'C.md'))).toBe(false);
  });
});
