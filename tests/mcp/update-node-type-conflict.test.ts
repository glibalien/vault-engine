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

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
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
  fields?: Record<string, unknown>;
  body?: string;
}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: overrides.file_path,
    title: overrides.title,
    types: overrides.types ?? [],
    fields: overrides.fields ?? {},
    body: overrides.body ?? '',
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

  handler = captureHandler();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node type-op conflict', () => {
  it('emits TYPE_OP_CONFLICT issue when set_types combined with add_types', async () => {
    createNode({ file_path: 'a.md', title: 'A', types: ['note'] });

    const result = await handler({
      file_path: 'a.md',
      set_types: ['task'],
      add_types: ['note'],
      dry_run: true,
    });

    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const warnings = body.warnings as Array<{ code: string; message: string }>;
    const conflict = warnings.find((i) => i.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict!.message).toMatch(/set_types/);
  });

  it('emits TYPE_OP_CONFLICT issue when set_types combined with remove_types', async () => {
    createNode({ file_path: 'b.md', title: 'B', types: ['note', 'task'] });

    const result = await handler({
      file_path: 'b.md',
      set_types: ['task'],
      remove_types: ['note'],
      dry_run: true,
    });

    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const warnings = body.warnings as Array<{ code: string; message: string }>;
    const conflict = warnings.find((i) => i.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict!.message).toMatch(/set_types/);
  });

  it('does not emit TYPE_OP_CONFLICT when only set_types is provided', async () => {
    createNode({ file_path: 'c.md', title: 'C', types: ['note'] });

    const result = await handler({
      file_path: 'c.md',
      set_types: ['task'],
      dry_run: true,
    });

    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const warnings = body.warnings as Array<{ code: string; message: string }>;
    expect(warnings.find((i) => i.code === 'TYPE_OP_CONFLICT')).toBeUndefined();
  });

  it('does not emit TYPE_OP_CONFLICT when only add_types is provided', async () => {
    createNode({ file_path: 'd.md', title: 'D', types: ['note'] });

    const result = await handler({
      file_path: 'd.md',
      add_types: ['task'],
      dry_run: true,
    });

    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const warnings = body.warnings as Array<{ code: string; message: string }>;
    expect(warnings.find((i) => i.code === 'TYPE_OP_CONFLICT')).toBeUndefined();
  });

  it('emits TYPE_OP_CONFLICT on live (non-dry-run) write when set_types combined with add_types, and set_types wins', async () => {
    createNode({ file_path: 'e.md', title: 'E', types: ['note'] });

    const result = await handler({
      file_path: 'e.md',
      set_types: ['task'],
      add_types: ['note'],
      dry_run: false,
    });

    const body = parseResult(result);
    expect(body.ok).toBe(true);
    const warnings = body.warnings as Array<{ code: string; message: string }>;
    const conflict = warnings.find((i) => i.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict!.message).toMatch(/set_types/);

    // Verify set_types won: DB should have only 'task', not 'note'
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('e.md') as { id: number } | undefined;
    expect(node).toBeDefined();
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(node!.id) as Array<{ schema_type: string }>).map(r => r.schema_type);
    expect(types).toEqual(['task']);
  });

  it('returns INVALID_PARAMS when set_types is provided in query mode', async () => {
    createNode({ file_path: 'f.md', title: 'F', types: ['note'] });

    const result = await handler({
      query: { types: ['note'] },
      set_types: ['task'],
    });

    const body = parseResult(result);
    expect(body.ok).toBe(false);
    const error = body.error as { code: string; message: string };
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/set_types is not supported in query mode/);
  });
});
