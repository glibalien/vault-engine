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
  // Create node n1: task type, has status='open', priority=5, custom_field='data'
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('n1', 'tasks/task1.md', 'Task One', 'Body text', 'h1', 1000, 2000);

  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n1', 'task');

  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('n1', 'status', 'open', null, null, null, 'frontmatter');
  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('n1', 'priority', null, 5, null, null, 'frontmatter');
  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('n1', 'custom_field', 'data', null, null, null, 'frontmatter');

  // Create global fields
  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed', 'in-progress'],
  });
  createGlobalField(db, {
    name: 'priority',
    field_type: 'number',
  });
  createGlobalField(db, {
    name: 'due_date',
    field_type: 'date',
  });

  // Create schema: task with claims on status, priority, due_date
  createSchemaDefinition(db, {
    name: 'task',
    display_name: 'Task',
    field_claims: [
      { field: 'status', sort_order: 1 },
      { field: 'priority', sort_order: 2 },
      { field: 'due_date', sort_order: 3 },
    ],
  });
}

beforeEach(() => {
  db = createTestDb();
  seedData();
});

describe('get-node conformance', () => {
  it('includes conformance block with claimed, orphan, and unfilled fields', async () => {
    const handler = getToolHandler('get-node');
    const body = parseResult(await handler({ node_id: 'n1' }));
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.conformance).toBeDefined();
    const c = result.conformance;

    // claimed_fields contains status and priority
    const claimedNames = c.claimed_fields.map((f: any) => f.field);
    expect(claimedNames).toContain('status');
    expect(claimedNames).toContain('priority');

    // orphan_fields contains custom_field
    expect(c.orphan_fields).toContain('custom_field');

    // unfilled_claims contains due_date (claimed but node doesn't have it)
    const unfilledNames = c.unfilled_claims.map((f: any) => f.field);
    expect(unfilledNames).toContain('due_date');

    // types_with_schemas contains task
    expect(c.types_with_schemas).toContain('task');
  });
});

describe('describe-schema enrichments', () => {
  it('returns node_count, field_coverage, orphan_field_names, and inlined global_field', async () => {
    const handler = getToolHandler('describe-schema');
    const body = parseResult(await handler({ name: 'task' }));
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.node_count).toBe(1);

    expect(result.field_coverage.status.have_value).toBe(1);
    expect(result.field_coverage.status.total).toBe(1);

    expect(result.orphan_field_names).toContainEqual({ field: 'custom_field', count: 1 });

    // field_claims is an array with global_field inlined
    expect(result.field_claims).toBeInstanceOf(Array);
    expect(result.field_claims.length).toBe(3);
    const statusClaim = result.field_claims.find((c: any) => c.field === 'status');
    expect(statusClaim.global_field).toBeDefined();
    expect(statusClaim.global_field.field_type).toBe('enum');
  });
});

describe('list-types enrichments', () => {
  it('marks task with has_schema:true and claim_count:3', async () => {
    const handler = getToolHandler('list-types');
    const body = parseResult(await handler({}));
    expect(body.ok).toBe(true);
    const task = body.data.find((t: any) => t.type === 'task');

    expect(task).toBeDefined();
    expect(task.has_schema).toBe(true);
    expect(task.claim_count).toBe(3);
  });
});

describe('describe-global-field enrichments', () => {
  it('returns claimed_by_types, node_count, and required', async () => {
    const handler = getToolHandler('describe-global-field');
    const body = parseResult(await handler({ name: 'status' }));
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.claimed_by_types).toContain('task');
    expect(result.node_count).toBe(1);
    expect(typeof result.required).toBe('boolean');
  });
});

describe('validate-node', () => {
  it('validates existing node by node_id', async () => {
    const handler = getToolHandler('validate-node');
    const body = parseResult(await handler({ node_id: 'n1' }));
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.valid).toBe(true);
    expect(result.effective_fields).toBeDefined();
    expect(result.orphan_fields).toContain('custom_field');
  });

  it('validates proposed state with coercion', async () => {
    const handler = getToolHandler('validate-node');
    const body = parseResult(await handler({
      proposed: { types: ['task'], fields: { status: 'open', priority: '5' } },
    }));
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.valid).toBe(true);

    // priority was string '5', should be coerced to number 5
    const priorityCoerced = result.coerced_state.priority;
    expect(priorityCoerced).toBeDefined();
    expect(priorityCoerced.changed).toBe(true);
    expect(priorityCoerced.value).toBe(5);
  });
});

describe('vault-stats orphan_count lifecycle', () => {
  it('reflects query-time orphan classification through schema create/delete', async () => {
    const statsHandler = getToolHandler('vault-stats');

    // seedData created: 1 node (n1) with 3 fields (status, priority, custom_field)
    // and a 'task' schema claiming status + priority + due_date.
    // So: status and priority are claimed (2), custom_field is orphan (1).
    const body1 = parseResult(await statsHandler({}) as any) as any;
    expect(body1.ok).toBe(true);
    expect(body1.data.orphan_count).toBe(1); // only custom_field

    // Delete the schema — all 3 fields become orphans
    const deleteHandler = getToolHandler('delete-schema');
    await deleteHandler({ name: 'task' });

    const body2 = parseResult(await statsHandler({}) as any) as any;
    expect(body2.ok).toBe(true);
    expect(body2.data.orphan_count).toBe(3); // all fields are orphans now

    // Re-create the schema — orphan count drops back
    createSchemaDefinition(db, {
      name: 'task',
      display_name: 'Task',
      field_claims: [{ field: 'status' }, { field: 'priority' }, { field: 'due_date' }],
    });

    const body3 = parseResult(await statsHandler({}) as any) as any;
    expect(body3.ok).toBe(true);
    expect(body3.data.orphan_count).toBe(1); // custom_field is orphan again
  });
});
