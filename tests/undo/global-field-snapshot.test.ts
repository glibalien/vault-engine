import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createOperation } from '../../src/undo/operation.js';
import { createGlobalField, renameGlobalField } from '../../src/global-fields/crud.js';
import {
  captureGlobalFieldSnapshot,
  restoreGlobalFieldSnapshot,
  GLOBAL_FIELD_COLUMNS,
  SCHEMA_FIELD_CLAIM_COLUMNS,
  NODE_FIELD_COLUMNS,
} from '../../src/undo/global-field-snapshot.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function opId(): string {
  return createOperation(db, { source_tool: 'test', description: 'test' });
}

function seedField(name = 'status'): void {
  createGlobalField(db, {
    name,
    field_type: 'enum',
    enum_values: ['open', 'closed'],
    reference_target: 'task',
    description: 'Original description',
    default_value: 'open',
    required: true,
    overrides_allowed: { required: true, default_value: true, enum_values: true },
    list_item_type: 'string',
  });
}

function seedSchemaClaim(field = 'status'): void {
  db.prepare(`
    INSERT INTO schemas (name, display_name, field_claims)
    VALUES ('task', 'Task', '[]')
  `).run();
  db.prepare(`
    INSERT INTO schema_field_claims (
      schema_name, field, label, description, sort_order,
      required_override, default_value_override, default_value_overridden, enum_values_override
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task', field, 'Status', 'Claim description', 7, 0, JSON.stringify('closed'), 1, JSON.stringify(['open']));
}

function seedNodeField(field = 'status'): void {
  db.prepare(`
    INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
    VALUES ('n1', 'n1.md', 'N1', 'Body', 'h', 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO node_fields (
      node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('n1', field, 'open', null, null, null, 'open', 'frontmatter');
}

describe('global-field undo snapshots', () => {
  it('capture/restore update round trip restores every global_fields column', () => {
    seedField();
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'status');

    db.prepare(`
      UPDATE global_fields
      SET field_type = 'string',
          enum_values = NULL,
          reference_target = NULL,
          description = 'Changed',
          default_value = NULL,
          required = 0,
          overrides_allowed_required = 0,
          overrides_allowed_default_value = 0,
          overrides_allowed_enum_values = 0,
          list_item_type = NULL
      WHERE name = 'status'
    `).run();

    restoreGlobalFieldSnapshot(db, op, 'status');
    const row = db.prepare(`SELECT ${GLOBAL_FIELD_COLUMNS.join(', ')} FROM global_fields WHERE name = 'status'`).get() as Record<string, unknown>;

    expect(row).toMatchObject({
      name: 'status',
      field_type: 'enum',
      enum_values: JSON.stringify(['open', 'closed']),
      reference_target: 'task',
      description: 'Original description',
      default_value: JSON.stringify('open'),
      required: 1,
      overrides_allowed_required: 1,
      overrides_allowed_default_value: 1,
      overrides_allowed_enum_values: 1,
      list_item_type: 'string',
    });
  });

  it('capture/restore delete round trip restores schema claims and node field values', () => {
    seedField();
    seedSchemaClaim();
    seedNodeField();
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'status', { was_deleted: true });

    db.prepare(`DELETE FROM schema_field_claims WHERE field = 'status'`).run();
    db.prepare(`DELETE FROM node_fields WHERE field_name = 'status'`).run();
    db.prepare(`DELETE FROM global_fields WHERE name = 'status'`).run();

    restoreGlobalFieldSnapshot(db, op, 'status');

    const claim = db.prepare(`SELECT ${SCHEMA_FIELD_CLAIM_COLUMNS.join(', ')} FROM schema_field_claims WHERE field = 'status'`).get();
    const nodeField = db.prepare(`SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE node_id = 'n1' AND field_name = 'status'`).get();
    expect(claim).toMatchObject({ schema_name: 'task', field: 'status', label: 'Status', sort_order: 7 });
    expect(nodeField).toMatchObject({ node_id: 'n1', field_name: 'status', value_text: 'open', value_raw_text: 'open', source: 'frontmatter' });
  });

  it('capture/restore create undo deletes the created field and dependent rows', () => {
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'status', { was_new: true });
    seedField();
    seedSchemaClaim();
    seedNodeField();

    restoreGlobalFieldSnapshot(db, op, 'status');

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM schema_field_claims WHERE field = 'status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM node_fields WHERE field_name = 'status'`).get()).toBeUndefined();
  });

  it('rename restore returns the old name and removes the new name', () => {
    seedField('old_status');
    seedSchemaClaim('old_status');
    seedNodeField('old_status');
    const op = opId();
    captureGlobalFieldSnapshot(db, op, 'new_status', { was_renamed_from: 'old_status' });

    renameGlobalField(db, 'old_status', 'new_status');

    restoreGlobalFieldSnapshot(db, op, 'new_status');

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'new_status'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM global_fields WHERE name = 'old_status'`).get()).toEqual({ name: 'old_status' });
    expect(db.prepare(`SELECT field FROM schema_field_claims WHERE field = 'old_status'`).get()).toEqual({ field: 'old_status' });
    expect(db.prepare(`SELECT field_name FROM node_fields WHERE field_name = 'old_status'`).get()).toEqual({ field_name: 'old_status' });
  });

  it('shared column-list constants cover current table columns', () => {
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(c => c.name);

    expect([...GLOBAL_FIELD_COLUMNS]).toEqual(cols('global_fields'));
    expect([...SCHEMA_FIELD_CLAIM_COLUMNS]).toEqual(cols('schema_field_claims'));
    expect([...NODE_FIELD_COLUMNS]).toEqual(cols('node_fields'));
  });
});
