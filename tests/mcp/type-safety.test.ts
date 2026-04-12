// tests/mcp/type-safety.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { executeMutation } from '../../src/pipeline/execute.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(
  registerFn: (server: McpServer, db: Database.Database, writeLock: WriteLockManager, vaultPath: string) => void,
) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db, writeLock, vaultPath);
  return capturedHandler!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();

  // Set up schemas
  createGlobalField(db, { name: 'project', field_type: 'string' });
  createSchemaDefinition(db, {
    name: 'note',
    field_claims: [{ field: 'project' }],
    default_directory: 'Notes',
  });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

// ── create-node type enforcement ─────────────────────────────────────

describe('create-node type enforcement', () => {
  it('succeeds with valid types', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Test', types: ['note'], fields: {}, body: '' }) as any);
    expect(result.node_id).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('succeeds with empty types', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Typeless', types: [], fields: {}, body: '' }) as any);
    expect(result.node_id).toBeDefined();
  });

  it('rejects unknown type with UNKNOWN_TYPE error', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Bad', types: ['reference'], fields: {}, body: '' }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
    expect(result.available_schemas).toContain('note');
    expect(result.available_schemas).toContain('task');
    // Verify no file was created
    expect(existsSync(join(vaultPath, 'Bad.md'))).toBe(false);
  });

  it('rejects mixed valid/unknown types, lists only unknown', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Mixed', types: ['note', 'reference'], fields: {}, body: '' }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
  });
});

// ── create-node dry_run ──────────────────────────────────────────────

describe('create-node dry_run', () => {
  it('returns preview without writing when dry_run is true', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({
      title: 'Preview Note',
      types: ['note'],
      fields: { project: 'Test' },
      body: '',
      dry_run: true,
    }) as any);
    expect(result.dry_run).toBe(true);
    expect(result.would_create.file_path).toBe('Notes/Preview Note.md');
    expect(result.would_create.types).toEqual(['note']);
    // Verify nothing was written
    expect(existsSync(join(vaultPath, 'Notes/Preview Note.md'))).toBe(false);
    const dbNode = db.prepare('SELECT id FROM nodes WHERE title = ?').get('Preview Note');
    expect(dbNode).toBeUndefined();
  });

  it('rejects invalid type on dry_run', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({
      title: 'Bad Dry',
      types: ['reference'],
      fields: {},
      body: '',
      dry_run: true,
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
  });

  it('reports path conflict on dry_run', async () => {
    // Create an existing node first
    const handler = getToolHandler(registerCreateNode);
    await handler({ title: 'Existing', types: ['note'], fields: {}, body: '' });
    // Now dry_run with same path
    const result = parseResult(await handler({
      title: 'Existing',
      types: ['note'],
      fields: {},
      body: '',
      dry_run: true,
    }) as any);
    expect(result.dry_run).toBe(true);
    expect(result.would_create.conflict).toBeDefined();
  });
});

// ── update-node type enforcement ─────────────────────────────────────

describe('update-node type enforcement', () => {
  function createSeedNode() {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'seed.md',
      title: 'Seed',
      types: ['note'],
      fields: {},
      body: '',
    });
  }

  it('rejects set_types with unknown type', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_types: ['reference'],
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
  });

  it('allows set_types with valid types', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_types: ['task'],
    }) as any);
    expect(result.error).toBeUndefined();
    expect(result.types).toEqual(['task']);
  });

  it('does not check types when set_types is absent', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_fields: { project: 'X' },
    }) as any);
    expect(result.error).toBeUndefined();
  });

  it('dry_run in single-node mode returns preview without writing', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_fields: { project: 'Preview' },
      dry_run: true,
    }) as any);
    expect(result.dry_run).toBe(true);
    expect(result.preview).toBeDefined();
    // Verify DB was not mutated
    const fields = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(seed.node_id, 'project') as { value_text: string } | undefined;
    expect(fields).toBeUndefined(); // project field was not written
  });

  it('rejects unknown type in query mode add_types', async () => {
    createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['reference'],
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
  });
});

// ── add-type-to-node type enforcement ────────────────────────────────

describe('add-type-to-node type enforcement', () => {
  function createSeedNode() {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'seed2.md',
      title: 'Seed2',
      types: ['note'],
      fields: {},
      body: '',
    });
  }

  it('rejects unknown type', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerAddTypeToNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      type: 'reference',
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
  });

  it('allows valid type', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerAddTypeToNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      type: 'task',
    }) as any);
    expect(result.error).toBeUndefined();
    expect(result.types).toContain('task');
  });
});

// ── batch-mutate type enforcement ────────────────────────────────────

describe('batch-mutate type enforcement', () => {
  it('rolls back entire batch when one op has unknown type', async () => {
    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'Good', types: ['note'], fields: {}, body: '' } },
        { op: 'create', params: { title: 'Bad', types: ['reference'], fields: {}, body: '' } },
      ],
    }) as any);
    expect(result.applied).toBe(false);
    expect(result.error.message).toContain('reference');
    // First op should have been rolled back
    const node = db.prepare('SELECT id FROM nodes WHERE title = ?').get('Good');
    expect(node).toBeUndefined();
    expect(existsSync(join(vaultPath, 'Good.md'))).toBe(false);
  });

  it('succeeds when all ops have valid types', async () => {
    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'One', types: ['note'], fields: {}, body: '' } },
        { op: 'create', params: { title: 'Two', types: ['task'], fields: {}, body: '' } },
      ],
    }) as any);
    expect(result.applied).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});
