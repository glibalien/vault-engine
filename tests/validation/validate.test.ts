import { describe, it, expect } from 'vitest';
import { validateProposedState } from '../../src/validation/validate.js';
import type {
  GlobalFieldDefinition,
  FieldClaim,
} from '../../src/validation/types.js';
import type { FileContext } from '../../src/validation/resolve-default.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function gf(overrides: Partial<GlobalFieldDefinition> & { name: string }): GlobalFieldDefinition {
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

function claim(overrides: Partial<FieldClaim> & { schema_name: string; field: string }): FieldClaim {
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

describe('validateProposedState', () => {
  it('valid state passes — string field with string value', () => {
    const globals = new Map([
      ['title', gf({ name: 'title' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'title' })]],
    ]);

    const result = validateProposedState(
      { title: 'Hello' },
      ['note'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.coerced_state.title).toBeDefined();
    expect(result.coerced_state.title.value).toBe('Hello');
    expect(result.coerced_state.title.source).toBe('provided');
    expect(result.coerced_state.title.changed).toBe(false);
  });

  it('REQUIRED_MISSING — required field not provided', () => {
    const globals = new Map([
      ['title', gf({ name: 'title', required: true })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'title' })]],
    ]);

    const result = validateProposedState(
      {},
      ['note'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('REQUIRED_MISSING');
    expect(result.issues[0].field).toBe('title');
  });

  it('default supplied — missing field with default_value', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', default_value: 'open' })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = validateProposedState(
      {},
      ['task'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.coerced_state.status).toBeDefined();
    expect(result.coerced_state.status.value).toBe('open');
    expect(result.coerced_state.status.source).toBe('defaulted');
    expect(result.coerced_state.status.changed).toBe(false);
  });

  it('null overrides default on non-required — field excluded from coerced_state', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', default_value: 'open' })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = validateProposedState(
      { status: null },
      ['task'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.coerced_state.status).toBeUndefined();
    expect(result.issues).toHaveLength(0);
  });

  it('null on required field — raises REQUIRED_MISSING', () => {
    const globals = new Map([
      ['title', gf({ name: 'title', required: true, default_value: 'untitled' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'title' })]],
    ]);

    const result = validateProposedState(
      { title: null },
      ['note'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('REQUIRED_MISSING');
    expect(result.issues[0].field).toBe('title');
    expect(result.coerced_state.title).toBeUndefined();
  });

  it('coercion applied — string "5" for number field', () => {
    const globals = new Map([
      ['priority', gf({ name: 'priority', field_type: 'number' })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'priority' })]],
    ]);

    const result = validateProposedState(
      { priority: '5' },
      ['task'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.coerced_state.priority.value).toBe(5);
    expect(result.coerced_state.priority.changed).toBe(true);
    expect(result.coerced_state.priority.original).toBe('5');
    expect(result.coerced_state.priority.source).toBe('provided');
  });

  it('enum mismatch — invalid enum value produces ENUM_MISMATCH with closest_matches', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed', 'in-progress'] })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = validateProposedState(
      { status: 'opne' },
      ['task'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('ENUM_MISMATCH');
    expect(result.issues[0].field).toBe('status');
    expect((result.issues[0].details as { closest_matches: string[] }).closest_matches).toContain('open');
  });

  it('orphan pass-through — unknown field in coerced_state with source="orphan"', () => {
    const globals = new Map([
      ['title', gf({ name: 'title' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'title' })]],
    ]);

    const result = validateProposedState(
      { title: 'Hello', custom_tag: 'my-tag' },
      ['note'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.coerced_state.custom_tag).toBeDefined();
    expect(result.coerced_state.custom_tag.value).toBe('my-tag');
    expect(result.coerced_state.custom_tag.source).toBe('orphan');
    expect(result.coerced_state.custom_tag.changed).toBe(false);
    expect(result.orphan_fields).toContain('custom_tag');
  });

  it('no bail on merge conflicts — merge conflict + missing required field both reported', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', per_type_overrides_allowed: true })],
      ['title', gf({ name: 'title', required: true })],
    ]);
    const claims = new Map([
      ['task', [
        claim({ schema_name: 'task', field: 'status', required: true }),
        claim({ schema_name: 'task', field: 'title' }),
      ]],
      ['note', [
        claim({ schema_name: 'note', field: 'status', required: false }),
        claim({ schema_name: 'note', field: 'title' }),
      ]],
    ]);

    const result = validateProposedState(
      {},
      ['task', 'note'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain('MERGE_CONFLICT');
    expect(codes).toContain('REQUIRED_MISSING');
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('all-schemaless — unknown types, all fields become orphans', () => {
    const globals = new Map<string, GlobalFieldDefinition>();
    const claims = new Map<string, FieldClaim[]>();

    const result = validateProposedState(
      { foo: 'bar', count: 42 },
      ['unknown-type'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.effective_fields.size).toBe(0);
    expect(result.orphan_fields).toEqual(expect.arrayContaining(['foo', 'count']));
    expect(result.coerced_state.foo.source).toBe('orphan');
    expect(result.coerced_state.count.source).toBe('orphan');
  });

  // ── Merge-conflict recovery (Phase 3) ────────────────────────────────

  it('merge conflict with provided value — value validated against global field and included in coerced_state', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [claim({ schema_name: 'project', field: 'status', required: false })]],
    ]);

    const result = validateProposedState(
      { status: 'open' },
      ['task', 'project'],
      claims,
      globals,
    );

    // Still not valid (MERGE_CONFLICT is error-severity), but value is in coerced_state
    expect(result.valid).toBe(false);
    expect(result.coerced_state.status).toBeDefined();
    expect(result.coerced_state.status.value).toBe('open');
    expect(result.coerced_state.status.source).toBe('provided');
    expect(result.coerced_state.status.changed).toBe(false);
    expect(result.issues.some(i => i.code === 'MERGE_CONFLICT')).toBe(true);
  });

  it('merge conflict with provided value that needs coercion — coerced value in coerced_state', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [claim({ schema_name: 'project', field: 'status', required: false })]],
    ]);

    const result = validateProposedState(
      { status: 'OPEN' },  // case mismatch, should be coerced
      ['task', 'project'],
      claims,
      globals,
    );

    expect(result.coerced_state.status).toBeDefined();
    expect(result.coerced_state.status.value).toBe('open');
    expect(result.coerced_state.status.changed).toBe(true);
    expect(result.coerced_state.status.original).toBe('OPEN');
  });

  it('merge conflict with invalid provided value — TYPE_MISMATCH alongside MERGE_CONFLICT', () => {
    const globals = new Map([
      ['priority', gf({ name: 'priority', field_type: 'number', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'priority', required: true })]],
      ['project', [claim({ schema_name: 'project', field: 'priority', required: false })]],
    ]);

    const result = validateProposedState(
      { priority: 'not-a-number' },
      ['task', 'project'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain('MERGE_CONFLICT');
    expect(codes).toContain('TYPE_MISMATCH');
    expect(result.coerced_state.priority).toBeUndefined();
  });

  it('merge conflict without provided value — field omitted from coerced_state', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [claim({ schema_name: 'project', field: 'status', required: false })]],
    ]);

    const result = validateProposedState(
      {},
      ['task', 'project'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    expect(result.coerced_state.status).toBeUndefined();
    expect(result.issues.some(i => i.code === 'MERGE_CONFLICT')).toBe(true);
  });

  it('Case 4: required agrees, default conflicts, no value — both REQUIRED_MISSING and MERGE_CONFLICT', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', required: true, per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status', default_value: 'open' })]],
      ['project', [claim({ schema_name: 'project', field: 'status', default_value: 'active' })]],
    ]);

    const result = validateProposedState(
      {},
      ['task', 'project'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain('MERGE_CONFLICT');
    expect(codes).toContain('REQUIRED_MISSING');
    expect(result.coerced_state.status).toBeUndefined();
  });

  it('merge conflict with null value — field omitted, no error', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [claim({ schema_name: 'project', field: 'status', required: false })]],
    ]);

    const result = validateProposedState(
      { status: null },
      ['task', 'project'],
      claims,
      globals,
    );

    // null is deletion intent — field excluded
    expect(result.coerced_state.status).toBeUndefined();
    // MERGE_CONFLICT still reported
    expect(result.issues.some(i => i.code === 'MERGE_CONFLICT')).toBe(true);
  });

  it('conflicted field is not classified as orphan', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', per_type_overrides_allowed: true })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status', required: true })]],
      ['project', [claim({ schema_name: 'project', field: 'status', required: false })]],
    ]);

    const result = validateProposedState(
      { status: 'hello' },
      ['task', 'project'],
      claims,
      globals,
    );

    expect(result.orphan_fields).not.toContain('status');
    expect(result.coerced_state.status).toBeDefined();
    expect(result.coerced_state.status.source).toBe('provided');
  });

  it('list element failure — list<number> with bad element', () => {
    const globals = new Map([
      ['scores', gf({ name: 'scores', field_type: 'list', list_item_type: 'number' })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'scores' })]],
    ]);

    const result = validateProposedState(
      { scores: ['1', 'bad', '3'] },
      ['task'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('LIST_ITEM_COERCION_FAILED');
    expect(result.issues[0].field).toBe('scores');
    const details = result.issues[0].details as { element_errors: Array<{ index: number }> };
    expect(details.element_errors).toBeDefined();
    expect(details.element_errors[0].index).toBe(1);
  });

  // ── Required + Default interaction ──────────────────────────────────

  it('required + default — missing field populated from default instead of erroring', () => {
    const globals = new Map([
      ['status', gf({ name: 'status', required: true, default_value: 'open' })],
    ]);
    const claims = new Map([
      ['task', [claim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = validateProposedState(
      {},
      ['task'],
      claims,
      globals,
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.coerced_state.status).toBeDefined();
    expect(result.coerced_state.status.value).toBe('open');
    expect(result.coerced_state.status.source).toBe('defaulted');
  });

  it('required + no default — still errors with REQUIRED_MISSING', () => {
    const globals = new Map([
      ['title', gf({ name: 'title', required: true })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'title' })]],
    ]);

    const result = validateProposedState(
      {},
      ['note'],
      claims,
      globals,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('REQUIRED_MISSING');
  });

  // ── Date token resolution ───────────────────────────────────────────

  it('date token default — $ctime resolved from fileCtx', () => {
    const fileCtx: FileContext = {
      birthtimeMs: new Date('2024-06-15T09:00:00').getTime(),
      mtimeMs: new Date('2025-01-01T12:00:00').getTime(),
    };
    const globals = new Map([
      ['date', gf({ name: 'date', field_type: 'reference', default_value: '$ctime:YYYY-MM-DD' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'date' })]],
    ]);

    const result = validateProposedState(
      {},
      ['note'],
      claims,
      globals,
      fileCtx,
    );

    expect(result.valid).toBe(true);
    expect(result.coerced_state.date.value).toBe('2024-06-15');
    expect(result.coerced_state.date.source).toBe('defaulted');
  });

  it('date token default — $mtime resolved from fileCtx', () => {
    const fileCtx: FileContext = {
      birthtimeMs: new Date('2024-06-15T09:00:00').getTime(),
      mtimeMs: new Date('2025-01-01T12:00:00').getTime(),
    };
    const globals = new Map([
      ['updated', gf({ name: 'updated', default_value: '$mtime:YYYY-MM-DD' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'updated' })]],
    ]);

    const result = validateProposedState(
      {},
      ['note'],
      claims,
      globals,
      fileCtx,
    );

    expect(result.coerced_state.updated.value).toBe('2025-01-01');
  });

  it('date token default — existing value not overwritten', () => {
    const fileCtx: FileContext = {
      birthtimeMs: new Date('2024-06-15T09:00:00').getTime(),
      mtimeMs: new Date('2025-01-01T12:00:00').getTime(),
    };
    const globals = new Map([
      ['date', gf({ name: 'date', field_type: 'reference', default_value: '$ctime:YYYY-MM-DD' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'date' })]],
    ]);

    const result = validateProposedState(
      { date: '2023-01-01' },
      ['note'],
      claims,
      globals,
      fileCtx,
    );

    expect(result.coerced_state.date.value).toBe('2023-01-01');
    expect(result.coerced_state.date.source).toBe('provided');
  });

  it('date token default — required + token resolves without error', () => {
    const fileCtx: FileContext = {
      birthtimeMs: new Date('2024-06-15T09:00:00').getTime(),
      mtimeMs: new Date('2025-01-01T12:00:00').getTime(),
    };
    const globals = new Map([
      ['date', gf({ name: 'date', field_type: 'reference', required: true, default_value: '$ctime:YYYY-MM-DD' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'date' })]],
    ]);

    const result = validateProposedState(
      {},
      ['note'],
      claims,
      globals,
      fileCtx,
    );

    expect(result.valid).toBe(true);
    expect(result.coerced_state.date.value).toBe('2024-06-15');
    expect(result.coerced_state.date.source).toBe('defaulted');
  });

  it('date token default — no fileCtx falls back to $now', () => {
    const globals = new Map([
      ['date', gf({ name: 'date', default_value: '$ctime:YYYY-MM-DD' })],
    ]);
    const claims = new Map([
      ['note', [claim({ schema_name: 'note', field: 'date' })]],
    ]);

    const result = validateProposedState(
      {},
      ['note'],
      claims,
      globals,
    );

    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(result.coerced_state.date.value).toBe(expected);
  });
});
