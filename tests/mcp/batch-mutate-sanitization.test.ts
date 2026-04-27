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

interface BatchResponse {
  ok: boolean;
  data?: {
    results: Array<{ file_path: string; node_id?: string }>;
    [k: string]: unknown;
  };
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity?: string; details?: unknown }>;
}

function parseResult(result: unknown): BatchResponse {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as BatchResponse;
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

  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('batch-mutate create title sanitization', () => {
  it('sanitizes forward slash in title and emits TITLE_FILENAME_SANITIZED', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Meeting/Notes', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    // File should be a single sanitized file at root, NOT a subdirectory.
    expect(result.data?.results[0].file_path).toBe('Meeting-Notes.md');
    expect(existsSync(join(vaultPath, 'Meeting-Notes.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Meeting/Notes.md'))).toBe(false);
    const sanitized = result.warnings.find(w => w.code === 'TITLE_FILENAME_SANITIZED');
    expect(sanitized).toBeDefined();
    expect(sanitized!.severity).toBe('warning');
  });

  it('sanitizes backslash in title', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'foo\\bar', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.results[0].file_path).toBe('foo-bar.md');
    expect(existsSync(join(vaultPath, 'foo-bar.md'))).toBe(true);
    const sanitized = result.warnings.find(w => w.code === 'TITLE_FILENAME_SANITIZED');
    expect(sanitized).toBeDefined();
  });

  it('does NOT emit TITLE_FILENAME_SANITIZED when title is clean', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'CleanTitle', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.results[0].file_path).toBe('CleanTitle.md');
    expect(result.warnings.find(w => w.code === 'TITLE_FILENAME_SANITIZED')).toBeUndefined();
  });

  it('emits TITLE_WIKILINK_UNSAFE when title contains brackets', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'foo[x]', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    const warning = result.warnings.find(w => w.code === 'TITLE_WIKILINK_UNSAFE');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('emits FRONTMATTER_IN_BODY when body starts with frontmatter delimiter', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Note', types: ['bare'], body: '---\nkey: value\n---\nbody' } }],
    }));
    expect(result.ok).toBe(true);
    const warning = result.warnings.find(w => w.code === 'FRONTMATTER_IN_BODY');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
  });

  it('dry_run path also surfaces sanitization warnings', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [{ op: 'create', params: { title: 'a/b', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    const sanitized = result.warnings.find(w => w.code === 'TITLE_FILENAME_SANITIZED');
    expect(sanitized).toBeDefined();
  });
});
