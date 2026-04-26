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

afterEach(() => { db.close(); cleanup(); });

describe('add-type-to-node dry_run', () => {
  it('dry_run: true returns preview with would_add_fields', async () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal', required: true });
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'T.md',
      title: 'T', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id, type: 'task', dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.would_be_no_op).toBe(false);
    expect(result.data?.types).toEqual(expect.arrayContaining(['note', 'task']));
    expect(result.data?.would_add_fields).toEqual(expect.objectContaining({ priority: 'normal' }));

    // Live state unchanged
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(created.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types).toEqual(['note']);
  });

  it('would_add_fields (dry-run) matches added_fields (live run) for the same op', async () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal', required: true });
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'P.md',
      title: 'P', types: ['note'], fields: {}, body: '',
    });

    const handler = getHandler();
    const dryResult = parseResult(await handler({
      node_id: created.node_id, type: 'task', dry_run: true,
    }));
    const liveResult = parseResult(await handler({
      node_id: created.node_id, type: 'task', dry_run: false,
    }));

    expect(dryResult.ok).toBe(true);
    expect(liveResult.ok).toBe(true);

    // The dry-run preview's would_add_fields keys should equal the live run's added_fields entries.
    const dryFields = Object.keys(dryResult.data?.would_add_fields as Record<string, unknown>).sort();
    const liveFields = ([...((liveResult.data?.added_fields as string[]) ?? [])]).sort();
    expect(dryFields).toEqual(liveFields);
  });

  it('dry_run: true on already-present type returns would_be_no_op: true', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'N.md',
      title: 'N', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({
      node_id: created.node_id, type: 'note', dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.would_be_no_op).toBe(true);
    expect(result.data?.types).toEqual(['note']);
  });

  it('dry_run: true does not record an undo operation', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'U.md',
      title: 'U', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    await handler({
      node_id: created.node_id, type: 'task', dry_run: true,
    });
    const undoCount = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;
    expect(undoCount).toBe(0);
  });
});
