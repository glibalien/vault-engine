import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('create-node', () => {
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

  it('creates a node with title only (no types, no schema)', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: { title: 'My Note' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.id).toBe('My Note.md');
    expect(data.node.types).toEqual([]);
    expect(data.node.fields).toEqual({});
    expect(data.warnings).toEqual([]);

    // File should exist on disk
    const filePath = join(vaultPath, 'My Note.md');
    expect(existsSync(filePath)).toBe(true);

    // File content should be valid markdown with frontmatter
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('title: My Note');
    expect(content).toContain('types: []');
  });

  it('creates a typed node with fields and schema-driven path', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Fix login bug',
        types: ['task'],
        fields: { status: 'todo', priority: 'high' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Schema template: "tasks/{{title}}.md"
    expect(data.node.id).toBe('tasks/Fix login bug.md');
    expect(data.node.types).toContain('task');
    expect(data.node.fields.status).toBe('todo');
    expect(data.node.fields.priority).toBe('high');
    expect(data.warnings).toEqual([]);

    // File exists with correct content
    const content = readFileSync(join(vaultPath, 'tasks/Fix login bug.md'), 'utf-8');
    expect(content).toContain('title: Fix login bug');
    expect(content).toContain('types: [task]');
    expect(content).toContain('status: todo');
    expect(content).toContain('priority: high');
  });

  it('returns validation warnings but still creates the node', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Bad Task',
        types: ['task'],
        fields: { priority: 'extreme' },
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Node is created despite warnings
    expect(data.node.id).toBe('tasks/Bad Task.md');
    expect(existsSync(join(vaultPath, 'tasks/Bad Task.md'))).toBe(true);

    // Warnings present
    expect(data.warnings.length).toBeGreaterThan(0);
    const rules = data.warnings.map((w: any) => w.rule);
    expect(rules).toContain('required');     // missing status
    expect(rules).toContain('invalid_enum'); // extreme not in enum
  });

  it('uses parent_path to override schema filename_template', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Special Task',
        types: ['task'],
        fields: { status: 'todo' },
        parent_path: 'projects/acme',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // Should use parent_path, not schema template
    expect(data.node.id).toBe('projects/acme/Special Task.md');
    expect(existsSync(join(vaultPath, 'projects/acme/Special Task.md'))).toBe(true);
  });

  it('handles parent_path with trailing slash', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Slash Test',
        parent_path: 'notes/',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.id).toBe('notes/Slash Test.md');
  });

  it('returns error when file already exists at generated path', async () => {
    // Create first node
    await client.callTool({
      name: 'create-node',
      arguments: { title: 'Duplicate' },
    });

    // Try to create same node again
    const result = await client.callTool({
      name: 'create-node',
      arguments: { title: 'Duplicate' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File already exists');
    expect(text).toContain('Duplicate.md');
    expect(text).toContain('update-node');
  });

  it('creates a node with body content', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Meeting Notes',
        types: ['meeting'],
        fields: { date: '2026-03-09' },
        body: '## Agenda\n\n- Discuss roadmap\n- Review budget',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // meeting template: "meetings/{{date}}-{{title}}.md"
    expect(data.node.id).toBe('meetings/2026-03-09-Meeting Notes.md');

    // Body content in file
    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('## Agenda');
    expect(content).toContain('- Discuss roadmap');

    // Body content indexed for FTS
    expect(data.node.content_text).toContain('Discuss roadmap');
  });
});
