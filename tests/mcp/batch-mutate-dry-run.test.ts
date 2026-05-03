import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
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
  warnings: Array<{ code: string; message: string; severity?: string }>;
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
  addUiHints(db);
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('batch-mutate dry_run', () => {
  it('dry_run: true returns would_apply with create/update/delete entries and applies nothing', async () => {
    // Pre-existing nodes for the update + delete ops
    const existingForUpdate = await (async () => {
      const r = parseResult(await getHandler()({
        operations: [{ op: 'create', params: { title: 'Existing', types: ['note'] } }],
      }));
      expect(r.ok).toBe(true);
      return r.data!.results[0];
    })();
    const existingForDelete = await (async () => {
      const r = parseResult(await getHandler()({
        operations: [{ op: 'create', params: { title: 'ToDelete', types: ['note'] } }],
      }));
      expect(r.ok).toBe(true);
      return r.data!.results[0];
    })();

    // Capture pre-state
    const fileMtimeBefore = statSync(join(vaultPath, existingForUpdate.file_path)).mtimeMs;
    const undoCountBefore = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;

    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'NewNote', types: ['note'] } },
        { op: 'update', params: { node_id: existingForUpdate.node_id, set_body: 'changed' } },
        { op: 'delete', params: { node_id: existingForDelete.node_id } },
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.op_count).toBe(3);
    const wouldApply = result.data?.would_apply as Array<Record<string, unknown>>;
    expect(wouldApply).toHaveLength(3);
    expect(wouldApply[0].op).toBe('create');
    expect(wouldApply[0].file_path).toBe('Notes/NewNote.md');
    expect(wouldApply[0].title).toBe('NewNote');
    expect(wouldApply[1].op).toBe('update');
    expect(wouldApply[1].body_changed).toBe(true);
    expect(wouldApply[2].op).toBe('delete');
    expect(wouldApply[2].node_id).toBe(existingForDelete.node_id);

    // Side-effect checks: no new file, existing file unchanged, deleted file present, no undo op recorded.
    expect(existsSync(join(vaultPath, 'Notes/NewNote.md'))).toBe(false);
    const fileMtimeAfter = statSync(join(vaultPath, existingForUpdate.file_path)).mtimeMs;
    expect(fileMtimeAfter).toBe(fileMtimeBefore);
    expect(existsSync(join(vaultPath, existingForDelete.file_path))).toBe(true);
    const undoCountAfter = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;
    expect(undoCountAfter).toBe(undoCountBefore);
  });

  it('composed [create X, update X] preview shows op 2 reflects op 1', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'Chained', types: ['note'] } },
        { op: 'update', params: { title: 'Chained', set_body: 'second op body' } },
      ],
    }));
    expect(result.ok).toBe(true);
    const wouldApply = result.data?.would_apply as Array<Record<string, unknown>>;
    expect(wouldApply[1].op).toBe('update');
    expect(wouldApply[1].body_changed).toBe(true);
  });

  it('failing op mid-dry-run returns ok: true with failed_at and partial would_apply', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'Good', types: ['note'] } },
        { op: 'create', params: { title: 'Bad', types: ['nonexistent_type'] } },
      ],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.failed_at).toBe(1);
    expect(result.data?.op).toBe('create');
    expect(typeof result.data?.message).toBe('string');
    expect(result.data?.op_count).toBeUndefined();
    const wouldApply = result.data?.would_apply as Array<Record<string, unknown>>;
    expect(wouldApply).toHaveLength(1);
    expect(wouldApply[0].op).toBe('create');
  });

  it('update dry_run with no actual change → fields_changed empty, body_changed false, types_after absent', async () => {
    const created = parseResult(await getHandler()({
      operations: [{ op: 'create', params: { title: 'Same', types: ['note'], body: 'unchanged' } }],
    })).data!.results[0];
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [{ op: 'update', params: { node_id: created.node_id, set_body: 'unchanged', set_types: ['note'] } }],
    }));
    expect(result.ok).toBe(true);
    const entry = (result.data?.would_apply as Array<Record<string, unknown>>)[0];
    expect(entry.fields_changed).toEqual([]);
    expect(entry.body_changed).toBe(false);
    expect(entry.types_after).toBeUndefined();
  });

  it('update dry_run with set_title differing from current → title_changed: true', async () => {
    const created = parseResult(await getHandler()({
      operations: [{ op: 'create', params: { title: 'OldName', types: ['note'] } }],
    })).data!.results[0];
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [{ op: 'update', params: { node_id: created.node_id, set_title: 'NewName' } }],
    }));
    expect(result.ok).toBe(true);
    const entry = (result.data?.would_apply as Array<Record<string, unknown>>)[0];
    expect(entry.title_changed).toBe(true);
    expect(entry.body_changed).toBe(false);
    expect(entry.fields_changed).toEqual([]);
  });

  it('delete dry_run with > 10 inbound refs caps referencing_nodes at 10 but reports full count', async () => {
    createGlobalField(db, { name: 'related', field_type: 'list', list_item_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'related' }], default_directory: 'Tasks' });
    const target = parseResult(await getHandler()({
      operations: [{ op: 'create', params: { title: 'Target', types: ['note'] } }],
    })).data!.results[0];
    // 12 inbound refs
    for (let i = 0; i < 12; i++) {
      const r = parseResult(await getHandler()({
        operations: [{ op: 'create', params: { title: `Ref${i}`, types: ['task'], fields: { related: ['Target'] } } }],
      }));
      expect(r.ok).toBe(true);
    }

    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [{ op: 'delete', params: { node_id: target.node_id } }],
    }));
    expect(result.ok).toBe(true);
    const entry = (result.data?.would_apply as Array<Record<string, unknown>>)[0];
    expect(entry.incoming_reference_count).toBe(12);
    expect((entry.referencing_nodes as unknown[]).length).toBe(10);
  });

  it('live path (no dry_run) regression-passes', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Live', types: ['note'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.applied).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/Live.md'))).toBe(true);
  });
});
