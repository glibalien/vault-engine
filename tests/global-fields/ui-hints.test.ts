import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';

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
