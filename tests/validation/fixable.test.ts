import { describe, it, expect } from 'vitest';
import { buildFixable } from '../../src/validation/fixable.js';
import type { ValidationIssue, EffectiveFieldSet } from '../../src/validation/types.js';

function makeEffective(fields: Array<{ name: string; order: number }>): EffectiveFieldSet {
  const map = new Map();
  for (const f of fields) {
    map.set(f.name, { field: f.name, resolved_order: f.order });
  }
  return map as EffectiveFieldSet;
}

describe('buildFixable', () => {
  it('ENUM_MISMATCH with closest_match — suggestion is closest_match', () => {
    const issues: ValidationIssue[] = [{
      field: 'priority',
      severity: 'error',
      code: 'ENUM_MISMATCH',
      message: 'bad enum',
      details: {
        provided: 'medium',
        allowed_values: ['low', 'normal', 'high', 'critical'],
        closest_match: 'normal',
      },
    }];
    const ef = makeEffective([{ name: 'priority', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('priority');
    expect(result[0].suggestion).toBe('normal');
  });

  it('ENUM_MISMATCH without closest_match — suggestion null, allowed_values present', () => {
    const issues: ValidationIssue[] = [{
      field: 'priority',
      severity: 'error',
      code: 'ENUM_MISMATCH',
      message: 'bad enum',
      details: { provided: 'zzzzz', allowed_values: ['low', 'high'], closest_match: null },
    }];
    const ef = makeEffective([{ name: 'priority', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(1);
    expect(result[0].suggestion).toBeNull();
    expect(result[0].allowed_values).toEqual(['low', 'high']);
  });

  it('REQUIRED_MISSING with default_value — suggestion is default_value', () => {
    const issues: ValidationIssue[] = [{
      field: 'status',
      severity: 'error',
      code: 'REQUIRED_MISSING',
      message: 'missing',
      details: { field_type: 'enum', allowed_values: ['open', 'done'], default_value: 'open' },
    }];
    const ef = makeEffective([{ name: 'status', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('status');
    expect(result[0].suggestion).toBe('open');
  });

  it('REQUIRED_MISSING enum without default — suggestion null, allowed_values present', () => {
    const issues: ValidationIssue[] = [{
      field: 'status',
      severity: 'error',
      code: 'REQUIRED_MISSING',
      message: 'missing',
      details: { field_type: 'enum', allowed_values: ['open', 'in-progress', 'done'] },
    }];
    const ef = makeEffective([{ name: 'status', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(1);
    expect(result[0].suggestion).toBeNull();
    expect(result[0].allowed_values).toEqual(['open', 'in-progress', 'done']);
  });

  it('REQUIRED_MISSING boolean without default — fixable with field_type', () => {
    const issues: ValidationIssue[] = [{
      field: 'active',
      severity: 'error',
      code: 'REQUIRED_MISSING',
      message: 'missing',
      details: { field_type: 'boolean' },
    }];
    const ef = makeEffective([{ name: 'active', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(1);
    expect(result[0].suggestion).toBeNull();
    expect(result[0].field_type).toBe('boolean');
  });

  it('REQUIRED_MISSING freeform string — NOT fixable', () => {
    const issues: ValidationIssue[] = [{
      field: 'title',
      severity: 'error',
      code: 'REQUIRED_MISSING',
      message: 'missing',
      details: { field_type: 'string' },
    }];
    const ef = makeEffective([{ name: 'title', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(0);
  });

  it('REQUIRED_MISSING freeform number — NOT fixable', () => {
    const issues: ValidationIssue[] = [{
      field: 'count',
      severity: 'error',
      code: 'REQUIRED_MISSING',
      message: 'missing',
      details: { field_type: 'number' },
    }];
    const ef = makeEffective([{ name: 'count', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(0);
  });

  it('TYPE_MISMATCH — never fixable', () => {
    const issues: ValidationIssue[] = [{
      field: 'priority',
      severity: 'error',
      code: 'TYPE_MISMATCH',
      message: 'bad type',
      details: { expected_type: 'number', provided_type: 'string', coercion_failed_reason: 'Cannot convert' },
    }];
    const ef = makeEffective([{ name: 'priority', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(0);
  });

  it('ordering follows field declaration order from effectiveFields', () => {
    const issues: ValidationIssue[] = [
      {
        field: 'priority',
        severity: 'error',
        code: 'ENUM_MISMATCH',
        message: 'bad',
        details: { provided: 'x', allowed_values: ['low', 'high'], closest_match: 'low' },
      },
      {
        field: 'status',
        severity: 'error',
        code: 'REQUIRED_MISSING',
        message: 'missing',
        details: { field_type: 'enum', allowed_values: ['open', 'done'], default_value: 'open' },
      },
    ];
    const ef = makeEffective([
      { name: 'status', order: 1 },
      { name: 'priority', order: 2 },
    ]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(2);
    expect(result[0].field).toBe('status');
    expect(result[1].field).toBe('priority');
  });

  it('MERGE_CONFLICT — not included in fixable', () => {
    const issues: ValidationIssue[] = [{
      field: 'status',
      severity: 'error',
      code: 'MERGE_CONFLICT',
      message: 'conflict',
    }];
    const ef = makeEffective([{ name: 'status', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(0);
  });

  it('REQUIRED_MISSING reference — fixable with field_type', () => {
    const issues: ValidationIssue[] = [{
      field: 'project',
      severity: 'error',
      code: 'REQUIRED_MISSING',
      message: 'missing',
      details: { field_type: 'reference', reference_target: 'project' },
    }];
    const ef = makeEffective([{ name: 'project', order: 1 }]);
    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(1);
    expect(result[0].field_type).toBe('reference');
  });
});
