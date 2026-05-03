import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { validateUiHints, normalizeUiHints, UI_WIDGETS } from '../../src/global-fields/ui-hints.js';
import { createGlobalField, getGlobalField, updateGlobalField } from '../../src/global-fields/crud.js';

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
