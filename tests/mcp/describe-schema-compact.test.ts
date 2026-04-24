import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getHandler() {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      capturedHandler = (args) => h(args);
    },
  } as unknown as McpServer;
  registerDescribeSchema(fakeServer, db);
  return capturedHandler!;
}

function seedTaskSchema() {
  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'done'],
    default_value: 'open',
    required: true,
  });
  createGlobalField(db, {
    name: 'priority',
    field_type: 'number',
    description: 'Priority 1-5',
  });
  createGlobalField(db, {
    name: 'project',
    field_type: 'reference',
    reference_target: 'project',
  });

  createSchemaDefinition(db, {
    name: 'task',
    display_name: 'Task',
    icon: 'check',
    default_directory: 'TaskNotes/Tasks',
    field_claims: [
      { field: 'status', sort_order: 1 },
      { field: 'priority', sort_order: 2 },
      { field: 'project', sort_order: 3 },
    ],
  });
}

beforeEach(() => {
  db = createTestDb();
});

describe('describe-schema compact default shape', () => {
  it('omits field_coverage, orphan_field_names, and node_count when include is not passed', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task' }) as any);

    expect(body.ok).toBe(true);
    expect(body.data.field_coverage).toBeUndefined();
    expect(body.data.orphan_field_names).toBeUndefined();
    expect(body.data.node_count).toBeUndefined();
  });

  it('returns fields array with name/type/required/default_value resolved inline, no global_field block', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task' }) as any);

    expect(body.data.fields).toBeInstanceOf(Array);
    expect(body.data.fields).toHaveLength(3);
    expect(body.data.field_claims).toBeUndefined();

    const status = body.data.fields[0];
    expect(status.name).toBe('status');
    expect(status.type).toBe('enum');
    expect(status.enum_values).toEqual(['open', 'done']);
    expect(status.required).toBe(true);
    expect(status.default_value).toBe('open');

    // Compact shape: no nested global_field / resolved / override scaffolding
    expect(status.global_field).toBeUndefined();
    expect(status.resolved).toBeUndefined();
    expect(status.required_override).toBeUndefined();
    expect(status.default_value_override).toBeUndefined();
    expect(status.enum_values_override).toBeUndefined();
    expect(status.sort_order).toBeUndefined();
  });

  it('includes reference_target on reference-typed fields', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task' }) as any);

    const project = body.data.fields.find((f: any) => f.name === 'project');
    expect(project.type).toBe('reference');
    expect(project.reference_target).toBe('project');
  });

  it('omits enum_values, reference_target, list_item_type on fields that do not use them', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task' }) as any);

    const priority = body.data.fields.find((f: any) => f.name === 'priority');
    expect(priority.type).toBe('number');
    expect(priority.enum_values).toBeUndefined();
    expect(priority.reference_target).toBeUndefined();
    expect(priority.list_item_type).toBeUndefined();
  });

  it('omits description/label when null, includes them when non-null', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task' }) as any);

    const status = body.data.fields.find((f: any) => f.name === 'status');
    // Global field has no description → omitted
    expect(status.description).toBeUndefined();
    expect(status.label).toBeUndefined();

    const priority = body.data.fields.find((f: any) => f.name === 'priority');
    // Global field has description set → present
    expect(priority.description).toBe('Priority 1-5');
  });

  it('preserves top-level schema metadata (name, display_name, icon, default_directory)', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task' }) as any);

    expect(body.data.name).toBe('task');
    expect(body.data.display_name).toBe('Task');
    expect(body.data.icon).toBe('check');
    expect(body.data.default_directory).toBe('TaskNotes/Tasks');
  });
});

describe('describe-schema include:coverage', () => {
  it('adds node_count and field_coverage when include:["coverage"]', async () => {
    seedTaskSchema();
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n1', 'a.md', 'A', '', 'h', 1, 2);
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n1', 'task');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n1', 'status', 'open', null, null, null, 'frontmatter');

    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task', include: ['coverage'] }) as any);

    expect(body.data.node_count).toBe(1);
    expect(body.data.field_coverage.status).toEqual({ have_value: 1, total: 1 });
    expect(body.data.field_coverage.priority).toEqual({ have_value: 0, total: 1 });

    // Orphans and overrides not requested → still omitted
    expect(body.data.orphan_field_names).toBeUndefined();
  });
});

describe('describe-schema include:orphans', () => {
  it('adds orphan_field_names when include:["orphans"]', async () => {
    seedTaskSchema();
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n1', 'a.md', 'A', '', 'h', 1, 2);
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n1', 'task');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n1', 'unexpected', 'x', null, null, null, 'orphan');

    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task', include: ['orphans'] }) as any);

    expect(body.data.orphan_field_names).toContainEqual({ field: 'unexpected', count: 1 });
    expect(body.data.node_count).toBeUndefined();
    expect(body.data.field_coverage).toBeUndefined();
  });
});

describe('describe-schema include:overrides', () => {
  it('adds per-field override detail and global_field block when include:["overrides"]', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({ name: 'task', include: ['overrides'] }) as any);

    const status = body.data.fields.find((f: any) => f.name === 'status');
    expect(status.global_field).toBeDefined();
    expect(status.global_field.field_type).toBe('enum');
    expect(status.global_field.enum_values).toEqual(['open', 'done']);
    expect(status.global_field.overrides_allowed).toBeDefined();
    expect(status.required_override).toBeNull();
    expect(status.default_value_override).toEqual({ overridden: false });
    expect(status.enum_values_override).toBeNull();
  });
});

describe('describe-schema combined includes', () => {
  it('supports include:["coverage","orphans","overrides"] to mirror full audit shape', async () => {
    seedTaskSchema();
    const handler = getHandler();
    const body = parseResult(await handler({
      name: 'task',
      include: ['coverage', 'orphans', 'overrides'],
    }) as any);

    expect(body.data.node_count).toBeDefined();
    expect(body.data.field_coverage).toBeDefined();
    expect(body.data.orphan_field_names).toBeDefined();
    expect(body.data.fields[0].global_field).toBeDefined();
  });
});
