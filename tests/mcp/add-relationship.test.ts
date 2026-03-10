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

  // Task 3: List frontmatter relationship with schema

  it('appends to list reference field via schema (meeting attendees)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Sprint Review',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Sprint Review.md',
        target: 'Alice',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Sprint Review.md'), 'utf-8');
    expect(content).toContain('[[Alice]]');
  });

  it('appends second attendee to existing list', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Team Sync',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Team Sync.md',
        target: 'Bob',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Team Sync.md'), 'utf-8');
    expect(content).toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });

  // Task 4: Body relationship routing

  it('appends wiki-link to body when rel_type is wiki-link', async () => {
    await createTestNode({
      title: 'Research Note',
      body: 'Some initial thoughts.',
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Research Note.md',
        target: 'Related Paper',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Research Note.md'), 'utf-8');
    expect(content).toContain('Some initial thoughts.');
    expect(content).toContain('[[Related Paper]]');
  });

  it('appends to body when rel_type has no matching schema field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Tagged Task',
      types: ['task'],
      fields: { status: 'todo' },
      body: 'Task details here.',
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Tagged Task.md',
        target: 'SomeProject',
        rel_type: 'unknown_field',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Tagged Task.md'), 'utf-8');
    expect(content).toContain('Task details here.');
    expect(content).toContain('[[SomeProject]]');
  });

  it('appends wiki-link to body when node has no existing body', async () => {
    await createTestNode({ title: 'Empty Body' });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Empty Body.md',
        target: 'Reference',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Empty Body.md'), 'utf-8');
    expect(content).toContain('[[Reference]]');
  });

  // Task 5: Deduplication

  it('skips duplicate in list field (idempotent)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Dedup Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const contentBefore = readFileSync(join(vaultPath, 'meetings/2026-03-09-Dedup Meeting.md'), 'utf-8');

    // Add same attendee again
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Dedup Meeting.md',
        target: 'Alice',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    // File should be unchanged
    const contentAfter = readFileSync(join(vaultPath, 'meetings/2026-03-09-Dedup Meeting.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('deduplicates case-insensitively in list field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Case Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const contentBefore = readFileSync(join(vaultPath, 'meetings/2026-03-09-Case Meeting.md'), 'utf-8');

    // Add same attendee with different casing
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Case Meeting.md',
        target: 'alice',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'meetings/2026-03-09-Case Meeting.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('skips duplicate body wiki-link (idempotent)', async () => {
    await createTestNode({
      title: 'Linked Note',
      body: 'See also [[Related Topic]] for context.',
    });

    const contentBefore = readFileSync(join(vaultPath, 'Linked Note.md'), 'utf-8');

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Linked Note.md',
        target: 'Related Topic',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'Linked Note.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('skips duplicate body link via fallback routing', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // Create task with body containing a wiki-link
    await createTestNode({
      title: 'Fallback Dedup',
      types: ['task'],
      fields: { status: 'todo' },
      body: 'Related to [[ProjectX]] work.',
    });

    const contentBefore = readFileSync(join(vaultPath, 'tasks/Fallback Dedup.md'), 'utf-8');

    // Try adding same link via unmatched rel_type (falls to body)
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Fallback Dedup.md',
        target: 'ProjectX',
        rel_type: 'unknown_field',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'tasks/Fallback Dedup.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  // Task 6: Schema-less fallback

  it('appends to existing array field without schema', async () => {
    await createTestNode({
      title: 'Tagless Node',
      fields: { tags: ['[[Alpha]]', '[[Beta]]'] },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Tagless Node.md',
        target: 'Gamma',
        rel_type: 'tags',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Tagless Node.md'), 'utf-8');
    expect(content).toContain('[[Alpha]]');
    expect(content).toContain('[[Beta]]');
    expect(content).toContain('[[Gamma]]');
  });

  it('overwrites existing scalar field without schema', async () => {
    await createTestNode({
      title: 'Scalar Override',
      fields: { owner: '[[OldPerson]]' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Scalar Override.md',
        target: 'NewPerson',
        rel_type: 'owner',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Scalar Override.md'), 'utf-8');
    expect(content).toContain('[[NewPerson]]');
    expect(content).not.toContain('[[OldPerson]]');
  });

  it('falls back to body when no schema and field does not exist', async () => {
    await createTestNode({
      title: 'No Field',
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'No Field.md',
        target: 'Somewhere',
        rel_type: 'related',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'No Field.md'), 'utf-8');
    expect(content).toContain('[[Somewhere]]');
    // Should be in body, not frontmatter
    const [frontmatter, body] = content.split('---').slice(1);
    expect(frontmatter).not.toContain('related');
  });

  it('deduplicates in schema-less array field', async () => {
    await createTestNode({
      title: 'Dedup Tagless',
      fields: { refs: ['[[Alice]]'] },
    });

    const contentBefore = readFileSync(join(vaultPath, 'Dedup Tagless.md'), 'utf-8');

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Dedup Tagless.md',
        target: 'Alice',
        rel_type: 'refs',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'Dedup Tagless.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  // Task 7: Target normalization + reference resolution integration

  it('normalizes bare target to [[target]] syntax', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Bare Target',
      types: ['task'],
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Bare Target.md',
        target: 'Bob',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Bare Target.md'), 'utf-8');
    expect(content).toContain('[[Bob]]');
    expect(content).not.toContain('[[[[');
  });

  it('does not double-wrap already bracketed target', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Wrapped Target',
      types: ['task'],
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Wrapped Target.md',
        target: '[[Charlie]]',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Wrapped Target.md'), 'utf-8');
    expect(content).toContain('assignee: "[[Charlie]]"');
    expect(content).not.toContain('[[[[');
  });

  it('resolves references after adding relationship', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    const { writeFileSync: fsWriteFileSync, mkdirSync: fsMkdirSync } = await import('node:fs');
    const { parseFile: parseFileSync } = await import('../../src/parser/index.js');
    const { indexFile: indexFileSync } = await import('../../src/sync/indexer.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // Create target node (Alice) on disk and index it
    const aliceContent = '---\ntitle: Alice\ntypes: [person]\n---\n';
    fsMkdirSync(join(vaultPath, 'people'), { recursive: true });
    fsWriteFileSync(join(vaultPath, 'people/Alice.md'), aliceContent, 'utf-8');
    const aliceParsed = parseFileSync('people/Alice.md', aliceContent);
    db.transaction(() => {
      indexFileSync(db, aliceParsed, 'people/Alice.md', new Date().toISOString(), aliceContent);
    })();

    // Create a task without a relationship
    await createTestNode({
      title: 'Unlinked Task',
      types: ['task'],
      fields: { status: 'todo' },
    });

    // Add the relationship
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Unlinked Task.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();

    // Check relationship is resolved in DB
    const rels = db.prepare(
      'SELECT target_id, resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('tasks/Unlinked Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const assigneeRel = rels.find(r => r.target_id === 'Alice');
    expect(assigneeRel).toBeDefined();
    expect(assigneeRel!.resolved_target_id).toBe('people/Alice.md');
  });

  it('returns validation warnings from schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // Create task missing required 'status' field
    await createTestNode({
      title: 'Warn Task',
      types: ['task'],
      fields: { status: 'todo' },
    });

    // Remove status via update-node, then add-relationship
    await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'tasks/Warn Task.md',
        fields: { status: null },
      },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Warn Task.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // Should have warning about missing required 'status'
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings.some((w: any) => w.rule === 'required')).toBe(true);
  });
});
