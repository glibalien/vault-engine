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

  it('processes scalar relationship into frontmatter field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Review PR',
        types: ['task'],
        fields: { status: 'todo' },
        relationships: [
          { target: 'Alice', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // assignee is a scalar reference field in the task schema
    expect(data.node.fields.assignee).toBe('[[Alice]]');

    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('assignee: "[[Alice]]"');
  });

  it('processes list relationship by appending to array field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Sprint Review',
        types: ['meeting'],
        fields: { date: '2026-03-09' },
        relationships: [
          { target: 'Alice', rel_type: 'attendees' },
          { target: 'Bob', rel_type: 'attendees' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

    // attendees is list<reference> in meeting schema
    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });

  it('appends relationship to body when rel_type has no schema field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Research Note',
        types: ['task'],
        fields: { status: 'todo' },
        body: 'Some initial notes.',
        relationships: [
          { target: 'Related Paper', rel_type: 'wiki-link' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Research Note.md'), 'utf-8');
    expect(content).toContain('Some initial notes.');
    expect(content).toContain('[[Related Paper]]');
  });

  it('does not double-wrap targets already in [[bracket]] syntax', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Linked Task',
        types: ['task'],
        fields: { status: 'todo' },
        relationships: [
          { target: '[[Bob Jones]]', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const content = readFileSync(join(vaultPath, data.node.id), 'utf-8');
    expect(content).toContain('assignee: "[[Bob Jones]]"');
    expect(content).not.toContain('[[[[');
  });

  it('created node is retrievable via get-node', async () => {
    await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Queryable Node',
        types: ['task'],
        fields: { status: 'todo', priority: 'high' },
        body: 'This should be searchable.',
      },
    });

    // Retrieve via get-node (no schemas loaded, so path is title.md)
    const result = await client.callTool({
      name: 'get-node',
      arguments: { node_id: 'Queryable Node.md' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.id).toBe('Queryable Node.md');
    expect(data.types).toContain('task');
    expect(data.fields.status).toBe('todo');
    expect(data.content_text).toContain('searchable');
  });

  it('created node is found via query-nodes full-text search', async () => {
    await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Searchable Task',
        types: ['task'],
        fields: { status: 'todo' },
        body: 'Unique keyword xylophone for search.',
      },
    });

    const result = await client.callTool({
      name: 'query-nodes',
      arguments: { full_text: 'xylophone' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('Searchable Task.md');
  });

  it('resolves references in the created node', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    const { indexFile: indexFileSync } = await import('../../src/sync/indexer.js');
    const { parseFile: parseFileSync } = await import('../../src/parser/index.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // First, create a target node (Alice) on disk and index it
    const aliceContent = '---\ntitle: Alice\ntypes: [person]\nrole: Engineer\n---\n';
    mkdirSync(join(vaultPath, 'people'), { recursive: true });
    writeFileSync(join(vaultPath, 'people/Alice.md'), aliceContent, 'utf-8');
    const aliceParsed = parseFileSync('people/Alice.md', aliceContent);
    db.transaction(() => {
      indexFileSync(db, aliceParsed, 'people/Alice.md', new Date().toISOString(), aliceContent);
    })();

    // Now create a task that references Alice
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Assigned Task',
        types: ['task'],
        fields: { status: 'todo' },
        relationships: [
          { target: 'Alice', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();

    // Check that the relationship is resolved
    const rels = db.prepare(
      'SELECT target_id, resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('tasks/Assigned Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const assigneeRel = rels.find(r => r.target_id === 'Alice');
    expect(assigneeRel).toBeDefined();
    expect(assigneeRel!.resolved_target_id).toBe('people/Alice.md');
  });

  it('appends relationships to body for schema-less nodes', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Loose Note',
        body: 'Some thoughts.',
        relationships: [
          { target: 'Idea A', rel_type: 'related' },
          { target: 'Idea B', rel_type: 'related' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Loose Note.md'), 'utf-8');
    expect(content).toContain('Some thoughts.');
    expect(content).toContain('[[Idea A]]');
    expect(content).toContain('[[Idea B]]');
  });

  it('returns error when schema template requires a field not provided', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // meeting schema template: "meetings/{{date}}-{{title}}.md"
    // Omit the required 'date' field
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'No Date Meeting',
        types: ['meeting'],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('date');
    expect(text).toContain('no value');
  });

  it('overwrites existing scalar field via relationship for schema-less nodes', async () => {
    const result = await client.callTool({
      name: 'create-node',
      arguments: {
        title: 'Override Test',
        fields: { assignee: 'placeholder' },
        relationships: [
          { target: 'Alice', rel_type: 'assignee' },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Override Test.md'), 'utf-8');
    // Relationship should overwrite the placeholder value
    expect(content).toContain('[[Alice]]');
    expect(content).not.toContain('placeholder');
  });
});
