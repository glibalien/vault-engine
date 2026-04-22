import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: unknown): any {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerRenameNode(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'task', field_claims: [], default_directory: 'TaskNotes/Tasks' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('rename-node default-directory consistency for multi-typed nodes', () => {
  it('multi-typed [task, note] without directory param: stays in first-type dir (TaskNotes/Tasks)', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'TaskNotes/Tasks/Original.md',
      title: 'Original',
      types: ['task', 'note'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Original', new_title: 'Renamed' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('TaskNotes/Tasks/Renamed.md');
    expect(existsSync(join(vaultPath, 'TaskNotes/Tasks/Renamed.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/Renamed.md'))).toBe(false);
  });

  it('explicit directory wins over schema default', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'TaskNotes/Tasks/Another.md',
      title: 'Another',
      types: ['task'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Another', new_title: 'Moved', directory: 'Archive' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('Archive/Moved.md');
  });

  it('single-typed node: unchanged behavior — falls into schema default dir', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Elsewhere/Solo.md',
      title: 'Solo',
      types: ['note'],
      fields: {},
      body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Solo', new_title: 'Solo2' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('Notes/Solo2.md');
  });

  it('node with no type-schema default preserves current directory', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Inbox/Untyped.md',
      title: 'Untyped',
      types: ['bare'],
      fields: {},
      body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Untyped', new_title: 'UntypedNew' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('Inbox/UntypedNew.md');
  });
});
