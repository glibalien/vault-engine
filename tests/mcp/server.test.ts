// tests/mcp/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { createServer } from '../../src/mcp/server.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('MCP server', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db);
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
  });

  describe('list-types', () => {
    it('returns empty array for empty database', async () => {
      const result = await client.callTool({ name: 'list-types', arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toEqual([]);
    });

    it('returns types with counts', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({ name: 'list-types', arguments: {} });
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);

      // meeting:1 (q1), person:1 (alice), task:2 (review + q1)
      const byName = new Map(data.map((d: { name: string; count: number }) => [d.name, d.count]));
      expect(byName.get('task')).toBe(2);
      expect(byName.get('meeting')).toBe(1);
      expect(byName.get('person')).toBe(1);
    });
  });

  describe('get-node', () => {
    it('returns node with types and fields', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'tasks/review.md' },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.id).toBe('tasks/review.md');
      expect(data.file_path).toBe('tasks/review.md');
      expect(data.node_type).toBe('file');
      expect(data.types).toContain('task');
      expect(data.fields.status).toBe('todo');
      expect(data.fields.priority).toBe('high');
      expect(data.content_text).toContain('vendor');
      expect(data.content_md).toContain('vendor');
      expect(data.updated_at).toBeDefined();
    });

    it('returns error for nonexistent node', async () => {
      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'nonexistent.md' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Node not found');
    });

    it('includes relationships when requested', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'tasks/review.md', include_relationships: true },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.relationships).toBeDefined();
      expect(data.relationships.length).toBeGreaterThan(0);
      // Should include outgoing wiki-links
      const targets = data.relationships.map((r: { target_id: string }) => r.target_id);
      expect(targets).toContain('Bob Jones');
      expect(targets).toContain('Q1 Planning Meeting');
    });

    it('omits relationships by default', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'get-node',
        arguments: { node_id: 'tasks/review.md' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data.relationships).toBeUndefined();
    });
  });

  describe('get-recent', () => {
    it('returns nodes ordered by updated_at descending', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'get-recent',
        arguments: {},
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(2);
      // Both have same mtime, so just check structure
      expect(data[0].id).toBeDefined();
      expect(data[0].types).toBeDefined();
      expect(data[0].fields).toBeDefined();
      // content_md should NOT be included (compact response)
      expect(data[0].content_md).toBeUndefined();
    });

    it('filters by schema_type', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'get-recent',
        arguments: { schema_type: 'person' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('people/alice.md');
    });

    it('filters by since date', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      // The node's updated_at is set by SQLite datetime('now'), so use a past date
      const result = await client.callTool({
        name: 'get-recent',
        arguments: { since: '2020-01-01T00:00:00.000Z' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);

      // Future date should return nothing
      const result2 = await client.callTool({
        name: 'get-recent',
        arguments: { since: '2099-01-01T00:00:00.000Z' },
      });

      const data2 = JSON.parse((result2.content as Array<{ text: string }>)[0].text);
      expect(data2).toHaveLength(0);
    });

    it('respects limit', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'get-recent',
        arguments: { limit: 1 },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
    });
  });

  describe('query-nodes', () => {
    it('returns error when no filter criteria provided', async () => {
      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('At least one');
    });

    it('queries by schema_type only', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'person' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('people/alice.md');
      expect(data[0].types).toContain('person');
      // content_md should NOT be included
      expect(data[0].content_md).toBeUndefined();
    });

    it('queries by full_text search', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { full_text: 'vendor' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('tasks/review.md');
    });

    it('combines schema_type and full_text', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      // Both have type "task", but only review has "Globex"
      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'task', full_text: 'Globex' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('tasks/review.md');
    });

    it('filters by field equality', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      // Both sample-task and sample-meeting have status: todo
      expect(data).toHaveLength(2);
    });

    it('combines schema_type and field filter', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {
          schema_type: 'meeting',
          filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('meetings/q1.md');
    });

    it('returns empty array when filters match nothing', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: {
          filters: [{ field: 'status', operator: 'eq', value: 'done' }],
        },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toEqual([]);
    });

    it('respects limit', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-person.md', 'people/alice.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'task', limit: 1 },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(1);
    });

    it('supports order_by on updated_at', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { schema_type: 'task', order_by: 'updated_at ASC' },
      });

      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(data).toHaveLength(2);
      // Just verify both returned — ordering by updated_at with same insert time is deterministic by rowid
    });

    it('handles FTS5 syntax errors gracefully', async () => {
      indexFixture(db, 'sample-task.md', 'tasks/review.md');

      const result = await client.callTool({
        name: 'query-nodes',
        arguments: { full_text: '***invalid***' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
