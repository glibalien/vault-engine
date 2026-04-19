import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';

let db: Database.Database;
let vault: string;
let cleanup: () => void;
let lock: WriteLockManager;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function seedNode(id: string, file: string, title: string, types: string[], fields: Record<string, string>) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, file, title, '', null, null, null);
  const ty = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const t of types) ty.run(id, t);
  const fld = db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [k, v] of Object.entries(fields)) fld.run(id, k, v, null, null, null, 'yaml');
}

function seedRel(src: string, target: string, relType: string, resolved: string | null) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
  ).run(src, target, relType, resolved);
}

function captureHandler() {
  let h!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, cb: (...a: unknown[]) => unknown) => {
      h = (args) => cb(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, lock, vault);
  return h;
}

beforeEach(() => {
  ({ vaultPath: vault, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  lock = new WriteLockManager();
  // Seed schemas for all types referenced by fixture + mutations.
  const insertSchema = db.prepare('INSERT INTO schemas (name) VALUES (?)');
  for (const s of ['project', 'task', 'urgent', 'deprioritized']) insertSchema.run(s);
  // Fixture.
  seedNode('p1', 'Projects/P1.md', 'P1', ['project'], { status: 'done' });
  seedNode('p2', 'Projects/P2.md', 'P2', ['project'], { status: 'todo' });
  seedNode('t1', 'Tasks/T1.md', 'T1', ['task'], { status: 'open' });
  seedNode('t2', 'Tasks/T2.md', 'T2', ['task'], { status: 'open' });
  seedRel('t1', 'P1', 'project', 'p1');
  seedRel('t2', 'P2', 'project', 'p2');

  handler = captureHandler();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node query mode with join_filters', () => {
  it('dry_run with join_filters returns correct affected set + CROSS_NODE_FILTER_UNRESOLVED warning', async () => {
    // Seed an unresolved edge on the rel_type we filter by so the warning fires.
    seedRel('t1', 'Missing', 'project', null);

    const body = parseResult(await handler({
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['urgent'],
      dry_run: true,
    }));
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.dry_run).toBe(true);
    expect(data.matched).toBe(1);
    const preview = data.preview as Array<{ node_id: string }>;
    expect(preview.map(p => p.node_id)).toEqual(['t1']);
    const warnings = body.warnings as Array<{ code: string; severity: string; message: string; details: { edges: string[] } }>;
    const warn = warnings.find(w => w.code === 'CROSS_NODE_FILTER_UNRESOLVED');
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe('warning');
    expect(warn!.message).toBe('Could not resolve cross-node filter edges: project');
    expect(warn!.details.edges).toEqual(['project']);
  });

  it('without_joins query mode returns correct affected set', async () => {
    const body = parseResult(await handler({
      query: {
        types: ['task'],
        without_joins: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['deprioritized'],
      dry_run: true,
    }));
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.matched).toBe(1);
    expect((data.preview as Array<{ node_id: string }>).map(p => p.node_id)).toEqual(['t2']);
  });

  it('dry_run: false applies mutation to exactly the previewed set', async () => {
    // First, check what dry_run returns.
    const dryBody = parseResult(await handler({
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['urgent'],
      dry_run: true,
    }));
    expect(dryBody.ok).toBe(true);
    const dryData = dryBody.data as Record<string, unknown>;
    expect(dryData.matched).toBe(1);

    // Apply.
    parseResult(await handler({
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['urgent'],
      dry_run: false,
    }));

    // Only t1 should have 'urgent' type added.
    const types1 = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all('t1') as Array<{ schema_type: string }>;
    const types2 = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all('t2') as Array<{ schema_type: string }>;
    expect(types1.map(t => t.schema_type).sort()).toContain('urgent');
    expect(types2.map(t => t.schema_type)).not.toContain('urgent');
  });
});
