import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerListUndoHistory } from '../../src/mcp/tools/list-undo-history.js';
import { createOperation } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

describe('list-undo-history', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createTestDb();
    addUndoTables(db);
    server = new McpServer({ name: 'test', version: '0' });
    registerListUndoHistory(server, db);
  });
  afterEach(() => db.close());

  it('returns active operations sorted desc by timestamp', async () => {
    const id1 = createOperation(db, { source_tool: 'create-node', description: 'a' });
    db.prepare('UPDATE undo_operations SET timestamp = 1000 WHERE operation_id = ?').run(id1);
    const id2 = createOperation(db, { source_tool: 'update-node', description: 'b' });
    db.prepare('UPDATE undo_operations SET timestamp = 2000 WHERE operation_id = ?').run(id2);

    const result = await callTool(server, 'list-undo-history', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.operations.map((o: { operation_id: string }) => o.operation_id)).toEqual([id2, id1]);
  });

  it('filters by source_tool', async () => {
    createOperation(db, { source_tool: 'create-node', description: '' });
    createOperation(db, { source_tool: 'update-node', description: '' });

    const result = await callTool(server, 'list-undo-history', { source_tool: 'update-node' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.operations.length).toBe(1);
    expect(payload.data.operations[0].source_tool).toBe('update-node');
  });

  it('reports truncated when results exceed limit', async () => {
    for (let i = 0; i < 3; i++) createOperation(db, { source_tool: 't', description: String(i) });
    const result = await callTool(server, 'list-undo-history', { limit: 2 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.operations.length).toBe(2);
    expect(payload.data.truncated).toBe(true);
  });
});
