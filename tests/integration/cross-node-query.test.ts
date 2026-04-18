import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

let db: Database.Database;
let vault: string;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function captureHandler() {
  let h!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, cb: (...a: unknown[]) => unknown) => {
      h = (args) => cb(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  // registerQueryNodes signature is (server, db, embeddingIndexer?, embedder?).
  // Integration tests exercise the structured path; no embedder needed.
  registerQueryNodes(fakeServer, db);
  return h;
}

function seedNode(id: string, filePath: string, title: string, types: string[], fields: Record<string, string>) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, '', null, null, null);
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

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'xq-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  // Fixture: tasks + projects + people + companies.
  seedNode('p1', 'Projects/P1.md', 'P1', ['project'], { status: 'done' });
  seedNode('p2', 'Projects/P2.md', 'P2', ['project'], { status: 'todo' });
  seedNode('t1', 'Tasks/T1.md', 'T1', ['task'], { status: 'open' });
  seedNode('t2', 'Tasks/T2.md', 'T2', ['task'], { status: 'open' });
  seedNode('t3', 'Tasks/T3.md', 'T3', ['task'], { status: 'open' });
  seedNode('acme', 'People/Acme.md', 'Acme Corp', ['company'], {});
  seedNode('alice', 'People/Alice.md', 'Alice', ['person'], { company: 'Acme' });
  seedNode('m1', 'Meetings/M1.md', 'M1', ['meeting'], {});
  seedRel('t1', 'P1', 'project', 'p1');
  seedRel('t2', 'P2', 'project', 'p2');
  seedRel('t3', 'GhostProject', 'project', null); // unresolved
  seedRel('m1', 'Alice', 'wiki-link', 'alice');

  handler = captureHandler();
});

afterEach(() => {
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

describe('cross-node query integration', () => {
  it('open tasks whose linked project is done', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      fields: { status: { eq: 'open' } },
      join_filters: [{ rel_type: 'project', target: { types: ['project'], fields: { status: { eq: 'done' } } } }],
    }));
    const ids = (r.nodes as Array<{ id: string }>).map(n => n.id).sort();
    expect(ids).toEqual(['t1']);
  });

  it('without_joins: tasks with no done-project edge', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      without_joins: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
    }));
    const ids = (r.nodes as Array<{ id: string }>).map(n => n.id).sort();
    expect(ids).toEqual(['t2', 't3']);
  });

  it('incoming: projects with >=1 open task', async () => {
    const r = parseResult(await handler({
      types: ['project'],
      join_filters: [{
        direction: 'incoming',
        rel_type: 'project',
        target: { types: ['task'], fields: { status: { eq: 'open' } } },
      }],
    }));
    const ids = (r.nodes as Array<{ id: string }>).map(n => n.id).sort();
    expect(ids).toEqual(['p1', 'p2']);
  });

  it('no rel_type: meetings linked to any person at Acme', async () => {
    const r = parseResult(await handler({
      types: ['meeting'],
      join_filters: [{
        target: { types: ['person'], fields: { company: { eq: 'Acme' } } },
      }],
    }));
    const ids = (r.nodes as Array<{ id: string }>).map(n => n.id).sort();
    expect(ids).toEqual(['m1']);
  });

  it('surfaces notice when unresolved edges could have affected results', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
    }));
    expect(r.notice).toContain('unresolved');
    expect((r.notice as string)).toMatch(/1 candidate edge/);
  });

  it('no notice when join_filter has no target (only rel_type filter)', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      join_filters: [{ rel_type: 'project' }],
    }));
    expect(r.notice).toBeUndefined();
  });

  it('composition: top-level fields + join_filters + without_joins in one query', async () => {
    // Add a task linked to a done project AND an engineer assignee — t1 only qualifies.
    seedNode('u1', 'People/U1.md', 'U1', ['person'], { role: 'engineer' });
    seedRel('t1', 'U1', 'assignee', 'u1');
    seedRel('t2', 'U1', 'assignee', 'u1');

    const r = parseResult(await handler({
      types: ['task'],
      fields: { status: { eq: 'open' } },
      join_filters: [
        { rel_type: 'project', target: { fields: { status: { eq: 'done' } } } },
        { rel_type: 'assignee', target: { fields: { role: { eq: 'engineer' } } } },
      ],
      without_joins: [
        { rel_type: 'project', target: { fields: { status: { eq: 'todo' } } } },
      ],
    }));
    const ids = (r.nodes as Array<{ id: string }>).map(n => n.id).sort();
    expect(ids).toEqual(['t1']);
  });

  it('references still works (backward compat via resolved_target_id internally)', async () => {
    const r = parseResult(await handler({
      references: { target: 'P1', direction: 'outgoing' },
    }));
    const ids = (r.nodes as Array<{ id: string }>).map(n => n.id).sort();
    expect(ids).toEqual(['t1']);
  });

  it('pagination count is correct with join_filters', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      join_filters: [{ rel_type: 'project' }],
      limit: 1,
    }));
    expect(r.total).toBe(2); // t1 and t2, not t3 (unresolved edge invisible)
  });
});
