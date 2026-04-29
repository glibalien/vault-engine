import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addGlobalFieldUndoSnapshots, addUndoTables } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerUpdateGlobalField } from '../../src/mcp/tools/update-global-field.js';

let db: Database.Database;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (
      _name: string,
      _desc: string,
      _schema: unknown,
      h: (...a: unknown[]) => unknown,
    ) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  // No ctx — skips file-render branch in the handler so the test stays in-memory.
  registerUpdateGlobalField(fakeServer, db);
  return captured!;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addGlobalFieldUndoSnapshots(db);

  createGlobalField(db, { name: 'count', field_type: 'string' });

  db.prepare(`INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`).run('n1', '/n1.md', 'n1');
  db.prepare(`INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)`)
    .run('n1', 'count', '42');
  db.prepare(`INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`).run('n2', '/n2.md', 'n2');
  db.prepare(`INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)`)
    .run('n2', 'count', 'not-a-number');
});

afterEach(() => {
  db.close();
});

describe('update-global-field discard gate', () => {
  it('returns CONFIRMATION_REQUIRED with uncoercible details when no flag is set', async () => {
    const handler = getHandler();
    const result = await handler({ name: 'count', field_type: 'number', confirm: true });
    const env = parseResult(result);

    expect(env.ok).toBe(false);
    const error = env.error as { code: string; message: string; details: Record<string, unknown> };
    expect(error.code).toBe('CONFIRMATION_REQUIRED');
    expect(error.details.affected_nodes).toBe(2);
    expect(error.details.coercible_count).toBe(1);

    const uncoercible = error.details.uncoercible as Array<{ node_id: string; value: unknown; reason: string }>;
    expect(uncoercible).toHaveLength(1);
    expect(uncoercible[0].node_id).toBe('n2');
    expect(uncoercible[0].value).toBe('not-a-number');
    expect(typeof uncoercible[0].reason).toBe('string');

    const field = db.prepare(`SELECT field_type FROM global_fields WHERE name = 'count'`).get() as { field_type: string };
    expect(field.field_type).toBe('string');
  });

  it('preview mode does not create an undo operation', async () => {
    const handler = getHandler();
    const before = (db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get() as { c: number }).c;
    const result = await handler({ name: 'count', field_type: 'number' });
    const env = parseResult(result);

    expect(env.ok).toBe(true);
    expect((env.data as { preview: boolean }).preview).toBe(true);
    const after = (db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('applies the type change when discard_uncoercible:true is passed', async () => {
    const handler = getHandler();
    const result = await handler({
      name: 'count',
      field_type: 'number',
      confirm: true,
      discard_uncoercible: true,
    });
    const env = parseResult(result);

    expect(env.ok).toBe(true);
    const data = env.data as { applied: boolean; uncoercible: unknown[] };
    expect(data.applied).toBe(true);
    expect(data.uncoercible).toHaveLength(1);

    const field = db.prepare(`SELECT field_type FROM global_fields WHERE name = 'count'`).get() as { field_type: string };
    expect(field.field_type).toBe('number');

    const n2 = db.prepare(`SELECT * FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`).get();
    expect(n2).toBeUndefined();
  });

  it('applies normally when there are no uncoercible values, no flag needed', async () => {
    db.prepare(`UPDATE node_fields SET value_text = '7' WHERE node_id = 'n2' AND field_name = 'count'`).run();

    const handler = getHandler();
    const result = await handler({ name: 'count', field_type: 'number', confirm: true });
    const env = parseResult(result);

    expect(env.ok).toBe(true);
    expect((env.data as { applied: boolean }).applied).toBe(true);
  });
});
