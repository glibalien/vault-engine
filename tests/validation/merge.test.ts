import { describe, it, expect } from 'vitest';
import { mergeFieldClaims } from '../../src/validation/merge.js';
import type {
  GlobalFieldDefinition,
  FieldClaim,
  MergeConflict,
  EffectiveField,
} from '../../src/validation/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeGlobal(overrides: Partial<GlobalFieldDefinition> & { name: string }): GlobalFieldDefinition {
  return {
    field_type: 'string',
    enum_values: null,
    reference_target: null,
    description: null,
    default_value: null,
    required: false,
    per_type_overrides_allowed: false,
    list_item_type: null,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<FieldClaim> & { schema_name: string; field: string }): FieldClaim {
  return {
    label: null,
    description: null,
    sort_order: 1000,
    required: null,
    default_value: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('mergeFieldClaims', () => {
  it('single type, single claim — produces one effective field with global defaults', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: true, default_value: 'open' })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.size).toBe(1);
    const ef = result.effective_fields.get('status')!;
    expect(ef.field).toBe('status');
    expect(ef.global_field).toBe(globals.get('status'));
    expect(ef.resolved_required).toBe(true);
    expect(ef.resolved_default_value).toBe('open');
    expect(ef.claiming_types).toEqual(['task']);
  });

  it('multi-type union — two types claiming different fields, union both', () => {
    const globals = new Map([
      ['priority', makeGlobal({ name: 'priority' })],
      ['due_date', makeGlobal({ name: 'due_date', field_type: 'date' })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'priority' })]],
      ['event', [makeClaim({ schema_name: 'event', field: 'due_date' })]],
    ]);

    const result = mergeFieldClaims(['task', 'event'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.size).toBe(2);
    expect(result.effective_fields.has('priority')).toBe(true);
    expect(result.effective_fields.has('due_date')).toBe(true);
    expect(result.effective_fields.get('priority')!.claiming_types).toEqual(['task']);
    expect(result.effective_fields.get('due_date')!.claiming_types).toEqual(['event']);
  });

  it('shared field — both types claim same field, claiming_types has both', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status' })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.claiming_types).toEqual(['task', 'project']);
  });

  it('first-defined-wins for presentation — first null, second has value', () => {
    const globals = new Map([
      ['priority', makeGlobal({ name: 'priority' })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'priority', label: null, description: 'Task desc', sort_order: 1000 })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'priority', label: 'Task Priority', description: 'Project desc', sort_order: 5 })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('priority')!;
    // label: first non-null → 'Task Priority' from project (task was null)
    expect(ef.resolved_label).toBe('Task Priority');
    // description: first non-null → 'Task desc' from task
    expect(ef.resolved_description).toBe('Task desc');
    // sort_order: first non-default (!=1000) → 5 from project (task was 1000)
    expect(ef.resolved_order).toBe(5);
  });

  it('semantic conflict — two types disagree on required → error', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required: false })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('status');
    expect(result.conflicts[0].property).toBe('required');
    expect(result.conflicts[0].conflicting_claims).toEqual([
      { type: 'task', value: true },
      { type: 'project', value: false },
    ]);
    // Conflicting field removed from partial_fields
    expect(result.partial_fields.has('status')).toBe(false);
  });

  it('collects ALL conflicts — disagreement on both required AND default_value', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required: true, default_value: 'open' })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required: false, default_value: 'active' })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts).toHaveLength(2);
    const props = result.conflicts.map(c => c.property).sort();
    expect(props).toEqual(['default_value', 'required']);
  });

  it('all-schemaless types — empty effective set, ok: true', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status' })],
    ]);
    const claims = new Map<string, FieldClaim[]>(); // no schemas at all

    const result = mergeFieldClaims(['note', 'log'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.size).toBe(0);
  });

  it('internal consistency error — claim has required on field with per_type_overrides_allowed=false', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', per_type_overrides_allowed: false })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required: true })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('status');
    expect(result.conflicts[0].property).toBe('required');
  });

  it('global field defaults used — no claim overrides', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: true, default_value: 'open', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_required).toBe(true);
    expect(ef.resolved_default_value).toBe('open');
  });

  it('agreeing overrides — both types set required=true → no conflict', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: false, per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required: true })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_required).toBe(true);
  });

  it('skips claims referencing unknown global fields', () => {
    const globals = new Map<string, GlobalFieldDefinition>(); // empty
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'nonexistent' })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.size).toBe(0);
  });
});
