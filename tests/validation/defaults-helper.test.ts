import { describe, it, expect } from 'vitest';
import type { ValidationResult, EffectiveField, GlobalFieldDefinition } from '../../src/validation/types.js';
import { defaultedFieldsFrom } from '../../src/validation/validate.js';

function makeEffectiveField(overrides: Partial<EffectiveField> = {}): EffectiveField {
  const gf: GlobalFieldDefinition = {
    name: 'f',
    field_type: 'string',
    required: true,
    default_value: 'g',
    overrides_allowed: { required: false, default_value: false, enum_values: false },
  } as GlobalFieldDefinition;
  return {
    field_name: 'f',
    global_field: gf,
    resolved_required: true,
    resolved_default_value: 'g',
    resolved_enum_values: null,
    resolved_order: 0,
    default_source: 'global',
    default_value_overridden: false,
    claiming_types: ['T'],
    ...overrides,
  } as EffectiveField;
}

describe('defaultedFieldsFrom', () => {
  it('returns empty when no fields are defaulted', () => {
    const result: ValidationResult = {
      valid: true,
      effective_fields: new Map(),
      coerced_state: {
        a: { field: 'a', value: 'x', source: 'provided', changed: false },
        b: { field: 'b', value: 'y', source: 'orphan', changed: false },
      },
      issues: [],
      orphan_fields: ['b'],
    };
    expect(defaultedFieldsFrom(result)).toEqual([]);
  });

  it("extracts defaulted entries with default_source from effective_fields", () => {
    const ef = makeEffectiveField({ field_name: 'priority', default_source: 'claim' });
    const result: ValidationResult = {
      valid: true,
      effective_fields: new Map([['priority', ef]]),
      coerced_state: {
        priority: { field: 'priority', value: 'high', source: 'defaulted', changed: false },
        other: { field: 'other', value: 'kept', source: 'provided', changed: false },
      },
      issues: [],
      orphan_fields: [],
    };

    const out = defaultedFieldsFrom(result);
    expect(out).toEqual([
      { field: 'priority', default_value: 'high', default_source: 'claim' },
    ]);
  });

  it("falls back to default_source 'global' when effective_fields entry is missing", () => {
    const result: ValidationResult = {
      valid: true,
      effective_fields: new Map(),
      coerced_state: {
        ghost: { field: 'ghost', value: 'g', source: 'defaulted', changed: false },
      },
      issues: [],
      orphan_fields: [],
    };
    const out = defaultedFieldsFrom(result);
    expect(out).toEqual([
      { field: 'ghost', default_value: 'g', default_source: 'global' },
    ]);
  });
});
