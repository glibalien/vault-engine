import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createTempVault } from '../helpers/vault.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

interface QueryResponse {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings: Array<{ code: string; message: string; severity?: string; details?: unknown }>;
}

function parseResult(result: unknown): QueryResponse {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as QueryResponse;
}

function captureHandler() {
  let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, writeLock, vaultPath);
  return capturedHandler!;
}

function createNode(overrides: {
  file_path: string;
  title: string;
  types?: string[];
}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: overrides.file_path,
    title: overrides.title,
    types: overrides.types ?? [],
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
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
  createSchemaDefinition(db, { name: 'tag', field_claims: [] });

  handler = captureHandler();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node query mode — TYPE_OP_CONFLICT for already-present add_types', () => {
  it('emits TYPE_OP_CONFLICT (live) when at least one matched node already has a type in add_types', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note', 'tag'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'] });

    const body = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['tag'],
      dry_run: false,
    }));

    expect(body.ok).toBe(true);
    const conflict = body.warnings.find(w => w.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('warning');
    expect(conflict!.message).toMatch(/already/i);
  });

  it('emits TYPE_OP_CONFLICT (dry-run) when at least one matched node already has a type in add_types', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note', 'tag'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'] });

    const body = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['tag'],
      dry_run: true,
    }));

    expect(body.ok).toBe(true);
    const conflict = body.warnings.find(w => w.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('warning');
  });

  it('does NOT emit TYPE_OP_CONFLICT when no matched node has the add_types yet', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'] });

    const body = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['tag'],
      dry_run: false,
    }));

    expect(body.ok).toBe(true);
    expect(body.warnings.find(w => w.code === 'TYPE_OP_CONFLICT')).toBeUndefined();
  });

  it('does NOT emit TYPE_OP_CONFLICT when add_types is empty/absent', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });

    const body = parseResult(await handler({
      query: { types: ['note'] },
      remove_types: ['note'],
      dry_run: false,
    }));

    expect(body.ok).toBe(true);
    expect(body.warnings.find(w => w.code === 'TYPE_OP_CONFLICT')).toBeUndefined();
  });

  it('details include the count of (node, type) pairs that were already present', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note', 'tag'] });
    createNode({ file_path: 'b.md', title: 'B', types: ['note', 'tag'] });
    createNode({ file_path: 'c.md', title: 'C', types: ['note'] });

    const body = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['tag'],
      dry_run: false,
    }));

    expect(body.ok).toBe(true);
    const conflict = body.warnings.find(w => w.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    const details = conflict!.details as { count?: number } | undefined;
    expect(details?.count).toBe(2);
  });
});
