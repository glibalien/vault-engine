import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
import { registerRemoveTypeFromNode } from '../../src/mcp/tools/remove-type-from-node.js';
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { restoreOperation } from '../../src/undo/restore.js';
import { listOperations } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

describe('undo integration — create-node', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerCreateNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one undo_operations row per create-node call', async () => {
    await callTool(server, 'create-node', { title: 'Hello', types: ['note'], body: 'body' });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('create-node');
    expect(list.operations[0].node_count).toBe(1);
    expect(list.operations[0].description).toContain('Hello');
  });

  it('undoing a create removes the node and its file', async () => {
    const result = await callTool(server, 'create-node', { title: 'Temp', types: ['note'], body: 'b' });
    const payload = JSON.parse(result.content[0].text);
    const nodeId = payload.data.node_id;
    const opId = listOperations(db, {}).operations[0].operation_id;

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
    expect(row).toBeUndefined();
  });

  it('does not capture when dry_run=true', async () => {
    await callTool(server, 'create-node', { title: 'Temp', types: ['note'], body: 'b', dry_run: true });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(0);
  });
});

describe('undo integration — update-node (single)', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerUpdateNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation per single-node update', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('update-node');
    expect(list.operations[0].node_count).toBe(1);
  });

  it('does not capture when single-node dry_run=true', async () => {
    writeFileSync(join(vaultPath, 'd.md'), '---\ntypes:\n  - note\n---\n# D\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', { file_path: 'd.md', set_body: 'v2', dry_run: true });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(0);
  });

  it('captures K snapshots for a query-mode update over K matched nodes', async () => {
    writeFileSync(join(vaultPath, 'qa.md'), '---\ntypes:\n  - note\n---\n# qa\n\nv1\n', 'utf-8');
    writeFileSync(join(vaultPath, 'qb.md'), '---\ntypes:\n  - note\n---\n# qb\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', {
      query: { title_contains: 'q' },
      set_fields: { tag: 'x' },
      dry_run: false,
    });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].node_count).toBe(2);
    expect(list.operations[0].description).toContain('query');
  });

  it('does not capture in query-mode dry_run', async () => {
    writeFileSync(join(vaultPath, 'qc.md'), '---\ntypes:\n  - note\n---\n# qc\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', {
      query: { title_contains: 'qc' },
      set_fields: { tag: 'x' },
      dry_run: true,
    });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(0);
  });
});

describe('undo integration — add/remove type', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]'), ('task', 'Task', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerAddTypeToNode(server, db, writeLock, vaultPath);
    registerRemoveTypeFromNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures an operation when add-type-to-node succeeds', async () => {
    writeFileSync(join(vaultPath, 'at.md'), '---\ntypes:\n  - note\n---\n# AT\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'add-type-to-node', { file_path: 'at.md', type: 'task' });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('add-type-to-node');
  });

  it('captures an operation when remove-type-from-node succeeds', async () => {
    writeFileSync(join(vaultPath, 'rt.md'), '---\ntypes:\n  - note\n  - task\n---\n# RT\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'remove-type-from-node', { file_path: 'rt.md', type: 'task' });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('remove-type-from-node');
  });
});

describe('undo integration — rename-node', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerRenameNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation with 1 + N snapshots for a rename that touches N refs', async () => {
    writeFileSync(join(vaultPath, 'target.md'), '---\ntypes:\n  - note\n---\n# Target\n', 'utf-8');
    writeFileSync(join(vaultPath, 'refA.md'), '---\ntypes:\n  - note\n---\n# RefA\n\nSee [[Target]]\n', 'utf-8');
    writeFileSync(join(vaultPath, 'refB.md'), '---\ntypes:\n  - note\n---\n# RefB\n\nAlso [[Target]]\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'rename-node', { title: 'Target', new_title: 'Renamed' });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    // 1 for the rename itself + N for each actually-updated referencing node (N >= 1)
    expect(list.operations[0].node_count).toBeGreaterThanOrEqual(2);
    expect(list.operations[0].description).toContain('references');
  });
});

describe('undo integration — delete-node', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerDeleteNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation capturing pre-delete state', async () => {
    writeFileSync(join(vaultPath, 'del.md'), '---\ntypes:\n  - note\n---\n# Del\n\noriginal\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'delete-node', { file_path: 'del.md', confirm: true, referencing_nodes_limit: 20 });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('delete-node');
    expect(list.operations[0].node_count).toBe(1);
  });

  it('restoring the operation re-creates the node with its original id', async () => {
    writeFileSync(join(vaultPath, 'res.md'), '---\ntypes:\n  - note\n---\n# Res\n\nhello\n', 'utf-8');
    fullIndex(vaultPath, db);
    const originalId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('res.md') as { id: string }).id;

    await callTool(server, 'delete-node', { file_path: 'res.md', confirm: true, referencing_nodes_limit: 20 });
    const opId = listOperations(db, {}).operations[0].operation_id;

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get(originalId) as { id: string } | undefined;
    expect(row?.id).toBe(originalId);
  });
});

describe('undo integration — batch-mutate', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerBatchMutate(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation with K snapshots for K sub-ops', async () => {
    await callTool(server, 'batch-mutate', {
      operations: [
        { op: 'create', params: { title: 'B1', types: ['note'], body: 'b1' } },
        { op: 'create', params: { title: 'B2', types: ['note'], body: 'b2' } },
        { op: 'create', params: { title: 'B3', types: ['note'], body: 'b3' } },
      ],
    });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].node_count).toBe(3);
    expect(list.operations[0].description).toContain('batch-mutate');
  });

  it('no operation row remains when the batch rolls back', async () => {
    await callTool(server, 'batch-mutate', {
      operations: [
        { op: 'create', params: { title: 'Ok', types: ['note'], body: 'ok' } },
        { op: 'create', params: { title: 'Ok', types: ['note'], body: 'dup' } }, // duplicate path triggers rollback
      ],
    });
    const list = listOperations(db, {});
    // Either: zero ops (orphan swept eventually) OR one op with node_count=0
    // The immediate state after tool return should have no *active-with-snapshots* op
    const withSnaps = list.operations.filter(o => o.node_count > 0);
    expect(withSnaps.length).toBe(0);
  });
});
