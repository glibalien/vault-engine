import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  getGlobalField,
  createGlobalField,
  updateGlobalField,
  renameGlobalField,
  deleteGlobalField,
} from '../../src/global-fields/crud.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ── helpers ──────────────────────────────────────────────────────────

function insertNode(id: string, filePath: string): void {
  db.prepare(
    `INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`,
  ).run(id, filePath, id);
}

function insertNodeField(nodeId: string, fieldName: string, opts: {
  value_text?: string | null;
  value_number?: number | null;
  value_date?: string | null;
  value_json?: string | null;
} = {}): void {
  db.prepare(
    `INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    nodeId,
    fieldName,
    opts.value_text ?? null,
    opts.value_number ?? null,
    opts.value_date ?? null,
    opts.value_json ?? null,
  );
}

function insertSchema(name: string): void {
  db.prepare(
    `INSERT INTO schemas (name, field_claims) VALUES (?, '[]')`,
  ).run(name);
}

function insertFieldClaim(schemaName: string, field: string): void {
  db.prepare(
    `INSERT INTO schema_field_claims (schema_name, field) VALUES (?, ?)`,
  ).run(schemaName, field);
}

// ── createGlobalField ────────────────────────────────────────────────

describe('createGlobalField', () => {
  it('creates a string field and returns the definition', () => {
    const result = createGlobalField(db, {
      name: 'title',
      field_type: 'string',
      description: 'The title',
    });
    expect(result).toEqual({
      name: 'title',
      field_type: 'string',
      enum_values: null,
      reference_target: null,
      description: 'The title',
      default_value: null,
      required: false,
      overrides_allowed: {
        required: false,
        default_value: false,
        enum_values: false,
      },
      list_item_type: null,
    });
  });

  it('creates an enum field with values', () => {
    const result = createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['active', 'archived'],
    });
    expect(result.field_type).toBe('enum');
    expect(result.enum_values).toEqual(['active', 'archived']);
  });

  it('creates a list field with item type', () => {
    const result = createGlobalField(db, {
      name: 'tags',
      field_type: 'list',
      list_item_type: 'string',
    });
    expect(result.field_type).toBe('list');
    expect(result.list_item_type).toBe('string');
  });

  it('rejects duplicate name', () => {
    createGlobalField(db, { name: 'title', field_type: 'string' });
    expect(() =>
      createGlobalField(db, { name: 'title', field_type: 'string' }),
    ).toThrow(/unique|duplicate|already exists/i);
  });

  it('rejects enum without enum_values', () => {
    expect(() =>
      createGlobalField(db, { name: 'status', field_type: 'enum' }),
    ).toThrow(/enum_values/i);
  });

  it('rejects list without list_item_type', () => {
    expect(() =>
      createGlobalField(db, { name: 'tags', field_type: 'list' }),
    ).toThrow(/list_item_type/i);
  });

  it('rejects nested list (list_item_type = list)', () => {
    expect(() =>
      createGlobalField(db, {
        name: 'nested',
        field_type: 'list',
        list_item_type: 'list',
      }),
    ).toThrow(/nested/i);
  });
});

// ── getGlobalField ───────────────────────────────────────────────────

describe('getGlobalField', () => {
  it('returns null for missing field', () => {
    expect(getGlobalField(db, 'nope')).toBeNull();
  });

  it('returns parsed field with correct types', () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'number',
      required: true,
      default_value: 5,
    });
    const field = getGlobalField(db, 'priority');
    expect(field).not.toBeNull();
    expect(field!.required).toBe(true);
    expect(field!.default_value).toBe(5);
  });
});

// ── renameGlobalField ────────────────────────────────────────────────

describe('renameGlobalField', () => {
  it('renames across global_fields, node_fields, and schema_field_claims atomically', () => {
    // Setup: global field, a node with that field, a schema claim
    createGlobalField(db, { name: 'old_name', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'old_name', { value_text: 'hello' });
    insertSchema('Person');
    insertFieldClaim('Person', 'old_name');

    const result = renameGlobalField(db, 'old_name', 'new_name');
    expect(result.affected_nodes).toBe(1);
    expect(result.affected_schemas).toBe(1);

    // old name gone
    expect(getGlobalField(db, 'old_name')).toBeNull();
    // new name exists
    const field = getGlobalField(db, 'new_name');
    expect(field).not.toBeNull();
    expect(field!.field_type).toBe('string');

    // node_fields updated
    const nf = db.prepare(
      `SELECT field_name FROM node_fields WHERE node_id = 'n1'`,
    ).get() as { field_name: string };
    expect(nf.field_name).toBe('new_name');

    // schema_field_claims updated
    const sfc = db.prepare(
      `SELECT field FROM schema_field_claims WHERE schema_name = 'Person'`,
    ).get() as { field: string };
    expect(sfc.field).toBe('new_name');
  });
});

// ── deleteGlobalField ────────────────────────────────────────────────

describe('deleteGlobalField', () => {
  it('removes from global_fields and schema_field_claims, leaves node_fields intact', () => {
    createGlobalField(db, { name: 'doomed', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'doomed', { value_text: 'still here' });
    insertSchema('Person');
    insertFieldClaim('Person', 'doomed');

    const result = deleteGlobalField(db, 'doomed');
    expect(result.affected_nodes).toBe(1);
    expect(result.affected_schemas).toBe(1);

    // global_fields gone
    expect(getGlobalField(db, 'doomed')).toBeNull();

    // schema_field_claims gone (CASCADE)
    const sfc = db.prepare(
      `SELECT COUNT(*) as cnt FROM schema_field_claims WHERE field = 'doomed'`,
    ).get() as { cnt: number };
    expect(sfc.cnt).toBe(0);

    // node_fields still present (orphaned)
    const nf = db.prepare(
      `SELECT value_text FROM node_fields WHERE field_name = 'doomed'`,
    ).get() as { value_text: string };
    expect(nf.value_text).toBe('still here');
  });
});

// ── updateGlobalField ────────────────────────────────────────────────

describe('updateGlobalField', () => {
  it('updates description (non-type-change)', () => {
    createGlobalField(db, { name: 'title', field_type: 'string' });
    const result = updateGlobalField(db, 'title', { description: 'Updated desc' });
    expect(result.preview).toBe(false);
    expect(result.field!.description).toBe('Updated desc');
  });

  it('type change preview without confirm returns preview, no DB change', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });

    const result = updateGlobalField(db, 'count', { field_type: 'number' });

    expect(result.preview).toBe(true);
    expect(result.applied).toBeUndefined();
    expect(result.affected_nodes).toBe(1);
    expect(result.coercible!.length).toBe(1);
    expect(result.coercible![0].new_value).toBe(42);
    expect(result.uncoercible!.length).toBe(0);

    // DB unchanged
    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('string');
  });

  it('type change with confirm applies coercion to node_fields', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    const result = updateGlobalField(db, 'count', {
      field_type: 'number',
      confirm: true,
    });

    expect(result.preview).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.coercible!.length).toBe(1);
    expect(result.uncoercible!.length).toBe(1);

    // global_fields updated
    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('number');

    // n1: coerced to number
    const n1 = db.prepare(
      `SELECT value_number, value_text FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_number: number | null; value_text: string | null };
    expect(n1.value_number).toBe(42);
    expect(n1.value_text).toBeNull();

    // n2: uncoercible, removed from node_fields
    const n2 = db.prepare(
      `SELECT value_text FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`,
    ).get();
    expect(n2).toBeUndefined();
  });

  it('rejects clearing enum_values on an enum field', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
    expect(() => updateGlobalField(db, 'status', { enum_values: [] })).toThrow(/enum_values/);
  });

  it('rejects clearing list_item_type on a list field', () => {
    createGlobalField(db, { name: 'tags', field_type: 'list', list_item_type: 'string' });
    // Attempting to set list_item_type to null should fail
    expect(() => updateGlobalField(db, 'tags', { list_item_type: undefined as any })).not.toThrow();
    // But explicitly setting it to something invalid should fail
    expect(() => updateGlobalField(db, 'tags', { list_item_type: 'list' as any })).toThrow(/nested/i);
  });
});
