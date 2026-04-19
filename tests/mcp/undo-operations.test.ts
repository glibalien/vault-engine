import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { listOperations } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

describe('undo-operations', () => {
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
    registerUndoOperations(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('INVALID_PARAMS when neither operation_ids nor since provided', async () => {
    const result = await callTool(server, 'undo-operations', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('INVALID_PARAMS when both operation_ids and since provided', async () => {
    const result = await callTool(server, 'undo-operations', { operation_ids: ['x'], since: new Date().toISOString() });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('OPERATION_NOT_FOUND when id missing', async () => {
    const result = await callTool(server, 'undo-operations', { operation_ids: ['nope'], dry_run: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('OPERATION_NOT_FOUND');
  });

  it('dry-run returns zero total_undone but reports operations', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    const result = await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.total_undone).toBe(0);
    expect(payload.data.operations[0].status).toBe('would_undo');
  });

  it('executes undo when dry_run=false and reflects restored state', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    const result = await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: false });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.total_undone).toBe(1);
    const body = (db.prepare('SELECT body FROM nodes WHERE file_path = ?').get('u.md') as { body: string }).body;
    // Pre-update body as stored by indexer (retains H1 heading and trailing newline).
    expect(body).toBe('# U\n\nv1\n');
    expect(body).not.toBe('v2');
  });
});
