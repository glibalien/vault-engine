// tests/pipeline/populate-defaults.test.ts
//
// Unit tests for populateDefaults — focusing on correct default_source
// reporting when per-type overrides agree, disagree, or are absent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { populateDefaults } from '../../src/pipeline/populate-defaults.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe('populateDefaults — default_source', () => {
  it("reports 'global' when multiple types have conflicting per-type default overrides (cancellation path)", () => {
    // Global field: required=true, default_value='normal', overrides_allowed.default_value=true
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      default_value: 'normal',
      overrides_allowed: { default_value: true },
    });

    // TypeA claims priority with default_value='high'
    createSchemaDefinition(db, {
      name: 'TypeA',
      field_claims: [{ field: 'priority', default_value: 'high', default_value_overridden: true }],
    });

    // TypeB claims priority with default_value='low' — disagrees with TypeA
    createSchemaDefinition(db, {
      name: 'TypeB',
      field_claims: [{ field: 'priority', default_value: 'low', default_value_overridden: true }],
    });

    const { populated } = populateDefaults(db, ['TypeA', 'TypeB'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('priority');
    // Overrides cancelled due to disagreement → resolves to global default 'normal'
    expect(populated[0].default_value).toBe('normal');
    // BUG: old code returns 'claim' because it finds any claim with an override
    // FIX: should return 'global' because ef.default_source is 'global' after cancellation
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

    // Both types agree on the same override
    createSchemaDefinition(db, {
      name: 'TypeX',
      field_claims: [{ field: 'status', default_value: 'active', default_value_overridden: true }],
    });
    createSchemaDefinition(db, {
      name: 'TypeY',
      field_claims: [{ field: 'status', default_value: 'active', default_value_overridden: true }],
    });

    const { populated } = populateDefaults(db, ['TypeX', 'TypeY'], {});

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

    const { populated } = populateDefaults(db, ['TypeZ'], {});

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

    const { populated, defaults } = populateDefaults(db, ['Doc'], { tag: 'published' });

    expect(populated).toHaveLength(0);
    expect(defaults['tag']).toBeUndefined();
  });
});
