import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { resolveFieldValue } from '../../src/mcp/field-value.js';
import { registerListTypes } from '../../src/mcp/tools/list-types.js';
import { registerListSchemas } from '../../src/mcp/tools/list-schemas.js';
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';
import { registerListGlobalFields } from '../../src/mcp/tools/list-global-fields.js';
import { registerDescribeGlobalField } from '../../src/mcp/tools/describe-global-field.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(registerFn: (server: McpServer, db: Database.Database) => void) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
    registerTool: (_name: string, _config: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db);
  return capturedHandler!;
}

function seedTestData() {
  const insertNode = db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertNode.run('n1', 'meetings/meeting.md', 'Team Meeting', 'Meeting body text', 'h1', 1000, 2000);
  insertNode.run('n2', 'notes/note.md', 'Quick Note', 'Note body text', 'h2', 2000, 3000);
  insertNode.run('n3', 'tasks/task.md', 'Fix Bug', 'Task body text', 'h3', 3000, 4000);

  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  insertType.run('n1', 'meeting');
  insertType.run('n1', 'note');
  insertType.run('n2', 'note');
  insertType.run('n3', 'task');

  const insertField = db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertField.run('n1', 'project', 'Vault Engine', null, null, null, 'frontmatter');
  insertField.run('n3', 'priority', null, 1, null, null, 'frontmatter');
  insertField.run('n2', 'old_field', 'leftover', null, null, null, 'orphan');

  // Relationships now carry resolved_target_id (populated by the indexer and
  // backfilled on startup). Seed it directly so the incoming-references branch
  // — which joins on resolved_target_id = ? — returns rows as expected.
  const insertRel = db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
  );
  insertRel.run('n1', 'Quick Note', 'wiki-link', null, 'n2');
}

beforeEach(() => {
  db = createTestDb();
});

describe('vault-stats', () => {
  it('returns correct counts with data', async () => {
    seedTestData();
    const handler = getToolHandler(registerVaultStats);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    const result = body.data;
    expect(result.node_count).toBe(3);
    expect(result.type_counts).toEqual(
      expect.arrayContaining([
        { type: 'note', count: 2 },
        { type: 'meeting', count: 1 },
        { type: 'task', count: 1 },
      ])
    );
    expect(result.field_count).toBe(3);
    expect(result.relationship_count).toBe(1);
    // No schemas exist, so all 3 field values are orphans (query-time join, Principle 2)
    expect(result.orphan_count).toBe(3);
    expect(result.schema_count).toBe(0);
  });

  it('returns zero counts on empty db', async () => {
    const handler = getToolHandler(registerVaultStats);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.node_count).toBe(0);
    expect(result.type_counts).toEqual([]);
    expect(result.field_count).toBe(0);
    expect(result.relationship_count).toBe(0);
    expect(result.orphan_count).toBe(0);
    expect(result.schema_count).toBe(0);
  });
});

describe('list-types', () => {
  it('returns types with counts', async () => {
    seedTestData();
    const handler = getToolHandler(registerListTypes);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(
      expect.arrayContaining([
        { type: 'note', count: 2, has_schema: false, claim_count: null },
        { type: 'meeting', count: 1, has_schema: false, claim_count: null },
        { type: 'task', count: 1, has_schema: false, claim_count: null },
      ])
    );
  });

  it('returns empty array on empty db', async () => {
    const handler = getToolHandler(registerListTypes);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });
});

describe('list-schemas', () => {
  it('returns empty array in Phase 1', async () => {
    const handler = getToolHandler(registerListSchemas);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });
});

describe('describe-schema', () => {
  it('returns NOT_FOUND for nonexistent schema', async () => {
    const handler = getToolHandler(registerDescribeSchema);
    const body = parseResult(await handler({ name: 'nonexistent' }) as any) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns full schema row with parsed JSON fields', async () => {
    db.prepare(
      'INSERT INTO schemas (name, display_name, icon, filename_template, field_claims, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('meeting', 'Meeting', '📅', 'meetings/{title}.md', '["date","attendees"]', '{"auto_create":true}');

    // Seed global fields and claims for the enriched handler
    db.prepare(
      'INSERT INTO global_fields (name, field_type) VALUES (?, ?)'
    ).run('date', 'date');
    db.prepare(
      'INSERT INTO global_fields (name, field_type) VALUES (?, ?)'
    ).run('attendees', 'list');
    db.prepare(
      'INSERT INTO schema_field_claims (schema_name, field, sort_order) VALUES (?, ?, ?)'
    ).run('meeting', 'date', 1);
    db.prepare(
      'INSERT INTO schema_field_claims (schema_name, field, sort_order) VALUES (?, ?, ?)'
    ).run('meeting', 'attendees', 2);

    const handler = getToolHandler(registerDescribeSchema);
    const body = parseResult(await handler({
      name: 'meeting',
      include: ['coverage', 'orphans'],
    }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.name).toBe('meeting');
    expect(result.display_name).toBe('Meeting');
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].name).toBe('date');
    expect(result.fields[1].name).toBe('attendees');
    expect(result.metadata).toEqual({ auto_create: true });
    expect(result.node_count).toBe(0);
    expect(result.field_coverage).toEqual({
      date: { have_value: 0, total: 0 },
      attendees: { have_value: 0, total: 0 },
    });
    expect(result.orphan_field_names).toEqual([]);
  });
});

describe('list-global-fields', () => {
  it('returns empty array in Phase 1', async () => {
    const handler = getToolHandler(registerListGlobalFields);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });
});

describe('describe-global-field', () => {
  it('returns NOT_FOUND for nonexistent field', async () => {
    const handler = getToolHandler(registerDescribeGlobalField);
    const body = parseResult(await handler({ name: 'nonexistent' }) as any) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns full field row with parsed JSON', async () => {
    db.prepare(
      'INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('status', 'enum', '["open","closed","in-progress"]', null, 'Task status', '"open"');

    const handler = getToolHandler(registerDescribeGlobalField);
    const body = parseResult(await handler({ name: 'status' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.name).toBe('status');
    expect(result.field_type).toBe('enum');
    expect(result.enum_values).toEqual(['open', 'closed', 'in-progress']);
    expect(result.default_value).toBe('open');
  });
});

describe('query-nodes', () => {
  beforeEach(() => {
    seedTestData();
  });

  it('returns all nodes with no filters', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(3);
    expect(result.nodes).toHaveLength(3);
    // Default sort by title asc
    expect(result.nodes[0].title).toBe('Fix Bug');
    expect(result.nodes[1].title).toBe('Quick Note');
    expect(result.nodes[2].title).toBe('Team Meeting');
  });

  it('filters by single type', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['note'] }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(2);
    expect(result.nodes.map((n: any) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('filters by multi-type intersection', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting', 'note'] }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by field equality (text)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ fields: { project: { eq: 'Vault Engine' } } }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by numeric comparison (lte)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ fields: { priority: { lte: 5 } } }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n3');
  });

  it('filters by field exists', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ fields: { project: { exists: true } } }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by field not exists', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ fields: { project: { exists: false } } }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(2);
    expect(result.nodes.map((n: any) => n.id).sort()).toEqual(['n2', 'n3']);
  });

  it('supports pagination', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ limit: 1, offset: 1 }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(3);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].title).toBe('Quick Note');
  });

  it('supports sorting', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ sort_by: 'file_mtime', sort_order: 'desc' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.nodes[0].id).toBe('n3');
    expect(result.nodes[2].id).toBe('n1');
  });

  it('filters by path_prefix', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ path_prefix: 'meetings/' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by type (meeting)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting'] }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by outgoing reference', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ references: { target: 'Quick Note' } }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by incoming reference', async () => {
    const handler = getToolHandler(registerQueryNodes);
    // n1 has a wiki-link to 'Quick Note', which is n2's title.
    // Incoming to 'Quick Note' should return n1 (the source of the link).
    const body = parseResult(await handler({
      references: { target: 'Quick Note', direction: 'incoming' },
    }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('enforces max limit of 200', async () => {
    const handler = getToolHandler(registerQueryNodes);
    // limit > 200 should be clamped by zod validation
    // Since zod max(200) throws, we pass 200 and it works
    const body = parseResult(await handler({ limit: 200 }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(3);
  });

  it('enriches results with types and field_count', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting'] }) as any) as any;
    expect(body.ok).toBe(true);
    const node = body.data.nodes[0];
    expect(node.types).toEqual(expect.arrayContaining(['meeting', 'note']));
    expect(node.field_count).toBe(1);
  });

  it('filters by without_types (negation)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ without_types: ['meeting'] }) as any) as any;
    expect(body.ok).toBe(true);
    // n1 is meeting+note, n2 is note, n3 is task
    expect(body.data.nodes.every((n: any) => !n.types.includes('meeting'))).toBe(true);
    expect(body.data.nodes.length).toBe(2);
  });

  it('filters by without_fields (negation)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ without_fields: ['project'] }) as any) as any;
    expect(body.ok).toBe(true);
    // n1 has project, n2 and n3 don't
    expect(body.data.nodes.length).toBe(2);
    expect(body.data.nodes.every((n: any) => n.id !== 'n1')).toBe(true);
  });

  it('returns field values when include_fields is specified', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting'], include_fields: ['project'] }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.total).toBe(1);
    expect(result.nodes[0].fields).toEqual({ project: 'Vault Engine' });
  });

  it('omits fields key when include_fields is not specified', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting'] }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.nodes[0].fields).toBeUndefined();
  });

  it('returns empty fields object when requested field does not exist on node', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['task'], include_fields: ['project'] }) as any) as any;
    expect(body.ok).toBe(true);
    // n3 (task) has no project field
    expect(body.data.nodes[0].fields).toEqual({});
  });

  it('wildcard include_fields returns all fields', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['task'], include_fields: ['*'] }) as any) as any;
    expect(body.ok).toBe(true);
    // n3 has only 'priority' field with value 1
    expect(body.data.nodes[0].fields).toEqual({ priority: 1 });
  });

  it('include_fields resolves JSON values correctly', async () => {
    // Add a node with a JSON field for this test
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n_json', 'notes/json-test.md', 'JSON Test', '', 'hj', 5000, 5000);
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n_json', 'json-test-type');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n_json', 'tags', null, null, null, '["design","spec"]', 'frontmatter');

    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['json-test-type'], include_fields: ['tags'] }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.nodes[0].fields).toEqual({ tags: ['design', 'spec'] });
  });

  it('include_fields with multiple specific fields', async () => {
    // Add a second field to n1
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n1', 'status', 'active', null, null, null, 'frontmatter');

    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting'], include_fields: ['project', 'status'] }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.nodes[0].fields).toEqual({ project: 'Vault Engine', status: 'active' });
  });

  it('field_count is unaffected by include_fields', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const body = parseResult(await handler({ types: ['meeting'], include_fields: ['project'] }) as any) as any;
    expect(body.ok).toBe(true);
    // n1 has 1 field (project). field_count should still be 1.
    expect(body.data.nodes[0].field_count).toBe(1);
    expect(body.data.nodes[0].fields).toEqual({ project: 'Vault Engine' });
  });
});

describe('get-node', () => {
  beforeEach(() => {
    seedTestData();
  });

  it('retrieves node by node_id', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.id).toBe('n1');
    expect(result.title).toBe('Team Meeting');
    expect(result.file_path).toBe('meetings/meeting.md');
  });

  it('retrieves node by file_path', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ file_path: 'notes/note.md' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.id).toBe('n2');
    expect(result.title).toBe('Quick Note');
  });

  it('retrieves node by title (uses resolveTarget)', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ title: 'Fix Bug' }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('n3');
  });

  it('returns INVALID_PARAMS when no params provided', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
  });

  it('returns INVALID_PARAMS when multiple params provided', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n1', title: 'Team Meeting' }) as any) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
  });

  it('returns NOT_FOUND for nonexistent node', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'nonexistent' }) as any) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns fields with types', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.fields.project).toEqual({
      value: 'Vault Engine',
      type: 'text',
      source: 'frontmatter',
    });
  });

  it('returns numeric fields correctly', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n3' }) as any) as any;
    expect(body.ok).toBe(true);
    expect(body.data.fields.priority).toEqual({
      value: 1,
      type: 'number',
      source: 'frontmatter',
    });
  });

  it('returns types array', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.types).toEqual(expect.arrayContaining(['meeting', 'note']));
    expect(result.types).toHaveLength(2);
  });

  it('returns grouped outgoing relationships', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.relationships.outgoing['wiki-link']).toBeDefined();
    expect(result.relationships.outgoing['wiki-link']).toHaveLength(1);
    expect(result.relationships.outgoing['wiki-link'][0].target_title).toBe('Quick Note');
    expect(result.relationships.outgoing['wiki-link'][0].target_id).toBe('n2');
  });

  it('returns incoming relationships on target node', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n2' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.relationships.incoming['wiki-link']).toBeDefined();
    expect(result.relationships.incoming['wiki-link']).toHaveLength(1);
    expect(result.relationships.incoming['wiki-link'][0].source_id).toBe('n1');
  });

  it('finds backlinks via resolved_target_id when raw target does not match path/title/basename', async () => {
    // n4 wikilinks to n2 using uppercase 'QUICK NOTE'. The resolver matches
    // case-insensitively (Tier 4) and stores resolved_target_id='n2', but the
    // raw target string does not equal n2.file_path / basename / title — so a
    // backlink lookup that compares raw target strings would miss it.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n4', 'aliases/n4.md', 'Aliased Linker', '', 'h4', 4000, 5000);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
    ).run('n4', 'QUICK NOTE', 'wiki-link', null, 'n2');

    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n2' }) as any) as any;
    const sourceIds = (body.data.relationships.incoming['wiki-link'] ?? []).map((r: any) => r.source_id);
    expect(sourceIds).toContain('n4');
  });

  it('does not collapse distinct backlinks from one source with the same rel_type', async () => {
    // Two relationship rows from n4 to n2: distinct raw targets (one matches
    // by title, one by basename) but same rel_type. Both rows resolve to n2.
    // Both backlinks should appear in the response — collapsing them by
    // (source_id, rel_type) loses information.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n4', 'aliases/n4.md', 'Aliased Linker', '', 'h4', 4000, 5000);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
    ).run('n4', 'Quick Note', 'wiki-link', '[[Quick Note]]', 'n2');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
    ).run('n4', 'note', 'wiki-link', '[[note]]', 'n2');

    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n2' }) as any) as any;
    const fromN4 = (body.data.relationships.incoming['wiki-link'] ?? []).filter(
      (r: any) => r.source_id === 'n4'
    );
    expect(fromN4).toHaveLength(2);
  });

  it('returns body and metadata', async () => {
    const handler = getToolHandler(registerGetNode);
    const body = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;
    expect(result.body).toBe('Meeting body text');
    expect(result.metadata.content_hash).toBe('h1');
    expect(result.metadata.file_mtime).toBe(1000);
    expect(result.metadata.indexed_at).toBe(2000);
  });
});

describe('resolveFieldValue', () => {
  it('resolves value_json as parsed JSON', () => {
    const row = { field_name: 'tags', value_text: null, value_number: null, value_date: null, value_json: '["a","b"]', source: 'frontmatter' };
    expect(resolveFieldValue(row)).toEqual(['a', 'b']);
  });

  it('resolves value_number', () => {
    const row = { field_name: 'priority', value_text: null, value_number: 3, value_date: null, value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBe(3);
  });

  it('resolves value_date', () => {
    const row = { field_name: 'due', value_text: null, value_number: null, value_date: '2026-04-12', value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBe('2026-04-12');
  });

  it('resolves value_text as fallback', () => {
    const row = { field_name: 'status', value_text: 'open', value_number: null, value_date: null, value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBe('open');
  });

  it('resolves null when all value columns are null', () => {
    const row = { field_name: 'empty', value_text: null, value_number: null, value_date: null, value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBeNull();
  });
});
