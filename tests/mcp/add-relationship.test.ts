import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('add-relationship', () => {
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
    const result = await client.callTool({
      name: 'create-node',
      arguments: args,
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns error when source node does not exist', async () => {
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'nonexistent.md',
        target: 'Alice',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
  });

  it('returns error when file is missing on disk but exists in DB', async () => {
    await createTestNode({ title: 'Ghost' });
    // Delete the file but leave the DB entry
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Ghost.md',
        target: 'Alice',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File not found on disk');
  });

  it('sets scalar reference field via schema (task assignee)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Review PR',
      types: ['task'],
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Review PR.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.assignee).toBe('[[Alice]]');

    // Verify file content
    const content = readFileSync(join(vaultPath, 'tasks/Review PR.md'), 'utf-8');
    expect(content).toContain('assignee: "[[Alice]]"');
    // Existing fields preserved
    expect(content).toContain('status: todo');
  });

  it('overwrites existing scalar reference field via schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Reassign Task',
      types: ['task'],
      fields: { status: 'todo' },
      relationships: [{ target: 'Alice', rel_type: 'assignee' }],
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Reassign Task.md',
        target: 'Bob',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Reassign Task.md'), 'utf-8');
    expect(content).toContain('[[Bob]]');
    expect(content).not.toContain('[[Alice]]');
  });
});
