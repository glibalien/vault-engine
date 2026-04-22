import { describe, it, expect } from 'vitest';
import {
  SchemaValidationError,
  groupValidationIssues,
  type ValidationGroup,
  type PerNodeIssue,
} from '../../src/schema/errors.js';

describe('SchemaValidationError', () => {
  it('constructs with a top-level message summarizing groups and total count', () => {
    const groups: ValidationGroup[] = [
      { reason: 'ENUM_INVALID', field: 'status', count: 10, message: '10 nodes bad' },
      { reason: 'REQUIRED_MISSING', field: 'owner', count: 2, message: '2 nodes missing owner' },
    ];
    const err = new SchemaValidationError(groups);
    expect(err.name).toBe('SchemaValidationError');
    expect(err.message).toMatch(/2 validation group\(s\)/);
    expect(err.message).toMatch(/12 total issue\(s\)/);
    expect(err.groups).toEqual(groups);
  });
});

describe('groupValidationIssues', () => {
  it('groups ENUM_MISMATCH per-node issues by field, rolls up invalid_values with counts', () => {
    const issues: PerNodeIssue[] = [
      { node_id: 'n1', title: 'N1', field: 'status', code: 'ENUM_MISMATCH', value: 'active' },
      { node_id: 'n2', title: 'N2', field: 'status', code: 'ENUM_MISMATCH', value: 'active' },
      { node_id: 'n3', title: 'N3', field: 'status', code: 'ENUM_MISMATCH', value: 'draft' },
      { node_id: 'n4', title: 'N4', field: 'status', code: 'ENUM_MISMATCH', value: 'spec' },
    ];
    const groups = groupValidationIssues(issues);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.reason).toBe('ENUM_INVALID');
    expect(g.field).toBe('status');
    expect(g.count).toBe(4);
    expect(g.invalid_values).toEqual([
      { value: 'active', count: 2 },
      { value: 'draft', count: 1 },
      { value: 'spec', count: 1 },
    ]);
    expect(g.sample_nodes).toHaveLength(4);
    expect(g.sample_nodes![0]).toEqual({ id: 'n1', title: 'N1' });
    expect(g.message).toMatch(/status/);
    expect(g.message).toMatch(/active \(2\)/);
  });

  it('groups TYPE_MISMATCH and REQUIRED_MISSING separately (no invalid_values rollup)', () => {
    const issues: PerNodeIssue[] = [
      { node_id: 'n1', title: 'N1', field: 'priority', code: 'TYPE_MISMATCH' },
      { node_id: 'n2', title: 'N2', field: 'priority', code: 'TYPE_MISMATCH' },
      { node_id: 'n3', title: 'N3', field: 'owner', code: 'REQUIRED_MISSING' },
    ];
    const groups = groupValidationIssues(issues);
    expect(groups).toHaveLength(2);
    const byKey = new Map(groups.map(g => [`${g.reason}:${g.field}`, g]));
    expect(byKey.get('TYPE_MISMATCH:priority')!.count).toBe(2);
    expect(byKey.get('TYPE_MISMATCH:priority')!.invalid_values).toBeUndefined();
    expect(byKey.get('REQUIRED_MISSING:owner')!.count).toBe(1);
  });

  it('truncates sample_nodes to 5', () => {
    const issues: PerNodeIssue[] = Array.from({ length: 12 }, (_, i) => ({
      node_id: `n${i}`,
      title: `Title${i}`,
      field: 'f',
      code: 'TYPE_MISMATCH' as const,
    }));
    const groups = groupValidationIssues(issues);
    expect(groups[0].count).toBe(12);
    expect(groups[0].sample_nodes).toHaveLength(5);
  });

  it('maps COERCION_FAILED and LIST_ITEM_COERCION_FAILED to TYPE_MISMATCH reason', () => {
    const issues: PerNodeIssue[] = [
      { node_id: 'n1', title: 'N1', field: 'n', code: 'COERCION_FAILED' },
      { node_id: 'n2', title: 'N2', field: 'n', code: 'LIST_ITEM_COERCION_FAILED' },
    ];
    const groups = groupValidationIssues(issues);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('TYPE_MISMATCH');
    expect(groups[0].count).toBe(2);
  });

  it('returns [] for empty input', () => {
    expect(groupValidationIssues([])).toEqual([]);
  });
});
