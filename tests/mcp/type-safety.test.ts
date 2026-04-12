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
