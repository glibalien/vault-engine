import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { createOperation } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

describe('vault-stats — undo aggregate', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    server = new McpServer({ name: 'test', version: '0' });
    // vault-stats signature is (server, db, extractorRegistry?, embeddingIndexer?);
    // vaultPath is captured for parity with the plan template but not passed in —
    // the undo aggregate reads directly from the db.
    void vaultPath;
    registerVaultStats(server, db);
  });
  afterEach(() => { db.close(); cleanup(); });

  it('includes undo.active_operations and undo.total_snapshot_bytes', async () => {
    const id = createOperation(db, { source_tool: 'create-node', description: 'x' });
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, body, was_deleted) VALUES (?, ?, ?, ?, 0)')
      .run(id, 'n1', 'a.md', 'hello world');

    const result = await callTool(server, 'vault-stats', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.undo).toBeDefined();
    expect(payload.data.undo.active_operations).toBe(1);
    expect(payload.data.undo.total_snapshot_bytes).toBeGreaterThan(0);
  });
});
