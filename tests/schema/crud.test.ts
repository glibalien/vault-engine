import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import {
  getSchemaDefinition,
  createSchemaDefinition,
  updateSchemaDefinition,
  deleteSchemaDefinition,
} from '../../src/schema/crud.js';
import { SchemaValidationError } from '../../src/schema/errors.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();

  // Seed global fields used across tests
  createGlobalField(db, { name: 'due_date', field_type: 'date' });
  createGlobalField(db, { name: 'priority', field_type: 'number' });
  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed'],
  });
});

// ── getSchemaDefinition ──────────────────────────────────────────────

describe('getSchemaDefinition', () => {
  it('returns null for missing schema', () => {
    expect(getSchemaDefinition(db, 'nonexistent')).toBeNull();
  });

  it('returns the schema after creation', () => {
    createSchemaDefinition(db, {
      name: 'Task',
      display_name: 'Task',
      field_claims: [],
    });
    const schema = getSchemaDefinition(db, 'Task');
    expect(schema).not.toBeNull();
    expect(schema!.name).toBe('Task');
    expect(schema!.display_name).toBe('Task');
  });
});

// ── createSchemaDefinition ───────────────────────────────────────────

describe('createSchemaDefinition', () => {
  it('creates schema with field claims and stores them in schema_field_claims', () => {
    const schema = createSchemaDefinition(db, {
      name: 'Task',
      display_name: 'Task',
      icon: '✅',
      field_claims: [
        { field: 'due_date', label: 'Due', sort_order: 1 },
        { field: 'priority', sort_order: 2 },
        { field: 'status', sort_order: 3 },
      ],
    });

    expect(schema.name).toBe('Task');
    expect(schema.display_name).toBe('Task');
    expect(schema.icon).toBe('✅');

    // Verify claims in DB
    const claims = db
      .prepare(`SELECT * FROM schema_field_claims WHERE schema_name = 'Task' ORDER BY sort_order`)
      .all() as Array<{ field: string; label: string | null; sort_order: number | null }>;

    expect(claims).toHaveLength(3);
    expect(claims[0].field).toBe('due_date');
    expect(claims[0].label).toBe('Due');
    expect(claims[1].field).toBe('priority');
    expect(claims[2].field).toBe('status');
  });

  it('stores required and default_value on claims as integer and JSON', () => {
    // Need a field with overrides_allowed to set required/default_value
    createGlobalField(db, {
      name: 'flexible_field',
      field_type: 'string',
      overrides_allowed: { required: true, default_value: true },
    });

    createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [
        { field: 'flexible_field', required: true, default_value: 'pending' },
      ],
    });

    const claim = db
      .prepare(`SELECT required_override, default_value_override, default_value_overridden FROM schema_field_claims WHERE schema_name = 'Task' AND field = 'flexible_field'`)
      .get() as { required_override: number | null; default_value_override: string | null; default_value_overridden: number };

    expect(claim.required_override).toBe(1);
    expect(claim.default_value_override).toBe(JSON.stringify('pending'));
    expect(claim.default_value_overridden).toBe(1);
  });

  it('rejects claim for nonexistent global field', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'nonexistent_field' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/Global field 'nonexistent_field' does not exist/);
  });

  it('rejects required override without overrides_allowed.required', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/overrides_allowed\.required/);
  });

  it('rejects default_value override without overrides_allowed.default_value', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'priority', default_value: 5 }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/overrides_allowed\.default_value/);
  });

  it('allows semantic override when overrides_allowed is true', () => {
    createGlobalField(db, {
      name: 'overridable',
      field_type: 'string',
      overrides_allowed: { required: true, default_value: true },
    });

    expect(() =>
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'overridable', required: true, default_value: 'hello' }],
      }),
    ).not.toThrow();
  });

  it('stores metadata as parsed JSON', () => {
    const meta = { color: 'blue', tags: ['a', 'b'] };
    const schema = createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [],
      metadata: meta,
    });
    expect(schema.metadata).toEqual(meta);
  });
});

// ── updateSchemaDefinition ───────────────────────────────────────────

describe('updateSchemaDefinition', () => {
  beforeEach(() => {
    createSchemaDefinition(db, {
      name: 'Task',
      display_name: 'Task',
      field_claims: [
        { field: 'due_date' },
        { field: 'priority' },
      ],
    });
  });

  it('full replaces field claims when field_claims provided', () => {
    updateSchemaDefinition(db, 'Task', {
      field_claims: [{ field: 'status' }],
    });

    const claims = db
      .prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'Task'`)
      .all() as Array<{ field: string }>;

    expect(claims).toHaveLength(1);
    expect(claims[0].field).toBe('status');
  });

  it('leaves claims untouched when field_claims not provided', () => {
    updateSchemaDefinition(db, 'Task', {
      display_name: 'Updated Task',
    });

    const claims = db
      .prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'Task' ORDER BY field`)
      .all() as Array<{ field: string }>;

    expect(claims).toHaveLength(2);

    const schema = getSchemaDefinition(db, 'Task');
    expect(schema!.display_name).toBe('Updated Task');
  });

  it('validates new claims during update (rejects nonexistent field)', () => {
    let caught: unknown = null;
    try {
      updateSchemaDefinition(db, 'Task', {
        field_claims: [{ field: 'ghost_field' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/Global field 'ghost_field' does not exist/);
  });

  it('validates semantic overrides during update', () => {
    let caught: unknown = null;
    try {
      updateSchemaDefinition(db, 'Task', {
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).groups[0].message).toMatch(/overrides_allowed\.required/);
  });

  it('throws when schema does not exist', () => {
    expect(() =>
      updateSchemaDefinition(db, 'NonExistent', { display_name: 'x' }),
    ).toThrow(/not found/i);
  });

  it('updates metadata without touching claims', () => {
    updateSchemaDefinition(db, 'Task', {
      metadata: { version: 2 },
    });

    const schema = getSchemaDefinition(db, 'Task');
    expect(schema!.metadata).toEqual({ version: 2 });

    const claims = db
      .prepare(`SELECT COUNT(*) as cnt FROM schema_field_claims WHERE schema_name = 'Task'`)
      .get() as { cnt: number };
    expect(claims.cnt).toBe(2);
  });
});

// ── deleteSchemaDefinition ───────────────────────────────────────────

describe('deleteSchemaDefinition', () => {
  it('removes schema and claims via CASCADE, leaves node_types intact', () => {
    createSchemaDefinition(db, {
      name: 'Task',
      field_claims: [{ field: 'due_date' }, { field: 'priority' }],
    });

    // Insert a node with this type to simulate node_types rows
    db.prepare(`INSERT INTO nodes (id, file_path) VALUES ('n1', '/n1.md')`).run();
    db.prepare(`INSERT INTO node_types (node_id, schema_type) VALUES ('n1', 'Task')`).run();

    const result = deleteSchemaDefinition(db, 'Task');
    expect(result.affected_nodes).toBe(1);

    // Schema gone
    expect(getSchemaDefinition(db, 'Task')).toBeNull();

    // Claims gone (CASCADE)
    const claims = db
      .prepare(`SELECT COUNT(*) as cnt FROM schema_field_claims WHERE schema_name = 'Task'`)
      .get() as { cnt: number };
    expect(claims.cnt).toBe(0);

    // node_types row still present
    const nt = db
      .prepare(`SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = 'Task'`)
      .get() as { cnt: number };
    expect(nt.cnt).toBe(1);
  });

  it('throws when schema does not exist', () => {
    expect(() => deleteSchemaDefinition(db, 'NoSuchSchema')).toThrow(/not found/i);
  });
});

// ── SchemaValidationError path ──────────────────────────────────────

describe('validateClaims throws SchemaValidationError', () => {
  it('UNKNOWN_FIELD: claim referencing nonexistent global field', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'nonexistent' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('UNKNOWN_FIELD');
    expect(err.groups[0].field).toBe('nonexistent');
    expect(err.groups[0].count).toBe(1);
  });

  it('OVERRIDE_NOT_ALLOWED: required override without overrides_allowed.required', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('OVERRIDE_NOT_ALLOWED');
    expect(err.groups[0].field).toBe('due_date');
  });

  it('STRUCTURAL_INCOMPAT: enum override on non-enum field', () => {
    // Allow the override so we reach the structural check
    createGlobalField(db, {
      name: 'body_text',
      field_type: 'string',
      overrides_allowed: { enum_values: true },
    });

    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'body_text', enum_values_override: ['a', 'b'] }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('STRUCTURAL_INCOMPAT');
    expect(err.groups[0].field).toBe('body_text');
  });

  it('aggregates multiple claim-level failures into one throw (does not short-circuit)', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [
          { field: 'nonexistent_a' },
          { field: 'nonexistent_b' },
          { field: 'due_date', required: true }, // OVERRIDE_NOT_ALLOWED
        ],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(3);
  });
});
