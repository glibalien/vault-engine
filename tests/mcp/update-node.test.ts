import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('update-node', () => {
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

  it('returns error when no updates provided', async () => {
    await createTestNode({ title: 'Target' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: { node_id: 'Target.md' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('No updates provided');
  });

  it('returns error when both body and append_body provided', async () => {
    await createTestNode({ title: 'Target' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Target.md',
        body: 'new body',
        append_body: 'more content',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('body');
    expect(text).toContain('append_body');
    expect(text).toContain('mutually exclusive');
  });

  it('returns error when node does not exist', async () => {
    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'nonexistent.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
    expect(text).toContain('nonexistent.md');
  });

  it('returns error when file is missing on disk but exists in DB', async () => {
    await createTestNode({ title: 'Ghost' });
    // Delete the file but leave the DB entry
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Ghost.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File not found on disk');
    expect(text).toContain('out of sync');
  });

  it('updates a field while preserving existing fields', async () => {
    await createTestNode({
      title: 'My Task',
      fields: { status: 'todo', priority: 'high' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'My Task.md',
        fields: { status: 'done' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('done');
    expect(data.node.fields.priority).toBe('high');

    // Verify file content
    const content = readFileSync(join(vaultPath, 'My Task.md'), 'utf-8');
    expect(content).toContain('status: done');
    expect(content).toContain('priority: high');
  });

  it('adds a new field to an existing node', async () => {
    await createTestNode({
      title: 'Simple Note',
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Simple Note.md',
        fields: { priority: 'high' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('todo');
    expect(data.node.fields.priority).toBe('high');
  });

  it('removes a field by setting it to null', async () => {
    await createTestNode({
      title: 'Removable',
      fields: { status: 'todo', priority: 'high', assignee: '[[Alice]]' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Removable.md',
        fields: { priority: null },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('todo');
    expect(data.node.fields.priority).toBeUndefined();
    expect(data.node.fields.assignee).toBe('[[Alice]]');

    // Verify field is gone from file
    const content = readFileSync(join(vaultPath, 'Removable.md'), 'utf-8');
    expect(content).not.toContain('priority');
  });

  it('ignores title and types in field updates', async () => {
    await createTestNode({
      title: 'Immutable',
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Immutable.md',
        fields: { title: 'Changed', types: ['task'], status: 'done' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('done');

    // Title should remain unchanged, no duplicate keys
    const content = readFileSync(join(vaultPath, 'Immutable.md'), 'utf-8');
    expect(content).toContain('title: Immutable');
    expect(content).not.toContain('title: Changed');
  });

  it('handles mixed operations: update, add, and remove fields', async () => {
    await createTestNode({
      title: 'Mixed',
      fields: { status: 'todo', old_field: 'remove me' },
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Mixed.md',
        fields: {
          status: 'in-progress',
          new_field: 'hello',
          old_field: null,
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.status).toBe('in-progress');
    expect(data.node.fields.new_field).toBe('hello');
    expect(data.node.fields.old_field).toBeUndefined();
  });

  it('replaces body content', async () => {
    await createTestNode({
      title: 'Body Test',
      fields: { status: 'todo' },
      body: 'Original body content.',
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Body Test.md',
        body: 'Completely new body.',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Body Test.md'), 'utf-8');
    expect(content).toContain('Completely new body.');
    expect(content).not.toContain('Original body');

    // Existing fields preserved
    expect(content).toContain('status: todo');
  });

  it('appends to existing body content', async () => {
    await createTestNode({
      title: 'Append Test',
      body: 'First paragraph.',
    });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'Append Test.md',
        append_body: 'Second paragraph.',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Append Test.md'), 'utf-8');
    expect(content).toContain('First paragraph.');
    expect(content).toContain('Second paragraph.');
  });

  it('appends body when node has no existing body', async () => {
    await createTestNode({ title: 'No Body' });

    const result = await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'No Body.md',
        append_body: 'New content.',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'No Body.md'), 'utf-8');
    expect(content).toContain('New content.');
  });

});
