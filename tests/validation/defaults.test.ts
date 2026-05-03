// tests/validation/defaults.test.ts
//
// Unit tests for default-population — focusing on correct default_source
// reporting when per-type overrides agree, disagree, or are absent.
//
// Replaces tests/pipeline/populate-defaults.test.ts; same scenarios,
// asserted via validateProposedState + defaultedFieldsFrom.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { loadSchemaContext } from '../../src/pipeline/schema-context.js';
import { validateProposedState, defaultedFieldsFrom } from '../../src/validation/validate.js';

let db: Database.Database;

function populate(types: string[], currentFields: Record<string, unknown>) {
  const { claimsByType, globalFields } = loadSchemaContext(db, types);
  const result = validateProposedState(currentFields, types, claimsByType, globalFields);
  return defaultedFieldsFrom(result);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUiHints(db);
});

afterEach(() => {
  db.close();
});

describe('default-population — default_source', () => {
  it("reports 'global' when multiple types have conflicting per-type default overrides (cancellation path)", () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      default_value: 'normal',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'TypeA',
      field_claims: [{ field: 'priority', default_value: 'high', default_value_overridden: true }],
    });
    createSchemaDefinition(db, {
      name: 'TypeB',
      field_claims: [{ field: 'priority', default_value: 'low', default_value_overridden: true }],
    });

    const populated = populate(['TypeA', 'TypeB'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('priority');
    expect(populated[0].default_value).toBe('normal');
    expect(populated[0].default_source).toBe('global');
  });

  it("reports 'claim' when all types agree on the same per-type default override", () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'string',
      required: true,
      default_value: 'pending',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'TypeX',
      field_claims: [{ field: 'status', default_value: 'active', default_value_overridden: true }],
    });
    createSchemaDefinition(db, {
      name: 'TypeY',
      field_claims: [{ field: 'status', default_value: 'active', default_value_overridden: true }],
    });

    const populated = populate(['TypeX', 'TypeY'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('status');
    expect(populated[0].default_value).toBe('active');
    expect(populated[0].default_source).toBe('claim');
  });

  it("reports 'global' when no type has a per-type default override", () => {
    createGlobalField(db, {
      name: 'category',
      field_type: 'string',
      required: true,
      default_value: 'general',
    });
    createSchemaDefinition(db, {
      name: 'TypeZ',
      field_claims: [{ field: 'category' }],
    });

    const populated = populate(['TypeZ'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('category');
    expect(populated[0].default_value).toBe('general');
    expect(populated[0].default_source).toBe('global');
  });

  it('skips fields already present in currentFields', () => {
    createGlobalField(db, {
      name: 'tag',
      field_type: 'string',
      required: true,
      default_value: 'draft',
    });
    createSchemaDefinition(db, {
      name: 'Doc',
      field_claims: [{ field: 'tag' }],
    });

    const populated = populate(['Doc'], { tag: 'published' });
    expect(populated).toHaveLength(0);
  });
});
