import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerRemoveTypeFromNode } from '../../src/mcp/tools/remove-type-from-node.js';
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
  registerRemoveTypeFromNode(fakeServer, db, writeLock, vaultPath);
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

afterEach(() => { db.close(); cleanup(); });

describe('remove-type-from-node dry_run', () => {
  it('dry_run: true on non-last-type returns preview without mutation', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    createSchemaDefinition(db, { name: 'b', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'X.md',
      title: 'X', types: ['a', 'b'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id, type: 'a',
      dry_run: true, confirm: false,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.current_types).toEqual(['a', 'b']);
    expect(result.data?.removing_type).toBe('a');
    expect(result.data?.resulting_types).toEqual(['b']);
    // Live state unchanged
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(created.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types.sort()).toEqual(['a', 'b']);
  });

  it('dry_run: true wins over confirm: true (still previews, no mutation)', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    createSchemaDefinition(db, { name: 'b', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'W.md',
      title: 'W', types: ['a', 'b'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id, type: 'a',
      dry_run: true, confirm: true,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(created.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types.sort()).toEqual(['a', 'b']);
  });

  it('dry_run: true on last-type emits LAST_TYPE_REMOVAL warning', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Y.md',
      title: 'Y', types: ['a'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id, type: 'a',
      dry_run: true, confirm: false,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.warnings.some(w => w.code === 'LAST_TYPE_REMOVAL')).toBe(true);
  });

  it('dry_run: true does not record an undo operation', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    createSchemaDefinition(db, { name: 'b', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Z.md',
      title: 'Z', types: ['a', 'b'], fields: {}, body: '',
    });
    const handler = getHandler();
    await handler({
      node_id: created.node_id, type: 'a',
      dry_run: true, confirm: false,
    });
    const undoCount = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;
    expect(undoCount).toBe(0);
  });
});
