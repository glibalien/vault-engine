import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { resolveDirectory } from '../../src/schema/paths.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'task', field_claims: [], default_directory: 'TaskNotes/Tasks' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => db.close());

describe('resolveDirectory', () => {
  it('explicit directory with no schema default → explicit', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: 'Inbox', override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'Inbox', source: 'explicit' });
  });

  it('no directory + schema default → schema_default (uses first type)', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'Notes', source: 'schema_default' });
  });

  it('multi-typed: first type wins', () => {
    const r = resolveDirectory(db, { types: ['task', 'note'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'TaskNotes/Tasks', source: 'schema_default' });
  });

  it('no directory + no schema default → root', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });

  it('empty types + no directory → root', () => {
    const r = resolveDirectory(db, { types: [], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });

  it('explicit directory with schema default + no override → INVALID_PARAMS', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: 'Somewhere', override_default_directory: false });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; code: string }).code).toBe('INVALID_PARAMS');
    expect((r as { ok: false; message: string }).message).toMatch(/routes to "Notes\/"/);
  });

  it('explicit directory with schema default + override_default_directory=true → explicit', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: 'Somewhere', override_default_directory: true });
    expect(r).toEqual({ ok: true, directory: 'Somewhere', source: 'explicit' });
  });

  it('directory ending with .md → INVALID_PARAMS (folder only)', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: 'x.md', override_default_directory: false });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; code: string }).code).toBe('INVALID_PARAMS');
    expect((r as { ok: false; message: string }).message).toMatch(/must be a folder path/);
  });

  it('type without schema → treated as no default (root)', () => {
    const r = resolveDirectory(db, { types: ['nosuch'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });
});
