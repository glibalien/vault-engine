import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('rename-node', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  async function createTestNode(args: Record<string, unknown>) {
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  async function callRename(args: Record<string, unknown>) {
    return client.callTool({ name: 'rename-node', arguments: args });
  }

  function parseResult(result: Awaited<ReturnType<typeof callRename>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns error when node does not exist in DB', async () => {
    const result = await callRename({ node_id: 'nonexistent.md', new_title: 'New' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('Node not found');
  });

  it('returns error when file missing from disk', async () => {
    await createTestNode({ title: 'Ghost' });
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await callRename({ node_id: 'Ghost.md', new_title: 'New Ghost' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('File not found on disk');
  });

  it('returns error when new path already exists', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Alice Smith' });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('already exists');
  });

  it('returns current node as no-op when title unchanged and no new_path', async () => {
    await createTestNode({ title: 'Alice' });
    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.node.id).toBe('Alice.md');
  });
});
