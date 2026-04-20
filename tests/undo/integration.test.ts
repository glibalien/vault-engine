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
import { registerListUndoHistory } from '../../src/mcp/tools/list-undo-history.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
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
    writeFileSync(join(vaultPath, 'Target.md'), '---\ntypes:\n  - note\n---\n# Target\n', 'utf-8');
    writeFileSync(join(vaultPath, 'refA.md'), '---\ntypes:\n  - note\n---\n# RefA\n\nSee [[Target]]\n', 'utf-8');
    writeFileSync(join(vaultPath, 'refB.md'), '---\ntypes:\n  - note\n---\n# RefB\n\nAlso [[Target]]\n', 'utf-8');
    fullIndex(vaultPath, db);
    const origNodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('Target.md') as { id: string }).id;

    await callTool(server, 'rename-node', { title: 'Target', new_title: 'Renamed' });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    // 1 for the rename itself + N for each actually-updated referencing node (N >= 1)
    expect(list.operations[0].node_count).toBeGreaterThanOrEqual(3);
    expect(list.operations[0].description).toContain('references');

    // The primary renamed node snapshot must record the PRE-rename identity.
    const primary = db.prepare('SELECT file_path, title FROM undo_snapshots WHERE operation_id = ? AND node_id = ?')
      .get(list.operations[0].operation_id, origNodeId) as { file_path: string; title: string } | undefined;
    expect(primary).toBeDefined();
    expect(primary!.file_path).toBe('Target.md');
    expect(primary!.title).toBe('Target');

    // Round-trip: restoreOperation must put the node back at its original path/title.
    restoreOperation(db, writeLock, vaultPath, list.operations[0].operation_id, new Set([list.operations[0].operation_id]));
    const afterRestore = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(origNodeId) as { file_path: string; title: string } | undefined;
    expect(afterRestore).toBeDefined();
    expect(afterRestore!.file_path).toBe('Target.md');
    expect(afterRestore!.title).toBe('Target');
  });

  it('rename with zero references: captures exactly 1 primary snapshot and restore round-trips', async () => {
    writeFileSync(join(vaultPath, 'Solo.md'), '---\ntypes:\n  - note\n---\n# Solo\n\nno refs here\n', 'utf-8');
    fullIndex(vaultPath, db);
    const origNodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('Solo.md') as { id: string }).id;

    await callTool(server, 'rename-node', { title: 'Solo', new_title: 'Lonely' });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].node_count).toBe(1);

    // The single snapshot must record the PRE-rename state.
    const snaps = db.prepare('SELECT node_id, file_path, title FROM undo_snapshots WHERE operation_id = ?')
      .all(list.operations[0].operation_id) as Array<{ node_id: string; file_path: string; title: string }>;
    expect(snaps.length).toBe(1);
    expect(snaps[0].node_id).toBe(origNodeId);
    expect(snaps[0].file_path).toBe('Solo.md');
    expect(snaps[0].title).toBe('Solo');

    // Pre-restore: node moved to new path
    const preRestore = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(origNodeId) as { file_path: string; title: string };
    expect(preRestore.file_path).toBe('Lonely.md');
    expect(preRestore.title).toBe('Lonely');

    // Restore: must revert file_path and title.
    restoreOperation(db, writeLock, vaultPath, list.operations[0].operation_id, new Set([list.operations[0].operation_id]));
    const restored = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(origNodeId) as { file_path: string; title: string };
    expect(restored.file_path).toBe('Solo.md');
    expect(restored.title).toBe('Solo');
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

describe('undo end-to-end', () => {
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
    registerUpdateNode(server, db, writeLock, vaultPath);
    registerDeleteNode(server, db, writeLock, vaultPath);
    registerListUndoHistory(server, db);
    registerUndoOperations(server, db, writeLock, vaultPath);
  });
  afterEach(() => { db.close(); cleanup(); });

  it('create → update → delete, then undo all three in reverse order', async () => {
    // 1. create
    const createResp = await callTool(server, 'create-node', { title: 'E2E', types: ['note'], body: 'v1' });
    const nodeId = JSON.parse(createResp.content[0].text).data.node_id;

    // 2. update
    await callTool(server, 'update-node', { node_id: nodeId, set_body: 'v2' });

    // 3. delete
    await callTool(server, 'delete-node', { node_id: nodeId, confirm: true, referencing_nodes_limit: 20 });

    // Verify three operations in history
    const listResp = await callTool(server, 'list-undo-history', {});
    const list = JSON.parse(listResp.content[0].text).data;
    expect(list.operations.length).toBe(3);

    // Undo all via time range
    const undoResp = await callTool(server, 'undo-operations', {
      since: new Date(0).toISOString(),
      dry_run: false,
    });
    const undoPayload = JSON.parse(undoResp.content[0].text).data;
    expect(undoPayload.total_undone).toBe(3);

    // Node is gone (undoing the create removes it)
    const row = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
    expect(row).toBeUndefined();

    // Observability: at least one undo-restore edits_log entry exists
    const undoEvents = db.prepare("SELECT event_type FROM edits_log WHERE event_type LIKE '%undo%' OR details LIKE '%undo%'").all();
    expect(undoEvents.length).toBeGreaterThan(0);
  });

  it('surfaces modified_after_operation conflict and resolves via revert', async () => {
    const createResp = await callTool(server, 'create-node', { title: 'Conf', types: ['note'], body: 'v1' });
    const nodeId = JSON.parse(createResp.content[0].text).data.node_id;
    await callTool(server, 'update-node', { node_id: nodeId, set_body: 'v2' });
    const opToUndo = JSON.parse((await callTool(server, 'list-undo-history', {})).content[0].text).data.operations.find(
      (o: { source_tool: string }) => o.source_tool === 'update-node',
    ).operation_id;

    // External drift
    await callTool(server, 'update-node', { node_id: nodeId, set_body: 'v3' });

    // Try to undo — should report conflict
    const dryResp = await callTool(server, 'undo-operations', { operation_ids: [opToUndo], dry_run: true });
    const dryPayload = JSON.parse(dryResp.content[0].text).data;
    expect(dryPayload.conflicts.length).toBeGreaterThan(0);
    expect(dryPayload.conflicts[0].reason).toBe('modified_after_operation');

    // Resolve via revert
    const resolveResp = await callTool(server, 'undo-operations', {
      operation_ids: [opToUndo],
      dry_run: false,
      resolve_conflicts: [{ node_id: nodeId, action: 'revert' }],
    });
    const resolvePayload = JSON.parse(resolveResp.content[0].text).data;
    expect(resolvePayload.total_undone).toBe(1);

    const body = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(nodeId) as { body: string }).body;
    expect(body).toBe('v1');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Regression tests for PR-review bugs C1, C2 (covered by rename suite above),
// and C3. These lock in the INSERT OR IGNORE + pre-state-capture fixes.
// ──────────────────────────────────────────────────────────────────────────

describe('undo regression — C1: update-node with set_title (mutate + rename in one op)', () => {
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

  it('does not throw UNIQUE constraint violation when set_title + set_body share an operation_id', async () => {
    writeFileSync(join(vaultPath, 'c1.md'), '---\ntypes:\n  - note\n---\n# c1\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);

    const resp = await callTool(server, 'update-node', {
      file_path: 'c1.md',
      set_title: 'c1-renamed',
      set_body: 'v2',
    });
    const payload = JSON.parse(resp.content[0].text);
    // Must succeed. Before the fix, this threw INTERNAL_ERROR with
    // "UNIQUE constraint failed: undo_snapshots.operation_id, undo_snapshots.node_id".
    expect(payload.ok).toBe(true);
    expect(payload.data.file_path).toBe('c1-renamed.md');
    expect(payload.data.title).toBe('c1-renamed');

    // Exactly one operation, exactly one snapshot (the primary node).
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].node_count).toBe(1);
  });
});

describe('undo regression — C3: update-node query-mode set_directory captures pre-move file_path', () => {
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

  it('snapshot records ORIGINAL file_path (not post-move) and restore moves the file back', async () => {
    writeFileSync(join(vaultPath, 'src.md'), '---\ntypes:\n  - note\n---\n# src\n\nbody\n', 'utf-8');
    fullIndex(vaultPath, db);
    const origNodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('src.md') as { id: string }).id;

    await callTool(server, 'update-node', {
      query: { title_eq: 'src' },
      set_directory: 'dest',
      dry_run: false,
    });

    // Post-move: file is at dest/src.md
    const post = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(origNodeId) as { file_path: string };
    expect(post.file_path).toBe('dest/src.md');

    // Snapshot must record PRE-move path.
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    const snap = db.prepare('SELECT file_path FROM undo_snapshots WHERE operation_id = ? AND node_id = ?')
      .get(list.operations[0].operation_id, origNodeId) as { file_path: string };
    expect(snap.file_path).toBe('src.md');

    // Restore: node must return to src.md.
    restoreOperation(db, writeLock, vaultPath, list.operations[0].operation_id, new Set([list.operations[0].operation_id]));
    const restored = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(origNodeId) as { file_path: string };
    expect(restored.file_path).toBe('src.md');
  });
});
