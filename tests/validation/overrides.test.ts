import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField, getGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition } from '../../src/schema/crud.js';
import { loadSchemaContext } from '../../src/pipeline/schema-context.js';
import { mergeFieldClaims } from '../../src/validation/merge.js';
import { validateProposedState } from '../../src/validation/validate.js';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });

// ── Group 1: default_value_override: null round-trip ────────────────────

describe('default_value_override: null round-trip', () => {
  it('DB round-trip: override-to-null survives CRUD cycle', () => {
    // 1. Create global field with default 'open', allow default_value overrides
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      default_value: 'open',
      overrides_allowed: { default_value: true },
    });

    // 2. Create schema with override-to-null (default_value_overridden but no default_value)
    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'status', default_value_overridden: true }],
    });

    // 3. Load schema context
    const ctx = loadSchemaContext(db, ['note']);

    // 4. Assert claim's default_value_override is { kind: 'override', value: null }
    const claims = ctx.claimsByType.get('note')!;
    expect(claims).toHaveLength(1);
    expect(claims[0].default_value_override).toEqual({ kind: 'override', value: null });

    // 5. Run merge, assert resolved_default_value is null (not 'open')
    const mergeResult = mergeFieldClaims(['note'], ctx.claimsByType, ctx.globalFields);
    expect(mergeResult.ok).toBe(true);
    if (!mergeResult.ok) return;
    expect(mergeResult.effective_fields.get('status')!.resolved_default_value).toBeNull();
  });

  it('override removal: update-schema omitting override reverts to global', () => {
    // 1. Same setup: global field with default, schema with override-to-null
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      default_value: 'open',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'status', default_value_overridden: true }],
    });

    // 2. Update schema, omitting the override (plain claim)
    updateSchemaDefinition(db, 'note', {
      field_claims: [{ field: 'status' }],
    });

    // 3. Load context, assert claim reverts to inherit
    const ctx = loadSchemaContext(db, ['note']);
    const claims = ctx.claimsByType.get('note')!;
    expect(claims[0].default_value_override).toEqual({ kind: 'inherit' });

    // 4. Run merge, assert resolved_default_value is 'open' (global default)
    const mergeResult = mergeFieldClaims(['note'], ctx.claimsByType, ctx.globalFields);
    expect(mergeResult.ok).toBe(true);
    if (!mergeResult.ok) return;
    expect(mergeResult.effective_fields.get('status')!.resolved_default_value).toBe('open');
  });
});

// ── Group 2: enum_values_override end-to-end ────────────────────────────

describe('enum_values_override end-to-end', () => {
  it('list<enum> field with per-type overrides validates correctly', () => {
    // 1. Global list<enum> field with base values ['a', 'b', 'c']
    createGlobalField(db, {
      name: 'subtype',
      field_type: 'list',
      list_item_type: 'enum',
      enum_values: ['a', 'b', 'c'],
      overrides_allowed: { enum_values: true },
    });

    // 2. Schema 'note' with override ['spec', 'bug']
    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'subtype', enum_values_override: ['spec', 'bug'] }],
    });

    // 3. Schema 'person' with override ['Author', 'Athlete']
    createSchemaDefinition(db, {
      name: 'person',
      field_claims: [{ field: 'subtype', enum_values_override: ['Author', 'Athlete'] }],
    });

    // 4. Load context for both types
    const ctx = loadSchemaContext(db, ['note', 'person']);

    // 5. Validate { subtype: ['spec'] } — should be valid (accepted by note)
    const r1 = validateProposedState(
      { subtype: ['spec'] }, ['note', 'person'],
      ctx.claimsByType, ctx.globalFields,
    );
    expect(r1.valid).toBe(true);
    expect(r1.issues).toHaveLength(0);

    // 6. Validate { subtype: ['Author'] } — should be valid (accepted by person)
    const r2 = validateProposedState(
      { subtype: ['Author'] }, ['note', 'person'],
      ctx.claimsByType, ctx.globalFields,
    );
    expect(r2.valid).toBe(true);
    expect(r2.issues).toHaveLength(0);

    // 7. Validate { subtype: ['unknown'] } — should be invalid with ENUM_MISMATCH
    const r3 = validateProposedState(
      { subtype: ['unknown'] }, ['note', 'person'],
      ctx.claimsByType, ctx.globalFields,
    );
    expect(r3.valid).toBe(false);
    expect(r3.issues).toHaveLength(1);
    expect(r3.issues[0].code).toBe('ENUM_MISMATCH');
  });

  it('scalar enum field with per-type override', () => {
    // 1. Global enum field with base values ['open', 'closed']
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      overrides_allowed: { enum_values: true },
    });

    // 2. Schema 'task' with override ['active', 'done']
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status', enum_values_override: ['active', 'done'] }],
    });

    // 3. Load context for ['task']
    const ctx = loadSchemaContext(db, ['task']);

    // 4. Validate { status: 'active' } — should be valid
    const r1 = validateProposedState(
      { status: 'active' }, ['task'],
      ctx.claimsByType, ctx.globalFields,
    );
    expect(r1.valid).toBe(true);

    // 5. Validate { status: 'open' } — should be invalid (task overrides fully replace global)
    const r2 = validateProposedState(
      { status: 'open' }, ['task'],
      ctx.claimsByType, ctx.globalFields,
    );
    expect(r2.valid).toBe(false);
    expect(r2.issues).toHaveLength(1);
    expect(r2.issues[0].code).toBe('ENUM_MISMATCH');
  });
});

// ── Group 3: claim validation guards ────────────────────────────────────

describe('claim validation guards', () => {
  it('rejects enum_values_override on non-enum field', () => {
    // 1. Create global field 'count' (number), with enum_values override allowed
    createGlobalField(db, {
      name: 'count',
      field_type: 'number',
      overrides_allowed: { enum_values: true },
    });

    // 2. Attempt to create schema with enum_values_override — should throw
    expect(() => {
      createSchemaDefinition(db, {
        name: 'note',
        field_claims: [{ field: 'count', enum_values_override: ['one'] }],
      });
    }).toThrow(/structurally incompatible/);
  });

  it('rejects override when overrides_allowed is false', () => {
    // 1. Create global field 'status' (enum) — no overrides_allowed
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open'],
    });

    // 2. Attempt to create schema with required override — should throw
    expect(() => {
      createSchemaDefinition(db, {
        name: 'note',
        field_claims: [{ field: 'status', required: true }],
      });
    }).toThrow(/does not allow required overrides/);
  });
});

// ── Group 4: cancellation semantics ─────────────────────────────────────

describe('cancellation semantics', () => {
  it('conflicting required overrides cancel to global', () => {
    // 1. Global field 'priority' (string, required: true, required overrides allowed)
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      overrides_allowed: { required: true },
    });

    // 2. Schema 'task' with required: true, schema 'note' with required: false
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'priority', required: true }],
    });
    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'priority', required: false }],
    });

    // 3. Load context and validate empty fields for types ['task', 'note']
    const ctx = loadSchemaContext(db, ['task', 'note']);
    const result = validateProposedState(
      {}, ['task', 'note'],
      ctx.claimsByType, ctx.globalFields,
    );

    // Cancellation falls back to global (required: true) → REQUIRED_MISSING
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('REQUIRED_MISSING');
    expect(result.issues[0].field).toBe('priority');
  });
});

// ── Group 5: overrides_allowed object CRUD ──────────────────────────────

describe('overrides_allowed object CRUD', () => {
  it('create and read back overrides_allowed', () => {
    // 1. Create global field with all three flags true
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      overrides_allowed: { required: true, default_value: true, enum_values: true },
    });

    // 2. Read it back and assert all three flags
    const gf = getGlobalField(db, 'status')!;
    expect(gf).not.toBeNull();
    expect(gf.overrides_allowed).toEqual({
      required: true,
      default_value: true,
      enum_values: true,
    });
  });
});
