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
    expect(result.ok).toBe(true);
    expect(result.data.node_id).toBeDefined();
  });

  it('succeeds with empty types', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Typeless', types: [], fields: {}, body: '' }) as any);
    expect(result.ok).toBe(true);
    expect(result.data.node_id).toBeDefined();
  });

  it('rejects unknown type with UNKNOWN_TYPE error', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Bad', types: ['reference'], fields: {}, body: '' }) as any);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TYPE');
    expect(result.error.details.unknown_types).toEqual(['reference']);
    expect(result.error.details.available_schemas).toContain('note');
    expect(result.error.details.available_schemas).toContain('task');
    // Verify no file was created
    expect(existsSync(join(vaultPath, 'Bad.md'))).toBe(false);
  });

  it('rejects mixed valid/unknown types, lists only unknown', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Mixed', types: ['note', 'reference'], fields: {}, body: '' }) as any);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TYPE');
    expect(result.error.details.unknown_types).toEqual(['reference']);
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
    expect(result.ok).toBe(true);
    expect(result.data.dry_run).toBe(true);
    expect(result.data.would_create.file_path).toBe('Notes/Preview Note.md');
    expect(result.data.would_create.types).toEqual(['note']);
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
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TYPE');
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
    expect(result.ok).toBe(true);
    expect(result.data.dry_run).toBe(true);
    expect(result.data.would_create.conflict).toBeDefined();
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
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TYPE');
    expect(result.error.details.unknown_types).toEqual(['reference']);
  });

  it('allows set_types with valid types', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_types: ['task'],
    }) as any);
    expect(result.ok).toBe(true);
    expect(result.data.types).toEqual(['task']);
  });

  it('does not check types when set_types is absent', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_fields: { project: 'X' },
    }) as any);
    expect(result.ok).toBe(true);
  });

  it('dry_run in single-node mode returns preview without writing', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_fields: { project: 'Preview' },
      dry_run: true,
    }) as any);
    expect(result.ok).toBe(true);
    expect(result.data.dry_run).toBe(true);
    expect(result.data.preview).toBeDefined();
    // Verify DB was not mutated
    const fields = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(seed.node_id, 'project') as { value_text: string } | undefined;
    expect(fields).toBeUndefined(); // project field was not written
  });

  it('applies add_types in single-node mode', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      add_types: ['task'],
    }) as any);
    expect(result.ok).toBe(true);
    expect(result.data.types).toEqual(expect.arrayContaining(['note', 'task']));
    // Verify DB was mutated
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(seed.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types).toEqual(expect.arrayContaining(['note', 'task']));
  });

  it('applies remove_types in single-node mode', async () => {
    // Create a node with two types
    const seed = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'multi.md',
      title: 'Multi',
      types: ['note', 'task'],
      fields: {},
      body: '',
    });
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      remove_types: ['task'],
    }) as any);
    expect(result.ok).toBe(true);
    expect(result.data.types).toEqual(['note']);
  });

  it('applies add_types + remove_types together in single-node mode', async () => {
    const seed = createSeedNode(); // has ['note']
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      add_types: ['task'],
      remove_types: ['note'],
    }) as any);
    expect(result.ok).toBe(true);
    expect(result.data.types).toEqual(['task']);
  });

  it('rejects unknown type in single-node add_types', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      add_types: ['reference'],
    }) as any);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TYPE');
    expect(result.error.details.unknown_types).toEqual(['reference']);
  });

  it('rejects unknown type in query mode add_types', async () => {
    createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['reference'],
    }) as any);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('UNKNOWN_TYPE');
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

// ── batch-mutate update operations ─────────────────────────────────

describe('batch-mutate update operations', () => {
  it('append_body appends to existing body', async () => {
    // Create a node first
    const createHandler = getToolHandler(registerCreateNode);
    const created = parseResult(await createHandler({
      title: 'Append Target',
      types: ['note'],
      body: 'Original content',
    }) as any);
    expect(created.ok).toBe(true);
    expect(created.data.node_id).toBeDefined();

    // Now batch-mutate with append_body
    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'update', params: { title: 'Append Target', append_body: 'Appended section' } },
      ],
    }) as any);
    expect(result.applied).toBe(true);

    // Verify the body was appended
    const row = db.prepare('SELECT body FROM nodes WHERE title = ?').get('Append Target') as { body: string };
    expect(row.body).toBe('Original content\n\nAppended section');
  });

  it('append_body on empty body sets body directly', async () => {
    const createHandler = getToolHandler(registerCreateNode);
    await createHandler({ title: 'Empty Body', types: ['note'], body: '' });

    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'update', params: { title: 'Empty Body', append_body: 'First content' } },
      ],
    }) as any);
    expect(result.applied).toBe(true);

    const row = db.prepare('SELECT body FROM nodes WHERE title = ?').get('Empty Body') as { body: string };
    expect(row.body).toBe('First content');
  });

  it('rejects set_body and append_body together', async () => {
    const createHandler = getToolHandler(registerCreateNode);
    await createHandler({ title: 'Both Body', types: ['note'], body: '' });

    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'update', params: { title: 'Both Body', set_body: 'A', append_body: 'B' } },
      ],
    }) as any);
    expect(result.applied).toBe(false);
    expect(result.error.message).toContain('mutually exclusive');
  });

  it('add_types appends types without replacing', async () => {
    const createHandler = getToolHandler(registerCreateNode);
    await createHandler({ title: 'Type Target', types: ['note'], body: '' });

    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'update', params: { title: 'Type Target', add_types: ['task'] } },
      ],
    }) as any);
    expect(result.applied).toBe(true);

    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE title = ?)').all('Type Target') as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types).toContain('note');
    expect(types).toContain('task');
  });

  it('remove_types removes without replacing', async () => {
    // Create with two types
    const createHandler = getToolHandler(registerCreateNode);
    await createHandler({ title: 'Remove Target', types: ['note'], body: '' });

    // Add task type
    const handler = getToolHandler(registerBatchMutate);
    await handler({
      operations: [
        { op: 'update', params: { title: 'Remove Target', add_types: ['task'] } },
      ],
    });

    // Now remove note
    const result = parseResult(await handler({
      operations: [
        { op: 'update', params: { title: 'Remove Target', remove_types: ['note'] } },
      ],
    }) as any);
    expect(result.applied).toBe(true);

    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE title = ?)').all('Remove Target') as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types).toEqual(['task']);
  });

  it('create + append_body update in same batch', async () => {
    // Create a target node to append to
    const createHandler = getToolHandler(registerCreateNode);
    await createHandler({ title: 'Daily Note', types: ['note'], body: '## Morning' });

    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'New Clipping', types: ['note'], body: 'Article text' } },
        { op: 'update', params: { title: 'Daily Note', append_body: '## Reading\n- [[New Clipping]]' } },
      ],
    }) as any);
    expect(result.applied).toBe(true);
    expect(result.results).toHaveLength(2);

    const row = db.prepare('SELECT body FROM nodes WHERE title = ?').get('Daily Note') as { body: string };
    expect(row.body).toBe('## Morning\n\n## Reading\n- [[New Clipping]]');
  });

  // Note: unrecognized params are rejected by Zod .strict() at the MCP transport
  // layer, which the test harness (fake server) bypasses. Production calls with
  // bogus params will get a Zod validation error before reaching the handler.
});

// ── watcher path stays permissive ────────────────────────────────────

describe('watcher path stays permissive', () => {
  it('accepts unschematized types on watcher source', () => {
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: null,
      file_path: 'watcher-node.md',
      title: 'Watcher Node',
      types: ['nonexistent_type'],
      fields: {},
      body: '',
    });
    expect(result.node_id).toBeDefined();
    expect(existsSync(join(vaultPath, 'watcher-node.md'))).toBe(true);
  });
});
