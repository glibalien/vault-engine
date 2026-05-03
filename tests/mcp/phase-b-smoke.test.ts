import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addUiHints } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { registerCreateSchema } from '../../src/mcp/tools/create-schema.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerListUndoHistory } from '../../src/mcp/tools/list-undo-history.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { restoreMany } from '../../src/undo/restore.js';

interface Envelope { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } }
function parse(result: unknown): Envelope {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Envelope;
}

function capture(reg: (s: McpServer) => void): (args: Record<string, unknown>) => Promise<unknown> {
  let h: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, fn: (...a: unknown[]) => unknown) => { h = (args) => fn(args) as Promise<unknown>; } } as unknown as McpServer;
  reg(fake);
  return h!;
}

describe('Phase B end-to-end smoke: schema ops + confirm gate + undo', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let writeLock: WriteLockManager;
  let syncLogger: SyncLogger;

  beforeEach(() => {
    ({ vaultPath, cleanup } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    addUndoTables(db);
    addNodeTypesSortOrder(db);
    addSchemaUndoSnapshots(db);
    addUiHints(db);
    writeLock = new WriteLockManager();
    syncLogger = new SyncLogger(db);
  });
  afterEach(() => { db.close(); cleanup(); });

  it('walks the documented smoke flow: create → node → dry_run → gate → confirm → undo', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'active', required: true });

    const createSchemaH = capture(s => registerCreateSchema(s, db, { vaultPath }));
    const updateSchemaH = capture(s => registerUpdateSchema(s, db, { writeLock, vaultPath, syncLogger }));
    const createNodeH = capture(s => registerCreateNode(s, db, writeLock, vaultPath, syncLogger));
    const listUndoH = capture(s => registerListUndoHistory(s, db));

    // 1. create-schema
    const r1 = parse(await createSchemaH({ name: 'demo', field_claims: [{ field: 'status' }] }));
    expect(r1.ok).toBe(true);

    const l1 = parse(await listUndoH({ source_tool: 'create-schema' }));
    const createOps = (l1.data as { operations: Array<{ schema_count: number }> }).operations;
    expect(createOps[0].schema_count).toBe(1);

    // 2. create-node
    const r2 = parse(await createNodeH({ title: 'Demo A', types: ['demo'], fields: { status: 'active' } }));
    expect(r2.ok).toBe(true);

    // 3. update-schema dry_run → preview shows orphan, no commit
    const r3 = parse(await updateSchemaH({ name: 'demo', field_claims: [], dry_run: true }));
    expect(r3.ok).toBe(true);
    const preview = r3.data as { orphaned_field_names: Array<{ field: string; count: number }>; propagation: { fields_orphaned: number } };
    expect(preview.orphaned_field_names).toEqual([{ field: 'status', count: 1 }]);
    expect(preview.propagation.fields_orphaned).toBe(1);

    const claimsAfterDry = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('demo') as Array<{ field: string }>;
    expect(claimsAfterDry.map(c => c.field)).toEqual(['status']);

    // 4. update-schema without confirm → CONFIRMATION_REQUIRED
    const r4 = parse(await updateSchemaH({ name: 'demo', field_claims: [] }));
    expect(r4.ok).toBe(false);
    expect(r4.error?.code).toBe('CONFIRMATION_REQUIRED');

    // 5. update-schema with confirm → commit
    const r5 = parse(await updateSchemaH({ name: 'demo', field_claims: [], confirm_large_change: true }));
    expect(r5.ok).toBe(true);

    const l5 = parse(await listUndoH({ source_tool: 'update-schema' }));
    const updateOps = (l5.data as { operations: Array<{ operation_id: string; schema_count: number }> }).operations;
    expect(updateOps[0].schema_count).toBe(1);
    const updateOpId = updateOps[0].operation_id;

    const claimsAfterCommit = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('demo') as Array<{ field: string }>;
    expect(claimsAfterCommit).toEqual([]);

    // 6. undo restores the claim
    restoreMany(db, writeLock, vaultPath, { operation_ids: [updateOpId], dry_run: false });

    const claimsAfterUndo = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('demo') as Array<{ field: string }>;
    expect(claimsAfterUndo.map(c => c.field)).toEqual(['status']);
  });
});
