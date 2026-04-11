import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

let db: Database.Database;

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(name: string) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (n: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      if (n === name) capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerAllTools(fakeServer, db);
  return capturedHandler!;
}

function seedData() {
  // Node n1 with types: [task, custom]. 'task' has a schema, 'custom' does not.
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('n1', 'tasks/task1.md', 'Task One', 'Body', 'h1', 1000, 2000);

  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n1', 'task');
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n1', 'custom');

  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('n1', 'status', 'open', null, null, null, 'frontmatter');

  // Global field and schema for 'task' only
  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed'],
  });

  createSchemaDefinition(db, {
    name: 'task',
    field_claims: [{ field: 'status' }],
  });
}

beforeEach(() => {
  db = createTestDb();
  seedData();
});

describe('schemaless type consistency', () => {
  it('get-node marks custom in types_without_schemas and task in types_with_schemas', async () => {
    const handler = getToolHandler('get-node');
    const result = parseResult(await handler({ node_id: 'n1' }));
    const c = result.conformance;

    expect(c.types_with_schemas).toContain('task');
    expect(c.types_without_schemas).toContain('custom');
  });

  it('list-types marks custom with has_schema:false, claim_count:null', async () => {
    const handler = getToolHandler('list-types');
    const result = parseResult(await handler({}));
    const custom = result.find((t: any) => t.type === 'custom');

    expect(custom).toBeDefined();
    expect(custom.has_schema).toBe(false);
    expect(custom.claim_count).toBeNull();
  });

  it('validate-node reports custom in types_without_schemas', async () => {
    const handler = getToolHandler('validate-node');
    const result = parseResult(await handler({ node_id: 'n1' }));

    expect(result.types_without_schemas).toContain('custom');
  });
});
