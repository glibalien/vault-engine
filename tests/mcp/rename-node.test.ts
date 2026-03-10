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

  it('renames source file — title changes and file moves', async () => {
    await createTestNode({ title: 'Alice', fields: { status: 'active' } });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);

    // New node at new path
    expect(parsed.node.id).toBe('Alice Smith.md');
    expect(parsed.old_path).toBe('Alice.md');
    expect(parsed.new_path).toBe('Alice Smith.md');

    // New file exists, old file deleted
    expect(existsSync(join(vaultPath, 'Alice Smith.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Alice.md'))).toBe(false);

    // New file has updated title
    const content = readFileSync(join(vaultPath, 'Alice Smith.md'), 'utf-8');
    expect(content).toContain('title: Alice Smith');

    // Fields preserved
    expect(content).toContain('status: active');

    // DB updated: old node gone, new node exists
    const oldNode = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Alice.md');
    expect(oldNode).toBeUndefined();
    const newNode = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get('Alice Smith.md') as { id: string; title: string };
    expect(newNode.title).toBe('Alice Smith');
  });

  it('uses explicit new_path when provided', async () => {
    await createTestNode({ title: 'Alice' });

    const result = await callRename({
      node_id: 'Alice.md',
      new_title: 'Alice Smith',
      new_path: 'people/alice-smith.md',
    });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);

    expect(parsed.node.id).toBe('people/alice-smith.md');
    expect(existsSync(join(vaultPath, 'people/alice-smith.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Alice.md'))).toBe(false);
  });

  it('handles self-references in body', async () => {
    await createTestNode({
      title: 'Alice',
      body: 'This is [[Alice]] talking about herself.',
    });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();

    const content = readFileSync(join(vaultPath, 'Alice Smith.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
  });

  it('handles self-references in frontmatter fields', async () => {
    await createTestNode({
      title: 'Alice',
      fields: { see_also: '[[Alice]]' },
    });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();

    const content = readFileSync(join(vaultPath, 'Alice Smith.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
  });

  it('updates body references in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Meeting Notes',
      body: 'Attendees: [[Alice]] and [[Bob]].',
    });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.references_updated).toBe(1);

    // Referencing file updated
    const content = readFileSync(join(vaultPath, 'Meeting Notes.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
    // Other links preserved
    expect(content).toContain('[[Bob]]');
  });

  it('updates frontmatter references in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Task',
      fields: { assignee: '[[Alice]]', status: 'open' },
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Task.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('status: open');
  });

  it('updates list field references in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Project',
      fields: { members: ['[[Alice]]', '[[Bob]]'] },
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Project.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).toContain('[[Bob]]');
  });

  it('preserves aliases in referencing files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Notes',
      body: 'Spoke with [[Alice|the boss]] today.',
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Notes.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith|the boss]]');
  });

  it('updates multiple referencing files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'File A', body: 'See [[Alice]].' });
    await createTestNode({ title: 'File B', body: 'Ask [[Alice]].' });
    await createTestNode({ title: 'File C', body: 'No references here.' });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    const parsed = parseResult(result);
    expect(parsed.references_updated).toBe(2);

    expect(readFileSync(join(vaultPath, 'File A.md'), 'utf-8')).toContain('[[Alice Smith]]');
    expect(readFileSync(join(vaultPath, 'File B.md'), 'utf-8')).toContain('[[Alice Smith]]');
    // File C unchanged
    expect(readFileSync(join(vaultPath, 'File C.md'), 'utf-8')).not.toContain('Alice Smith');
  });

  it('does not match substring wiki-links in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Alice Cooper' });
    await createTestNode({
      title: 'Notes',
      body: 'See [[Alice]] and [[Alice Cooper]].',
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Notes.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).toContain('[[Alice Cooper]]');
  });

  it('updates resolved references in DB after rename', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Task', body: '[[Alice]]' });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    // Check relationships table: target_id updated to new title, resolved to new path
    const rels = db.prepare(`
      SELECT target_id, resolved_target_id FROM relationships
      WHERE source_id = ?
    `).all('Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const aliceRel = rels.find(r => r.target_id === 'Alice Smith');
    expect(aliceRel).toBeDefined();
    expect(aliceRel!.resolved_target_id).toBe('Alice Smith.md');
  });

  it('catches unresolved references via target_id text match', async () => {
    await createTestNode({ title: 'Alice', fields: { tag: 'a' } });
    await createTestNode({ title: 'Task', body: '[[Alice]]' });

    // Insert a second "Alice" to create ambiguity, then clear resolution
    db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title) VALUES (?, ?, 'file', '', ?)`).run(
      'other/Alice.md', 'other/Alice.md', 'Alice'
    );
    db.prepare('UPDATE relationships SET resolved_target_id = NULL WHERE source_id = ?').run('Task.md');

    // The reference is now unresolved, but target_id = "Alice" still matches
    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.references_updated).toBe(1);

    const content = readFileSync(join(vaultPath, 'Task.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
  });

  it('moves file without changing title when only new_path provided', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Task', body: '[[Alice]]' });

    const result = await callRename({
      node_id: 'Alice.md',
      new_title: 'Alice',
      new_path: 'people/Alice.md',
    });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.new_path).toBe('people/Alice.md');
    expect(existsSync(join(vaultPath, 'people/Alice.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Alice.md'))).toBe(false);

    // References unchanged (title didn't change, so body text stays [[Alice]])
    const taskContent = readFileSync(join(vaultPath, 'Task.md'), 'utf-8');
    expect(taskContent).toContain('[[Alice]]');
  });
});
