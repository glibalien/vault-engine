import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { validateUiHints, normalizeUiHints, UI_WIDGETS } from '../../src/global-fields/ui-hints.js';
import { createGlobalField, getGlobalField, updateGlobalField, renameGlobalField } from '../../src/global-fields/crud.js';

describe('addUiHints migration', () => {
  it('adds ui_hints column to global_fields', () => {
    const db = new Database(':memory:');
    createSchema(db);
    addUiHints(db);
    const cols = (db.prepare('PRAGMA table_info(global_fields)').all() as Array<{ name: string }>)
      .map(c => c.name);
    expect(cols).toContain('ui_hints');
  });

  it('is idempotent — running twice does not throw', () => {
    const db = new Database(':memory:');
    createSchema(db);
    addUiHints(db);
    expect(() => addUiHints(db)).not.toThrow();
  });

  it('leaves existing rows with NULL ui_hints', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(
      `INSERT INTO global_fields (name, field_type) VALUES ('status', 'string')`
    ).run();
    addUiHints(db);
    const row = db.prepare(`SELECT ui_hints FROM global_fields WHERE name = 'status'`).get() as { ui_hints: string | null };
    expect(row.ui_hints).toBeNull();
  });
});

describe('UiHints validator', () => {
  it('accepts a fully-populated valid hint object', () => {
    const result = validateUiHints({ widget: 'enum', label: 'Status', help: 'Workflow state', order: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ widget: 'enum', label: 'Status', help: 'Workflow state', order: 10 });
    }
  });

  it('accepts an empty object as valid', () => {
    const result = validateUiHints({});
    expect(result.ok).toBe(true);
  });

  it('accepts a partial object (subset of keys)', () => {
    const result = validateUiHints({ label: 'Title only' });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown keys', () => {
    const result = validateUiHints({ widget: 'text', made_up: 'nope' } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown key/i);
  });

  it('rejects out-of-enum widget', () => {
    const result = validateUiHints({ widget: 'rainbow' } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/widget/i);
  });

  it('rejects label longer than 80 chars', () => {
    const result = validateUiHints({ label: 'x'.repeat(81) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/label/i);
  });

  it('rejects help longer than 280 chars', () => {
    const result = validateUiHints({ help: 'x'.repeat(281) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/help/i);
  });

  it('rejects non-integer order', () => {
    const result = validateUiHints({ order: 1.5 } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it('accepts negative integer order', () => {
    const result = validateUiHints({ order: -10 });
    expect(result.ok).toBe(true);
  });

  it('exposes the eight valid widgets', () => {
    expect(UI_WIDGETS).toEqual(['text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags']);
  });

  it('normalizes empty object to null', () => {
    expect(normalizeUiHints({})).toBeNull();
  });

  it('normalizes null to null', () => {
    expect(normalizeUiHints(null)).toBeNull();
  });

  it('returns a populated object as-is', () => {
    expect(normalizeUiHints({ label: 'X' })).toEqual({ label: 'X' });
  });
});

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  createSchema(db);
  addUiHints(db);
  return db;
}

describe('CRUD round-trip for ui_hints', () => {
  it('createGlobalField persists ui hints', () => {
    const db = setupDb();
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'done'],
      ui: { widget: 'enum', label: 'Status', order: 10 },
    });
    const def = getGlobalField(db, 'status');
    expect(def?.ui_hints).toEqual({ widget: 'enum', label: 'Status', order: 10 });
  });

  it('createGlobalField with no ui leaves ui_hints null', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'note', field_type: 'string' });
    const def = getGlobalField(db, 'note');
    expect(def?.ui_hints).toBeNull();
  });

  it('createGlobalField with ui: {} stores null', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'note', field_type: 'string', ui: {} });
    const def = getGlobalField(db, 'note');
    expect(def?.ui_hints).toBeNull();
  });

  it('createGlobalField rejects invalid ui', () => {
    const db = setupDb();
    expect(() => createGlobalField(db, {
      name: 'bad',
      field_type: 'string',
      ui: { widget: 'rainbow' } as unknown as Record<string, unknown>,
    })).toThrow(/widget/);
  });
});

describe('updateGlobalField ui semantics', () => {
  it('absent ui key leaves stored hints intact', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A', help: 'B' } });
    updateGlobalField(db, 'f', { description: 'no ui change' });
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'A', help: 'B' });
  });

  it('ui: null clears stored hints', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });
    updateGlobalField(db, 'f', { ui: null });
    expect(getGlobalField(db, 'f')?.ui_hints).toBeNull();
  });

  it('ui: {} clears stored hints', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });
    updateGlobalField(db, 'f', { ui: {} });
    expect(getGlobalField(db, 'f')?.ui_hints).toBeNull();
  });

  it('replace-not-merge: previous keys not in new object are dropped', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A', help: 'B' } });
    updateGlobalField(db, 'f', { ui: { label: 'X' } });
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'X' });
  });

  it('rejects invalid ui on update', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string' });
    expect(() => updateGlobalField(db, 'f', {
      ui: { widget: 'rainbow' } as unknown as Record<string, unknown>,
    })).toThrow(/widget/);
  });
});

describe('renameGlobalField preserves ui hints', () => {
  it('carries ui_hints from old name to new name', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'old', field_type: 'string', ui: { label: 'L', order: 5 } });
    renameGlobalField(db, 'old', 'newname');
    expect(getGlobalField(db, 'old')).toBeNull();
    const renamed = getGlobalField(db, 'newname');
    expect(renamed?.ui_hints).toEqual({ label: 'L', order: 5 });
  });

  it('null ui_hints stays null after rename', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'old', field_type: 'string' });
    renameGlobalField(db, 'old', 'newname');
    expect(getGlobalField(db, 'newname')?.ui_hints).toBeNull();
  });
});

import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { captureGlobalFieldSnapshot, restoreGlobalFieldSnapshot } from '../../src/undo/global-field-snapshot.js';
import { addUndoTables, addGlobalFieldUndoSnapshots } from '../../src/db/migrate.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateGlobalField } from '../../src/mcp/tools/create-global-field.js';
import { registerUpdateGlobalField } from '../../src/mcp/tools/update-global-field.js';
import { registerDescribeGlobalField } from '../../src/mcp/tools/describe-global-field.js';

function setupDbWithUndo(): Database.Database {
  const db = new Database(':memory:');
  createSchema(db);
  addUiHints(db);
  addUndoTables(db);
  addGlobalFieldUndoSnapshots(db);
  return db;
}

async function callMcpTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

function envelope(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('undo snapshot captures ui_hints', () => {
  it('restores ui_hints after a destructive update', () => {
    const db = setupDbWithUndo();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'Original', order: 1 } });

    const op = createOperation(db, { source_tool: 'test', description: 'update ui' });
    captureGlobalFieldSnapshot(db, op, 'f');
    updateGlobalField(db, 'f', { ui: { label: 'Changed', order: 99 } });
    finalizeOperation(db, op);

    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'Changed', order: 99 });

    restoreGlobalFieldSnapshot(db, op, 'f');
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'Original', order: 1 });
  });
});

describe('create-global-field MCP tool accepts ui', () => {
  it('passes ui through to createGlobalField', async () => {
    const db = setupDbWithUndo();
    const server = new McpServer({ name: 'test', version: '0' });
    registerCreateGlobalField(server, db);
    const env = envelope(await callMcpTool(server, 'create-global-field', {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'done'],
      ui: { widget: 'enum', label: 'Status' },
    }));
    expect(env.ok).toBe(true);
    expect(getGlobalField(db, 'status')?.ui_hints).toEqual({ widget: 'enum', label: 'Status' });
  });

  it('rejects invalid ui at the MCP layer', async () => {
    const db = setupDbWithUndo();
    const server = new McpServer({ name: 'test', version: '0' });
    registerCreateGlobalField(server, db);
    const env = envelope(await callMcpTool(server, 'create-global-field', {
      name: 'bad',
      field_type: 'string',
      ui: { widget: 'rainbow' },
    }));
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('INVALID_PARAMS');
  });
});

describe('update-global-field MCP tool accepts ui', () => {
  it('updates ui hints on an existing field', async () => {
    const db = setupDbWithUndo();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });

    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateGlobalField(server, db);
    const env = envelope(await callMcpTool(server, 'update-global-field', { name: 'f', ui: { label: 'B', order: 7 } }));
    expect(env.ok).toBe(true);
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'B', order: 7 });
  });

  it('clears ui hints with ui: null', async () => {
    const db = setupDbWithUndo();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });
    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateGlobalField(server, db);
    const env = envelope(await callMcpTool(server, 'update-global-field', { name: 'f', ui: null }));
    expect(env.ok).toBe(true);
    expect(getGlobalField(db, 'f')?.ui_hints).toBeNull();
  });
});

describe('describe-global-field returns ui', () => {
  it('returns ui blob when set', async () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { widget: 'textarea', label: 'F' } });
    const server = new McpServer({ name: 'test', version: '0' });
    registerDescribeGlobalField(server, db);
    const env = envelope(await callMcpTool(server, 'describe-global-field', { name: 'f' }));
    expect(env.ok).toBe(true);
    expect(env.data.ui).toEqual({ widget: 'textarea', label: 'F' });
  });

  it('returns ui as null when unset (always present in shape)', async () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string' });
    const server = new McpServer({ name: 'test', version: '0' });
    registerDescribeGlobalField(server, db);
    const env = envelope(await callMcpTool(server, 'describe-global-field', { name: 'f' }));
    expect(env.ok).toBe(true);
    expect('ui' in env.data).toBe(true);
    expect(env.data.ui).toBeNull();
  });
});

import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';

describe('describe-schema returns ui per claim', () => {
  it('includes ui (always present, possibly null) on each claim', async () => {
    const db = setupDb();
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'], ui: { widget: 'enum', label: 'Status', order: 5 } });
    createGlobalField(db, { name: 'note', field_type: 'string' });
    db.prepare('INSERT INTO schemas (name) VALUES (?)').run('task');
    db.prepare('INSERT INTO schema_field_claims (schema_name, field) VALUES (?, ?), (?, ?)')
      .run('task', 'status', 'task', 'note');

    const server = new McpServer({ name: 'test', version: '0' });
    registerDescribeSchema(server, db);
    const env = envelope(await callMcpTool(server, 'describe-schema', { name: 'task' }));

    expect(env.ok).toBe(true);
    const fieldsByName = new Map(((env as { data: { fields: Array<Record<string, unknown>> } }).data.fields).map(f => [f.name, f]));

    const status = fieldsByName.get('status') as Record<string, unknown>;
    expect('ui' in status).toBe(true);
    expect(status.ui).toEqual({ widget: 'enum', label: 'Status', order: 5 });

    const note = fieldsByName.get('note') as Record<string, unknown>;
    expect('ui' in note).toBe(true);
    expect(note.ui).toBeNull();
  });
});
