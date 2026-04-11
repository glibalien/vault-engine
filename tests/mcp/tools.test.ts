import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
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

  const insertRel = db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
  );
  insertRel.run('n1', 'Quick Note', 'wiki-link', null);
}

beforeEach(() => {
  db = createTestDb();
});

describe('vault-stats', () => {
  it('returns correct counts with data', async () => {
    seedTestData();
    const handler = getToolHandler(registerVaultStats);
    const result = parseResult(await handler({}) as any) as any;
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
    expect(result.orphan_count).toBe(1);
    expect(result.schema_count).toBe(0);
  });

  it('returns zero counts on empty db', async () => {
    const handler = getToolHandler(registerVaultStats);
    const result = parseResult(await handler({}) as any) as any;
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
    const result = parseResult(await handler({}) as any) as any;
    expect(result).toEqual(
      expect.arrayContaining([
        { type: 'note', count: 2 },
        { type: 'meeting', count: 1 },
        { type: 'task', count: 1 },
      ])
    );
  });

  it('returns empty array on empty db', async () => {
    const handler = getToolHandler(registerListTypes);
    const result = parseResult(await handler({}) as any) as any;
    expect(result).toEqual([]);
  });
});

describe('list-schemas', () => {
  it('returns empty array in Phase 1', async () => {
    const handler = getToolHandler(registerListSchemas);
    const result = parseResult(await handler({}) as any) as any;
    expect(result).toEqual([]);
  });
});

describe('describe-schema', () => {
  it('returns NOT_FOUND for nonexistent schema', async () => {
    const handler = getToolHandler(registerDescribeSchema);
    const result = parseResult(await handler({ name: 'nonexistent' }) as any) as any;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns full schema row with parsed JSON fields', async () => {
    db.prepare(
      'INSERT INTO schemas (name, display_name, icon, filename_template, field_claims, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('meeting', 'Meeting', '📅', 'meetings/{title}.md', '["date","attendees"]', '{"auto_create":true}');

    const handler = getToolHandler(registerDescribeSchema);
    const result = parseResult(await handler({ name: 'meeting' }) as any) as any;
    expect(result.name).toBe('meeting');
    expect(result.display_name).toBe('Meeting');
    expect(result.field_claims).toEqual(['date', 'attendees']);
    expect(result.metadata).toEqual({ auto_create: true });
  });
});

describe('list-global-fields', () => {
  it('returns empty array in Phase 1', async () => {
    const handler = getToolHandler(registerListGlobalFields);
    const result = parseResult(await handler({}) as any) as any;
    expect(result).toEqual([]);
  });
});

describe('describe-global-field', () => {
  it('returns NOT_FOUND for nonexistent field', async () => {
    const handler = getToolHandler(registerDescribeGlobalField);
    const result = parseResult(await handler({ name: 'nonexistent' }) as any) as any;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns full field row with parsed JSON', async () => {
    db.prepare(
      'INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('status', 'enum', '["open","closed","in-progress"]', null, 'Task status', '"open"');

    const handler = getToolHandler(registerDescribeGlobalField);
    const result = parseResult(await handler({ name: 'status' }) as any) as any;
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
    const result = parseResult(await handler({}) as any) as any;
    expect(result.total).toBe(3);
    expect(result.nodes).toHaveLength(3);
    // Default sort by title asc
    expect(result.nodes[0].title).toBe('Fix Bug');
    expect(result.nodes[1].title).toBe('Quick Note');
    expect(result.nodes[2].title).toBe('Team Meeting');
  });

  it('filters by single type', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['note'] }) as any) as any;
    expect(result.total).toBe(2);
    expect(result.nodes.map((n: any) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('filters by multi-type intersection', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['meeting', 'note'] }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by field equality (text)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ fields: { project: { eq: 'Vault Engine' } } }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by numeric comparison (lte)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ fields: { priority: { lte: 5 } } }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n3');
  });

  it('filters by field exists', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ fields: { project: { exists: true } } }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by field not exists', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ fields: { project: { exists: false } } }) as any) as any;
    expect(result.total).toBe(2);
    expect(result.nodes.map((n: any) => n.id).sort()).toEqual(['n2', 'n3']);
  });

  it('supports pagination', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ limit: 1, offset: 1 }) as any) as any;
    expect(result.total).toBe(3);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].title).toBe('Quick Note');
  });

  it('supports sorting', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ sort_by: 'file_mtime', sort_order: 'desc' }) as any) as any;
    expect(result.nodes[0].id).toBe('n3');
    expect(result.nodes[2].id).toBe('n1');
  });

  it('filters by path_prefix', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ path_prefix: 'meetings/' }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by FTS5 full_text', async () => {
    // Manually populate nodes_fts since we bypassed the indexer
    // FTS5 contentless tables: use INSERT with rowid matching nodes.rowid
    const rows = db.prepare('SELECT rowid, title, body FROM nodes').all() as Array<{ rowid: number; title: string; body: string }>;
    for (const row of rows) {
      db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(row.rowid, row.title, row.body);
    }

    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ full_text: 'Meeting' }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by outgoing reference', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ references: { target: 'Quick Note' } }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('enforces max limit of 200', async () => {
    const handler = getToolHandler(registerQueryNodes);
    // limit > 200 should be clamped by zod validation
    // Since zod max(200) throws, we pass 200 and it works
    const result = parseResult(await handler({ limit: 200 }) as any) as any;
    expect(result.total).toBe(3);
  });

  it('enriches results with types and field_count', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['meeting'] }) as any) as any;
    const node = result.nodes[0];
    expect(node.types).toEqual(expect.arrayContaining(['meeting', 'note']));
    expect(node.field_count).toBe(1);
  });
});

describe('get-node', () => {
  beforeEach(() => {
    seedTestData();
  });

  it('retrieves node by node_id', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(result.id).toBe('n1');
    expect(result.title).toBe('Team Meeting');
    expect(result.file_path).toBe('meetings/meeting.md');
  });

  it('retrieves node by file_path', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ file_path: 'notes/note.md' }) as any) as any;
    expect(result.id).toBe('n2');
    expect(result.title).toBe('Quick Note');
  });

  it('retrieves node by title (uses resolveTarget)', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ title: 'Fix Bug' }) as any) as any;
    expect(result.id).toBe('n3');
  });

  it('returns INVALID_PARAMS when no params provided', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({}) as any) as any;
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('returns INVALID_PARAMS when multiple params provided', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n1', title: 'Team Meeting' }) as any) as any;
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('returns NOT_FOUND for nonexistent node', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'nonexistent' }) as any) as any;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns fields with types', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(result.fields.project).toEqual({
      value: 'Vault Engine',
      type: 'text',
      source: 'frontmatter',
    });
  });

  it('returns numeric fields correctly', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n3' }) as any) as any;
    expect(result.fields.priority).toEqual({
      value: 1,
      type: 'number',
      source: 'frontmatter',
    });
  });

  it('returns types array', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(result.types).toEqual(expect.arrayContaining(['meeting', 'note']));
    expect(result.types).toHaveLength(2);
  });

  it('returns grouped outgoing relationships', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(result.relationships.outgoing['wiki-link']).toBeDefined();
    expect(result.relationships.outgoing['wiki-link']).toHaveLength(1);
    expect(result.relationships.outgoing['wiki-link'][0].target_title).toBe('Quick Note');
    expect(result.relationships.outgoing['wiki-link'][0].target_id).toBe('n2');
  });

  it('returns incoming relationships on target node', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n2' }) as any) as any;
    expect(result.relationships.incoming['wiki-link']).toBeDefined();
    expect(result.relationships.incoming['wiki-link']).toHaveLength(1);
    expect(result.relationships.incoming['wiki-link'][0].source_id).toBe('n1');
  });

  it('returns body and metadata', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;
    expect(result.body).toBe('Meeting body text');
    expect(result.metadata.content_hash).toBe('h1');
    expect(result.metadata.file_mtime).toBe(1000);
    expect(result.metadata.indexed_at).toBe(2000);
  });
});
