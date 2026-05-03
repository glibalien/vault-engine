import { describe, it, expect } from 'vitest';
import { mergeFieldClaims } from '../../src/validation/merge.js';
import type {
  GlobalFieldDefinition,
  FieldClaim,
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
    overrides_allowed: { required: false, default_value: false, enum_values: false },
    list_item_type: null,
    ui_hints: null,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<FieldClaim> & { schema_name: string; field: string }): FieldClaim {
  return {
    label: null,
    description: null,
    sort_order: 1000,
    required_override: null,
    default_value_override: { kind: 'inherit' },
    enum_values_override: null,
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

  it('default_source — global when no override applies', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft' })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.default_source).toBe('global');
  });

  it('default_source — claim when a single override applies', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft', overrides_allowed: { required: false, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', default_value_override: { kind: 'override', value: 'open' } })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_default_value).toBe('open');
    expect(ef.default_source).toBe('claim');
  });

  it('default_source — global when overrides cancel on disagreement', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft', overrides_allowed: { required: false, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', default_value_override: { kind: 'override', value: 'open' } })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', default_value_override: { kind: 'override', value: 'active' } })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_default_value).toBe('draft');
    expect(ef.default_source).toBe('global');
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

  it('required disagreement — cancels to global value', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: false, overrides_allowed: { required: true, default_value: false, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required_override: true })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required_override: false })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    // Disagreement: cancels to global required (false)
    expect(ef.resolved_required).toBe(false);
  });

  it('required disagreement with global=true — cancels to true', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: true, overrides_allowed: { required: true, default_value: false, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required_override: true })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required_override: false })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    // Disagreement: cancels to global required (true)
    expect(ef.resolved_required).toBe(true);
  });

  it('default_value disagreement — cancels to global value', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft', overrides_allowed: { required: false, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', default_value_override: { kind: 'override', value: 'open' } })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', default_value_override: { kind: 'override', value: 'active' } })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    // Disagreement: cancels to global default_value ('draft')
    expect(ef.resolved_default_value).toBe('draft');
  });

  it('both required and default_value disagreements — both cancel to global', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: false, default_value: 'draft', overrides_allowed: { required: true, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required_override: true, default_value_override: { kind: 'override', value: 'open' } })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required_override: false, default_value_override: { kind: 'override', value: 'active' } })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_required).toBe(false);
    expect(ef.resolved_default_value).toBe('draft');
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

  it('global field defaults used — no claim overrides', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: true, default_value: 'open', overrides_allowed: { required: true, default_value: true, enum_values: false } })],
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

  it('agreeing overrides — both types set required_override=true → no conflict', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: false, overrides_allowed: { required: true, default_value: false, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required_override: true })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required_override: true })]],
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

  // ── default_value_override: null (override to nothing) ──

  it('default_value_override: null — overrides global default to nothing', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'open', overrides_allowed: { required: false, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['note', [makeClaim({ schema_name: 'note', field: 'status', default_value_override: { kind: 'override', value: null } })]],
    ]);

    const result = mergeFieldClaims(['note'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.resolved_default_value).toBeNull();
  });

  // ── Enum override tests ──

  it('single type with enum_values_override — per_type_enum_values populated', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], overrides_allowed: { required: false, default_value: false, enum_values: true } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', enum_values_override: ['open', 'in_progress', 'closed'] })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.per_type_enum_values).toEqual([
      { type: 'task', values: ['open', 'in_progress', 'closed'] },
    ]);
  });

  it('multi-type with different enum overrides — each type gets its values', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], overrides_allowed: { required: false, default_value: false, enum_values: true } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', enum_values_override: ['open', 'in_progress', 'closed'] })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', enum_values_override: ['active', 'archived'] })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.per_type_enum_values).toEqual([
      { type: 'task', values: ['open', 'in_progress', 'closed'] },
      { type: 'project', values: ['active', 'archived'] },
    ]);
  });

  it('mixed enum overrides — one type overrides, one inherits global', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], overrides_allowed: { required: false, default_value: false, enum_values: true } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', enum_values_override: ['open', 'in_progress', 'closed'] })]],
      ['note', [makeClaim({ schema_name: 'note', field: 'status' })]],  // inherits global
    ]);

    const result = mergeFieldClaims(['task', 'note'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.per_type_enum_values).toEqual([
      { type: 'task', values: ['open', 'in_progress', 'closed'] },
      { type: 'note', values: ['open', 'closed'] },  // inherits global enum_values
    ]);
  });

  it('no enum overrides — per_type_enum_values is undefined', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.per_type_enum_values).toBeUndefined();
  });
});
