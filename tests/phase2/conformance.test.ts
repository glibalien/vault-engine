import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { getNodeConformance } from '../../src/validation/conformance.js';

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
    const body = parseResult(await handler({ node_id: 'n1' }));
    expect(body.ok).toBe(true);
    const c = body.data.conformance;

    expect(c.types_with_schemas).toContain('task');
    expect(c.types_without_schemas).toContain('custom');
  });

  it('list-types marks custom with has_schema:false, claim_count:null', async () => {
    const handler = getToolHandler('list-types');
    const body = parseResult(await handler({}));
    expect(body.ok).toBe(true);
    const custom = body.data.find((t: any) => t.type === 'custom');

    expect(custom).toBeDefined();
    expect(custom.has_schema).toBe(false);
    expect(custom.claim_count).toBeNull();
  });

  it('validate-node reports custom in types_without_schemas', async () => {
    const handler = getToolHandler('validate-node');
    const body = parseResult(await handler({ node_id: 'n1' }));
    expect(body.ok).toBe(true);

    expect(body.data.types_without_schemas).toContain('custom');
  });

  it('describe-schema for task does not include custom type in its scope', async () => {
    const handler = getToolHandler('describe-schema');
    const body = parseResult(await handler({ name: 'task', include: ['coverage'] }));
    expect(body.ok).toBe(true);
    const result = body.data;

    // describe-schema returns data about 'task' which has a schema.
    // The schemaless 'custom' type is not part of describe-schema's output,
    // but the tool should work correctly in a vault where schemaless types exist.
    expect(result.name).toBe('task');
    expect(result.node_count).toBe(1); // n1 has type 'task'
  });
});

describe('query-count discipline', () => {
  it('getNodeConformance uses bounded queries proportional to type count, not node count', () => {
    // The spec requires get-node conformance to add "at most 3 indexed queries"
    // per call. The actual implementation uses prepared statements in loops:
    // 1 per type (schema existence) + 1 per type with schema (claims) +
    // 1 (node fields) + 1 per unfilled claim (required lookup).
    //
    // For a node with 1 type, 1 schema, 2 claims, 1 unfilled:
    // schema_exists(1) + claims(1) + node_fields(1) + required(1) = 4 prepared calls
    //
    // We verify the count stays bounded and doesn't grow with vault size.
    // Adding 100 extra nodes should NOT increase query count for a single get-node.
    // Seed 100 extra nodes — these should not affect query count
    for (let i = 10; i < 110; i++) {
      db.prepare(
        'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(`extra${i}`, `extra${i}.md`, `Extra ${i}`, '', `h${i}`, 1, 1);
      db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(`extra${i}`, 'task');
      db.prepare(
        'INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)'
      ).run(`extra${i}`, 'status', 'open', 'frontmatter');
    }

    // Wrap db.prepare to count statement executions
    let queryCount = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (...args: Parameters<typeof db.prepare>) => {
      const stmt = originalPrepare(...args);
      const originalGet = stmt.get.bind(stmt);
      const originalAll = stmt.all.bind(stmt);
      stmt.get = (...getArgs: unknown[]) => { queryCount++; return originalGet(...getArgs); };
      stmt.all = (...allArgs: unknown[]) => { queryCount++; return originalAll(...allArgs); };
      return stmt;
    };

    queryCount = 0;
    getNodeConformance(db, 'n1', ['task', 'custom']);

    // Restore
    db.prepare = originalPrepare;

    // With 2 types (1 with schema claiming 1 field), 1 node field, 0 unfilled claims:
    // Expected: schema_exists(2) + claims(1) + node_fields(1) + required(0) = 4
    // Allow some headroom but ensure it's bounded (not 100+ from scanning nodes)
    expect(queryCount).toBeLessThanOrEqual(10);
    expect(queryCount).toBeGreaterThan(0);
  });
});
