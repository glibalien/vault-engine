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
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

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
  registerBatchMutate(fakeServer, db, writeLock, vaultPath);
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

  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('batch-mutate create uses schema default_directory', () => {
  it('no directory, schema has default_directory → file lands in schema dir', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'MyNote', types: ['note'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Notes/MyNote.md');
    expect(existsSync(join(vaultPath, 'Notes/MyNote.md'))).toBe(true);
  });

  it('explicit directory conflicting with schema default, no override → BATCH_FAILED', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Rogue', types: ['note'], directory: 'Somewhere' } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BATCH_FAILED');
    expect(result.error.message).toMatch(/routes to "Notes\/"/);
  });

  it('directory + override_default_directory=true → lands in explicit directory', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Rogue', types: ['note'], directory: 'Somewhere', override_default_directory: true } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Somewhere/Rogue.md');
  });

  it('deprecated path alias alone → succeeds with DEPRECATED_PARAM warning', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'LegacyCall', types: ['bare'], path: 'Inbox' } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Inbox/LegacyCall.md');
    const deprecation = (result.warnings as Array<{ code: string }>).find(w => w.code === 'DEPRECATED_PARAM');
    expect(deprecation).toBeDefined();
  });

  it('both path and directory → BATCH_FAILED', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Conflict', types: ['bare'], path: 'A', directory: 'B' } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BATCH_FAILED');
    expect(result.error.message).toMatch(/path.*directory|Do not supply both/);
  });

  it('bare type (no schema default), no directory → root', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Loose', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Loose.md');
  });
});
