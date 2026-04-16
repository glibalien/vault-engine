# Structured Error Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich validation failure responses so callers get everything needed to retry with valid values in one shot — no `describe-schema` round-trip required.

**Architecture:** Two layers of change. (1) `validateProposedState()` enriches `details` on three issue codes (ENUM_MISMATCH, REQUIRED_MISSING, TYPE_MISMATCH) using data already in scope. (2) Tool error handlers extract validation from `PipelineError`, build a `fixable` convenience summary, and return structured error responses. A new pure helper `buildFixable()` is shared across all write tools.

**Tech Stack:** TypeScript, vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/validation/validate.ts` | Modify | Enrich `details` on ENUM_MISMATCH, REQUIRED_MISSING, TYPE_MISMATCH issues |
| `src/validation/fixable.ts` | Create | `buildFixable(issues, effectiveFields)` pure function |
| `src/validation/types.ts` | Modify | Add `FixableEntry` type, add typed detail interfaces |
| `src/mcp/tools/errors.ts` | Modify | Add `toolValidationErrorResult()` helper |
| `src/mcp/tools/create-node.ts` | Modify | Use `toolValidationErrorResult` on PipelineError |
| `src/mcp/tools/update-node.ts` | Modify | Same |
| `src/mcp/tools/add-type-to-node.ts` | Modify | Same |
| `src/mcp/tools/batch-mutate.ts` | Modify | Same |
| `tests/validation/validate.test.ts` | Modify | Tests for enriched details |
| `tests/validation/fixable.test.ts` | Create | Tests for `buildFixable()` |
| `tests/mcp/structured-errors.test.ts` | Create | Integration tests for tool error responses |

---

### Task 1: Add typed detail interfaces to `src/validation/types.ts`

**Files:**
- Modify: `src/validation/types.ts`

- [ ] **Step 1: Add detail type definitions**

At the bottom of `src/validation/types.ts`, add:

```typescript
// ── Structured issue details ────────────────────────────────────────

export interface EnumMismatchDetails {
  provided: unknown;
  allowed_values: string[];
  closest_match: string | null;
}

export interface RequiredMissingDetails {
  field_type: FieldType;
  allowed_values?: string[];
  default_value?: unknown;
  reference_target?: string;
}

export interface TypeMismatchDetails {
  expected_type: FieldType;
  provided_type: string;
  coercion_failed_reason: string;
}

export interface FixableEntry {
  field: string;
  suggestion: unknown;
  allowed_values?: string[];
  field_type?: FieldType;
}
```

- [ ] **Step 2: Run build to verify types compile**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/validation/types.ts
git commit -m "feat: add typed detail interfaces for structured validation errors"
```

---

### Task 2: Enrich ENUM_MISMATCH details in `validateProposedState()`

**Files:**
- Modify: `src/validation/validate.ts`
- Modify: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/validation/validate.test.ts`:

```typescript
import type { EnumMismatchDetails } from '../../src/validation/types.js';

// ... inside the describe block:

it('ENUM_MISMATCH — details include provided, allowed_values, and closest_match', () => {
  const globals = new Map([
    ['priority', gf({ name: 'priority', field_type: 'enum', enum_values: ['low', 'normal', 'high', 'critical'] })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'priority' })]],
  ]);

  const result = validateProposedState(
    { priority: 'medium' },
    ['task'],
    claims,
    globals,
  );

  expect(result.valid).toBe(false);
  const issue = result.issues.find(i => i.code === 'ENUM_MISMATCH')!;
  const details = issue.details as EnumMismatchDetails;
  expect(details.provided).toBe('medium');
  expect(details.allowed_values).toEqual(['low', 'normal', 'high', 'critical']);
  expect(details.closest_match).toBe('normal');
});

it('ENUM_MISMATCH on conflicted field — same enriched details', () => {
  const globals = new Map([
    ['status', gf({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], per_type_overrides_allowed: true })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'status', required: true })]],
    ['project', [claim({ schema_name: 'project', field: 'status', required: false })]],
  ]);

  const result = validateProposedState(
    { status: 'pending' },
    ['task', 'project'],
    claims,
    globals,
  );

  const enumIssue = result.issues.find(i => i.code === 'ENUM_MISMATCH')!;
  const details = enumIssue.details as EnumMismatchDetails;
  expect(details.provided).toBe('pending');
  expect(details.allowed_values).toEqual(['open', 'closed']);
  expect(details.closest_match).toBe('closed');
});
```

Also update the existing test at line ~166 that asserts the old `closest_matches` shape. Replace:

```typescript
    expect((result.issues[0].details as { closest_matches: string[] }).closest_matches).toContain('open');
```

With:

```typescript
    const details = result.issues[0].details as EnumMismatchDetails;
    expect(details.provided).toBe('opne');
    expect(details.allowed_values).toEqual(['open', 'closed', 'in-progress']);
    expect(details.closest_match).toBe('open');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: FAIL — `details.provided` is undefined, `details.allowed_values` is undefined

- [ ] **Step 3: Implement enriched ENUM_MISMATCH details**

In `src/validation/validate.ts`, replace the coercion-failure detail-building block in both Step 3 (line ~122-144) and Step 3b (line ~194-216). Both blocks share the same pattern. Replace each occurrence of:

```typescript
      const details: Record<string, unknown> = {};
      if (fail.closest_matches) details.closest_matches = fail.closest_matches;
      if (fail.element_errors) details.element_errors = fail.element_errors;

      issues.push({
        field: fieldName,
        severity: 'error',
        code,
        message: fail.reason,
        details: Object.keys(details).length > 0 ? details : undefined,
      });
```

With:

```typescript
      let details: unknown;
      if (code === 'ENUM_MISMATCH') {
        const fieldDef = effectiveFields.get(fieldName) ?? conflictedFields.get(fieldName);
        details = {
          provided: value,
          allowed_values: fieldDef?.global_field.enum_values ?? [],
          closest_match: fail.closest_matches?.[0] ?? null,
        };
      } else if (code === 'TYPE_MISMATCH') {
        const fieldDef = effectiveFields.get(fieldName) ?? conflictedFields.get(fieldName);
        details = {
          expected_type: fieldDef?.global_field.field_type ?? fail.to_type,
          provided_type: fail.from_type,
          coercion_failed_reason: fail.reason,
        };
      } else if (fail.element_errors) {
        details = { element_errors: fail.element_errors };
      }

      issues.push({
        field: fieldName,
        severity: 'error',
        code,
        message: fail.reason,
        details,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/validation/validate.ts tests/validation/validate.test.ts
git commit -m "feat: enrich ENUM_MISMATCH and TYPE_MISMATCH details in validation issues"
```

---

### Task 3: Enrich REQUIRED_MISSING details

**Files:**
- Modify: `src/validation/validate.ts`
- Modify: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/validation/validate.test.ts`:

```typescript
import type { RequiredMissingDetails } from '../../src/validation/types.js';

it('REQUIRED_MISSING — details include field_type and allowed_values for enum field', () => {
  const globals = new Map([
    ['status', gf({ name: 'status', field_type: 'enum', enum_values: ['open', 'in-progress', 'done'], required: true })],
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

  const issue = result.issues.find(i => i.code === 'REQUIRED_MISSING')!;
  const details = issue.details as RequiredMissingDetails;
  expect(details.field_type).toBe('enum');
  expect(details.allowed_values).toEqual(['open', 'in-progress', 'done']);
  expect(details.default_value).toBeUndefined();
});

it('REQUIRED_MISSING — details include default_value when available', () => {
  const globals = new Map([
    ['status', gf({ name: 'status', field_type: 'enum', enum_values: ['open', 'done'], required: true, default_value: 'open' })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'status' })]],
  ]);

  // Use skipDefaults so REQUIRED_MISSING is emitted even with a default
  const result = validateProposedState(
    {},
    ['task'],
    claims,
    globals,
    { skipDefaults: true },
  );

  const issue = result.issues.find(i => i.code === 'REQUIRED_MISSING')!;
  const details = issue.details as RequiredMissingDetails;
  expect(details.field_type).toBe('enum');
  expect(details.default_value).toBe('open');
});

it('REQUIRED_MISSING — details include reference_target for reference field', () => {
  const globals = new Map([
    ['project', gf({ name: 'project', field_type: 'reference', reference_target: 'project', required: true })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'project' })]],
  ]);

  const result = validateProposedState(
    {},
    ['task'],
    claims,
    globals,
  );

  const issue = result.issues.find(i => i.code === 'REQUIRED_MISSING')!;
  const details = issue.details as RequiredMissingDetails;
  expect(details.field_type).toBe('reference');
  expect(details.reference_target).toBe('project');
});

it('REQUIRED_MISSING on null — details include field_type for boolean field', () => {
  const globals = new Map([
    ['active', gf({ name: 'active', field_type: 'boolean', required: true })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'active' })]],
  ]);

  const result = validateProposedState(
    { active: null },
    ['task'],
    claims,
    globals,
  );

  const issue = result.issues.find(i => i.code === 'REQUIRED_MISSING')!;
  const details = issue.details as RequiredMissingDetails;
  expect(details.field_type).toBe('boolean');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: FAIL — `issue.details` is undefined

- [ ] **Step 3: Implement enriched REQUIRED_MISSING details**

In `src/validation/validate.ts`, add a helper after imports:

```typescript
import type { RequiredMissingDetails, GlobalFieldDefinition as GFD } from './types.js';

function buildRequiredMissingDetails(gf: GFD): RequiredMissingDetails {
  const details: RequiredMissingDetails = { field_type: gf.field_type };
  if (gf.enum_values) details.allowed_values = gf.enum_values;
  if (gf.default_value !== null) details.default_value = gf.default_value;
  if (gf.reference_target) details.reference_target = gf.reference_target;
  return details;
}
```

Note: The import of `GlobalFieldDefinition` is already at the top of `validate.ts`. Use the existing import — just add `RequiredMissingDetails` to the import list.

Then add `details: buildRequiredMissingDetails(...)` to all three REQUIRED_MISSING issue pushes:

**Location 1 (~line 72):** `details: buildRequiredMissingDetails(ef.global_field),`

**Location 2 (~line 93):** `details: buildRequiredMissingDetails(ef.global_field),`

**Location 3 (~line 166):** `details: buildRequiredMissingDetails(cf.global_field),`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/validation/validate.ts tests/validation/validate.test.ts
git commit -m "feat: enrich REQUIRED_MISSING details with field_type, allowed_values, default_value"
```

---

### Task 4: TYPE_MISMATCH detail tests

TYPE_MISMATCH enrichment was implemented in Task 2's code change. This task adds explicit tests.

**Files:**
- Modify: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write the tests**

Add to `tests/validation/validate.test.ts`:

```typescript
import type { TypeMismatchDetails } from '../../src/validation/types.js';

it('TYPE_MISMATCH — details include expected_type, provided_type, coercion_failed_reason', () => {
  const globals = new Map([
    ['priority', gf({ name: 'priority', field_type: 'number' })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'priority' })]],
  ]);

  const result = validateProposedState(
    { priority: 'not-a-number' },
    ['task'],
    claims,
    globals,
  );

  expect(result.valid).toBe(false);
  const issue = result.issues.find(i => i.code === 'TYPE_MISMATCH')!;
  const details = issue.details as TypeMismatchDetails;
  expect(details.expected_type).toBe('number');
  expect(details.provided_type).toBe('string');
  expect(details.coercion_failed_reason).toContain('Cannot convert');
});

it('TYPE_MISMATCH on boolean field — correct types in details', () => {
  const globals = new Map([
    ['active', gf({ name: 'active', field_type: 'boolean' })],
  ]);
  const claims = new Map([
    ['task', [claim({ schema_name: 'task', field: 'active' })]],
  ]);

  const result = validateProposedState(
    { active: 'maybe' },
    ['task'],
    claims,
    globals,
  );

  const issue = result.issues.find(i => i.code === 'TYPE_MISMATCH')!;
  const details = issue.details as TypeMismatchDetails;
  expect(details.expected_type).toBe('boolean');
  expect(details.provided_type).toBe('string');
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: PASS (implementation was done in Task 2)

- [ ] **Step 3: Commit**

```bash
git add tests/validation/validate.test.ts
git commit -m "test: add TYPE_MISMATCH structured details tests"
```

---

### Task 5: Create `buildFixable()` helper

**Files:**
- Create: `src/validation/fixable.ts`
- Create: `tests/validation/fixable.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/fixable.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildFixable } from '../../src/validation/fixable.js';
import type { ValidationIssue, EffectiveFieldSet, FixableEntry } from '../../src/validation/types.js';

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
      details: {
        provided: 'zzzzz',
        allowed_values: ['low', 'high'],
        closest_match: null,
      },
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
      details: {
        field_type: 'enum',
        allowed_values: ['open', 'done'],
        default_value: 'open',
      },
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
      details: {
        field_type: 'enum',
        allowed_values: ['open', 'in-progress', 'done'],
      },
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
      details: {
        expected_type: 'number',
        provided_type: 'string',
        coercion_failed_reason: 'Cannot convert',
      },
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
    // status has lower order (1) than priority (2)
    const ef = makeEffective([
      { name: 'status', order: 1 },
      { name: 'priority', order: 2 },
    ]);

    const result = buildFixable(issues, ef);
    expect(result).toHaveLength(2);
    expect(result[0].field).toBe('status');
    expect(result[1].field).toBe('priority');
  });

  it('MERGE_CONFLICT and other codes — not included in fixable', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/fixable.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `buildFixable()`**

Create `src/validation/fixable.ts`:

```typescript
// src/validation/fixable.ts

import type {
  ValidationIssue,
  EffectiveFieldSet,
  FixableEntry,
  EnumMismatchDetails,
  RequiredMissingDetails,
} from './types.js';

/**
 * Build a convenience summary of which validation issues the caller can fix
 * in a follow-up call without human intervention.
 *
 * An issue is fixable when the structured details provide enough information
 * for the caller to construct a valid value:
 *   - ENUM_MISMATCH with closest_match -> suggestion = closest_match
 *   - ENUM_MISMATCH without closest_match -> suggestion = null, allowed_values provided
 *   - REQUIRED_MISSING with default_value -> suggestion = default_value
 *   - REQUIRED_MISSING enum without default -> suggestion = null, allowed_values provided
 *   - REQUIRED_MISSING boolean without default -> suggestion = null, field_type = boolean
 *   - REQUIRED_MISSING reference -> suggestion = null, field_type = reference
 *   - Everything else (TYPE_MISMATCH, freeform string/number, MERGE_CONFLICT) -> not fixable
 *
 * Results are ordered by field declaration order from effectiveFields.
 */
export function buildFixable(
  issues: ValidationIssue[],
  effectiveFields: EffectiveFieldSet,
): FixableEntry[] {
  const entries: FixableEntry[] = [];

  for (const issue of issues) {
    if (issue.code === 'ENUM_MISMATCH' && issue.details) {
      const d = issue.details as EnumMismatchDetails;
      const entry: FixableEntry = {
        field: issue.field,
        suggestion: d.closest_match ?? null,
      };
      if (!d.closest_match) {
        entry.allowed_values = d.allowed_values;
      }
      entries.push(entry);
    } else if (issue.code === 'REQUIRED_MISSING' && issue.details) {
      const d = issue.details as RequiredMissingDetails;

      if (d.default_value !== undefined) {
        entries.push({ field: issue.field, suggestion: d.default_value });
      } else if (d.field_type === 'enum' && d.allowed_values) {
        entries.push({ field: issue.field, suggestion: null, allowed_values: d.allowed_values });
      } else if (d.field_type === 'boolean') {
        entries.push({ field: issue.field, suggestion: null, field_type: 'boolean' });
      } else if (d.field_type === 'reference') {
        entries.push({ field: issue.field, suggestion: null, field_type: 'reference' });
      }
      // string, number, date, list without default -> not fixable
    }
    // TYPE_MISMATCH, COERCION_FAILED, MERGE_CONFLICT, etc. -> not fixable
  }

  // Sort by field declaration order
  entries.sort((a, b) => {
    const orderA = effectiveFields.get(a.field)?.resolved_order ?? Infinity;
    const orderB = effectiveFields.get(b.field)?.resolved_order ?? Infinity;
    return orderA - orderB;
  });

  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/validation/fixable.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/validation/fixable.ts tests/validation/fixable.test.ts
git commit -m "feat: add buildFixable() helper for structured error contract"
```

---

### Task 6: Add `toolValidationErrorResult()` to tool errors module

**Files:**
- Modify: `src/mcp/tools/errors.ts`

- [ ] **Step 1: Implement `toolValidationErrorResult()`**

Replace `src/mcp/tools/errors.ts` with:

```typescript
export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR' | 'VALIDATION_FAILED' | 'UNKNOWN_TYPE' | 'EXTRACTOR_UNAVAILABLE' | 'AMBIGUOUS_FILENAME' | 'CONFLICT';

export function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function toolErrorResult(code: ErrorCode, message: string) {
  return toolResult({ error: message, code });
}

import type { ValidationResult } from '../../validation/types.js';
import { buildFixable } from '../../validation/fixable.js';

/**
 * Build a structured VALIDATION_FAILED error response.
 * Includes full issues array and fixable convenience summary.
 */
export function toolValidationErrorResult(validation: ValidationResult) {
  const fixable = buildFixable(validation.issues, validation.effective_fields);
  return toolResult({
    error: `Validation failed with ${validation.issues.filter(i => i.severity === 'error').length} error(s)`,
    code: 'VALIDATION_FAILED' as ErrorCode,
    issues: validation.issues,
    fixable: fixable.length > 0 ? fixable : undefined,
  });
}
```

- [ ] **Step 2: Run build to verify**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/errors.ts
git commit -m "feat: add toolValidationErrorResult() for structured validation errors"
```

---

### Task 7: Wire structured errors into `create-node`

**Files:**
- Modify: `src/mcp/tools/create-node.ts`

- [ ] **Step 1: Update import and catch block**

Update the import at the top of `src/mcp/tools/create-node.ts`:

```typescript
import { toolResult, toolErrorResult, toolValidationErrorResult } from './errors.js';
```

Replace the catch block (lines ~147-152):

```typescript
      } catch (err) {
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
```

With:

```typescript
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          return toolValidationErrorResult(err.validation);
        }
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/create-node.ts
git commit -m "feat: wire structured validation errors into create-node"
```

---

### Task 8: Wire structured errors into `update-node`

**Files:**
- Modify: `src/mcp/tools/update-node.ts`

- [ ] **Step 1: Update import and catch block**

Update the import at the top:

```typescript
import { toolResult, toolErrorResult, toolValidationErrorResult } from './errors.js';
```

Replace the catch block (lines ~277-282):

```typescript
      } catch (err) {
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
```

With:

```typescript
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          return toolValidationErrorResult(err.validation);
        }
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/update-node.ts
git commit -m "feat: wire structured validation errors into update-node"
```

---

### Task 9: Wire structured errors into `add-type-to-node`

**Files:**
- Modify: `src/mcp/tools/add-type-to-node.ts`

- [ ] **Step 1: Update import and catch block**

Update the import at the top:

```typescript
import { toolResult, toolErrorResult, toolValidationErrorResult } from './errors.js';
```

Replace the catch block (lines ~140-145):

```typescript
      } catch (err) {
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
```

With:

```typescript
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          return toolValidationErrorResult(err.validation);
        }
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/add-type-to-node.ts
git commit -m "feat: wire structured validation errors into add-type-to-node"
```

---

### Task 10: Wire structured errors into `batch-mutate`

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts`

- [ ] **Step 1: Update error handling**

Add import at the top:

```typescript
import { buildFixable } from '../../validation/fixable.js';
```

Update the `batchError` type at line ~48. Replace:

```typescript
      let batchError: { failed_at: number; error: { op: string; message: string } } | null = null as { failed_at: number; error: { op: string; message: string } } | null;
```

With:

```typescript
      let batchError: { failed_at: number; error: Record<string, unknown> } | null = null;
```

Replace the catch block (lines ~165-173):

```typescript
          } catch (err) {
            if (err instanceof PipelineError) {
              batchError = { failed_at: i, error: { op, message: err.message } };
            } else {
              batchError = { failed_at: i, error: { op, message: err instanceof Error ? err.message : String(err) } };
            }
            // Throw to trigger SQLite transaction rollback
            throw err;
          }
```

With:

```typescript
          } catch (err) {
            if (err instanceof PipelineError) {
              const errObj: Record<string, unknown> = { op, message: err.message };
              if (err.validation) {
                errObj.issues = err.validation.issues;
                const fixable = buildFixable(err.validation.issues, err.validation.effective_fields);
                if (fixable.length > 0) errObj.fixable = fixable;
              }
              batchError = { failed_at: i, error: errObj };
            } else {
              batchError = { failed_at: i, error: { op, message: err instanceof Error ? err.message : String(err) } };
            }
            // Throw to trigger SQLite transaction rollback
            throw err;
          }
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts
git commit -m "feat: wire structured validation errors into batch-mutate"
```

---

### Task 11: Integration tests for structured error responses

**Files:**
- Create: `tests/mcp/structured-errors.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/mcp/structured-errors.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import { toolValidationErrorResult } from '../../src/mcp/tools/errors.js';
import type { EnumMismatchDetails, TypeMismatchDetails } from '../../src/validation/types.js';

let db: Database.Database;
let vaultPath: string;

function setupDb() {
  vaultPath = mkdtempSync(join(tmpdir(), 've-structured-errors-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Minimal schema for testing
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      content_hash TEXT,
      file_mtime INTEGER,
      indexed_at INTEGER,
      created_at INTEGER
    );
    CREATE TABLE node_types (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      schema_type TEXT NOT NULL,
      PRIMARY KEY (node_id, schema_type)
    );
    CREATE TABLE node_fields (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_date TEXT,
      value_json TEXT,
      value_raw_text TEXT,
      source TEXT NOT NULL DEFAULT 'frontmatter',
      PRIMARY KEY (node_id, field_name)
    );
    CREATE TABLE relationships (
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      context TEXT
    );
    CREATE VIRTUAL TABLE nodes_fts USING fts5(title, body, content='');
    CREATE TABLE edits_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT
    );
    CREATE TABLE schemas (
      name TEXT PRIMARY KEY,
      description TEXT,
      default_directory TEXT,
      filename_template TEXT
    );
    CREATE TABLE schema_field_claims (
      schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      field TEXT NOT NULL,
      label TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 1000,
      required INTEGER,
      default_value TEXT,
      PRIMARY KEY (schema_name, field)
    );
    CREATE TABLE global_fields (
      name TEXT PRIMARY KEY,
      field_type TEXT NOT NULL DEFAULT 'string',
      enum_values TEXT,
      reference_target TEXT,
      description TEXT,
      default_value TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0,
      list_item_type TEXT
    );
  `);

  // Set up a task schema with enum status and number priority
  db.prepare("INSERT INTO schemas (name, description) VALUES ('task', 'A task')").run();
  db.prepare("INSERT INTO global_fields (name, field_type, enum_values, required) VALUES ('status', 'enum', ?, 1)")
    .run(JSON.stringify(['open', 'in-progress', 'done', 'dropped']));
  db.prepare("INSERT INTO global_fields (name, field_type, required) VALUES ('priority', 'number', 0)").run();
  db.prepare("INSERT INTO schema_field_claims (schema_name, field, sort_order, required) VALUES ('task', 'status', 1, 1)").run();
  db.prepare("INSERT INTO schema_field_claims (schema_name, field, sort_order) VALUES ('task', 'priority', 2)").run();
}

function teardownDb() {
  db.close();
  if (existsSync(vaultPath)) rmSync(vaultPath, { recursive: true });
}

const writeLock = {
  withLockSync<T>(_path: string, fn: () => T): T { return fn(); },
  isLocked() { return false; },
} as any;

describe('structured validation error responses', () => {
  beforeAll(setupDb);
  afterAll(teardownDb);

  it('bad enum value -> toolValidationErrorResult has issues and fixable', () => {
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: 'test-node.md',
        title: 'Test Node',
        types: ['task'],
        fields: { status: 'medium' },
        body: '',
      });
      expect.unreachable('Should have thrown PipelineError');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      const pe = err as PipelineError;
      expect(pe.validation).toBeDefined();

      const response = toolValidationErrorResult(pe.validation!);
      const body = JSON.parse(response.content[0].text);

      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.issues).toBeDefined();
      expect(body.issues.length).toBeGreaterThan(0);

      // Check ENUM_MISMATCH details
      const enumIssue = body.issues.find((i: any) => i.code === 'ENUM_MISMATCH');
      expect(enumIssue).toBeDefined();
      expect(enumIssue.details.provided).toBe('medium');
      expect(enumIssue.details.allowed_values).toEqual(['open', 'in-progress', 'done', 'dropped']);
      expect(enumIssue.details.closest_match).toBeDefined();

      // Check fixable
      expect(body.fixable).toBeDefined();
      const fixStatus = body.fixable.find((f: any) => f.field === 'status');
      expect(fixStatus).toBeDefined();
      expect(fixStatus.suggestion).toBeDefined();
    }
  });

  it('missing required field -> fixable with allowed_values for enum', () => {
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: 'test-missing.md',
        title: 'Test Missing',
        types: ['task'],
        fields: {},
        body: '',
      });
      expect.unreachable('Should have thrown PipelineError');
    } catch (err) {
      const pe = err as PipelineError;
      const response = toolValidationErrorResult(pe.validation!);
      const body = JSON.parse(response.content[0].text);

      // status is required enum with no default -> fixable with allowed_values
      const fixStatus = body.fixable?.find((f: any) => f.field === 'status');
      expect(fixStatus).toBeDefined();
      expect(fixStatus.suggestion).toBeNull();
      expect(fixStatus.allowed_values).toEqual(['open', 'in-progress', 'done', 'dropped']);
    }
  });

  it('type mismatch -> not in fixable', () => {
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: 'test-type.md',
        title: 'Test Type',
        types: ['task'],
        fields: { status: 'open', priority: 'not-a-number' },
        body: '',
      });
      expect.unreachable('Should have thrown PipelineError');
    } catch (err) {
      const pe = err as PipelineError;
      const response = toolValidationErrorResult(pe.validation!);
      const body = JSON.parse(response.content[0].text);

      const typeIssue = body.issues.find((i: any) => i.code === 'TYPE_MISMATCH');
      expect(typeIssue).toBeDefined();
      expect(typeIssue.details.expected_type).toBe('number');
      expect(typeIssue.details.provided_type).toBe('string');

      // TYPE_MISMATCH should not be in fixable
      const fixPriority = body.fixable?.find((f: any) => f.field === 'priority');
      expect(fixPriority).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/mcp/structured-errors.test.ts`
Expected: All PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass, no regressions

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/structured-errors.test.ts
git commit -m "test: add integration tests for structured validation error responses"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean compile
