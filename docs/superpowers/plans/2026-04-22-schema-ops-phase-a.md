# Schema Ops Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase A chunk of schema-ops safety work — structured validation errors on schema-ops tools (A1), `batch-mutate` create respecting schema `default_directory` (A2), and `rename-node` default-directory consistency for multi-typed nodes (A3) — via the new charter-aligned `src/schema/errors.ts` and `src/schema/paths.ts` helpers.

**Architecture:** Two new files in `src/schema/` encapsulate cross-tool concerns (validation-error grouping; directory resolution). `update-schema.ts`, `create-node.ts`, `batch-mutate.ts`, and `rename-node.ts` are refactored to consume those helpers. A small DB migration adds `node_types.sort_order` so multi-typed nodes have a deterministic "first type" for directory resolution.

**Tech Stack:** TypeScript (ESM), better-sqlite3, zod for tool input, vitest for tests. ESM `.js` import extensions throughout (per CLAUDE.md).

**Source spec:** `docs/superpowers/specs/2026-04-21-schema-ops-phase-a-design.md`. Read that before touching code — it covers the "why" behind every decision here.

---

## File Structure

**New files:**

- `src/schema/errors.ts` — `SchemaValidationError` class, `ClaimValidationReason` / `ValidationGroup` types, `groupValidationIssues()` aggregation helper.
- `src/schema/paths.ts` — `resolveDirectory()` helper shared by `create-node`, `batch-mutate` create, and `rename-node`.
- `tests/schema/errors.test.ts` — unit tests for grouping utility.
- `tests/schema/paths.test.ts` — unit tests for `resolveDirectory` (all branches).
- `tests/mcp/update-schema.test.ts` — integration tests for `update-schema` envelope shapes.
- `tests/mcp/batch-mutate-directory.test.ts` — integration tests for new directory semantics (augments existing `type-safety.test.ts` batch coverage).
- `tests/mcp/rename-node-directory.test.ts` — integration tests for multi-typed rename consistency.

**Modified files:**

- `src/schema/crud.ts` — `validateClaims` throws `SchemaValidationError` instead of `Error`.
- `src/schema/propagate.ts` — `propagateSchemaChange` collects per-node validation failures and throws one `SchemaValidationError` at the end.
- `src/mcp/tools/update-schema.ts` — catches `SchemaValidationError` and surfaces via `fail('VALIDATION_FAILED', ..., { details })`.
- `src/mcp/tools/create-node.ts` — replace inline directory logic with `resolveDirectory()`.
- `src/mcp/tools/batch-mutate.ts` — rename zod `path` → `directory`, accept deprecated `path` alias, add `override_default_directory`, call `resolveDirectory()`.
- `src/mcp/tools/rename-node.ts` — read ordered types list via new `sort_order`, call `resolveDirectory()`.
- `src/db/migrate.ts` — new `addNodeTypesSortOrder` migration.
- `src/db/schema.ts` — update `CREATE TABLE` for `node_types` to include `sort_order` (so new DBs get it natively).
- `src/pipeline/execute.ts` — pass index as `sort_order` when reinserting node_types.
- `src/indexer/indexer.ts` — pass index as `sort_order` when inserting node_types.
- `src/index.ts` — wire new migration on startup.
- `tests/helpers/db.ts` — include new migration so tests match production schema.

---

## Task 1: Create `src/schema/errors.ts` with types + grouping utility

**Rationale.** Defines the charter-aligned error-shape contract all schema-ops tools use. Building it first unblocks all the tool-handler work.

**Files:**
- Create: `src/schema/errors.ts`
- Test: `tests/schema/errors.test.ts`

- [ ] **Step 1: Write the failing tests for types + `groupValidationIssues`**

Create `tests/schema/errors.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/schema/errors.test.ts`

Expected: FAIL with "Cannot find module '../../src/schema/errors.js'".

- [ ] **Step 3: Implement `src/schema/errors.ts`**

Create `src/schema/errors.ts`:

```typescript
// src/schema/errors.ts
//
// Structured validation errors for schema-ops tools.
// Sets the error-shape contract surfaced in MCP envelope details.

import type { IssueCode } from '../validation/types.js';

// ClaimValidationReason is the outward-facing reason enum. It collapses the
// pipeline's fine-grained IssueCode set into reasons that are meaningful to a
// schema-change caller (e.g., COERCION_FAILED + TYPE_MISMATCH both surface as
// TYPE_MISMATCH).
export type ClaimValidationReason =
  | 'UNKNOWN_FIELD'
  | 'OVERRIDE_NOT_ALLOWED'
  | 'STRUCTURAL_INCOMPAT'
  | 'ENUM_INVALID'
  | 'TYPE_MISMATCH'
  | 'REQUIRED_MISSING';

export interface ValidationGroup {
  reason: ClaimValidationReason;
  field: string;
  count: number;
  invalid_values?: Array<{ value: string; count: number }>;
  sample_nodes?: Array<{ id: string; title: string }>;
  message: string;
}

export interface PerNodeIssue {
  node_id: string;
  title: string;
  field: string;
  code: IssueCode;
  value?: unknown;
}

export class SchemaValidationError extends Error {
  constructor(public readonly groups: ValidationGroup[]) {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    super(`Schema change rejected: ${groups.length} validation group(s), ${total} total issue(s)`);
    this.name = 'SchemaValidationError';
  }
}

const ISSUE_TO_REASON: Record<IssueCode, ClaimValidationReason | null> = {
  REQUIRED_MISSING: 'REQUIRED_MISSING',
  ENUM_MISMATCH: 'ENUM_INVALID',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  COERCION_FAILED: 'TYPE_MISMATCH',
  LIST_ITEM_COERCION_FAILED: 'TYPE_MISMATCH',
  MERGE_CONFLICT: null,
  INTERNAL_CONSISTENCY: null,
};

const SAMPLE_LIMIT = 5;

export function groupValidationIssues(issues: PerNodeIssue[]): ValidationGroup[] {
  const buckets = new Map<string, {
    reason: ClaimValidationReason;
    field: string;
    nodes: Array<{ id: string; title: string }>;
    values: Map<string, number>;
  }>();

  for (const issue of issues) {
    const reason = ISSUE_TO_REASON[issue.code];
    if (!reason) continue;
    const key = `${reason}:${issue.field}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { reason, field: issue.field, nodes: [], values: new Map() };
      buckets.set(key, bucket);
    }
    bucket.nodes.push({ id: issue.node_id, title: issue.title });
    if (reason === 'ENUM_INVALID' && issue.value !== undefined) {
      const v = typeof issue.value === 'string' ? issue.value : JSON.stringify(issue.value);
      bucket.values.set(v, (bucket.values.get(v) ?? 0) + 1);
    }
  }

  return Array.from(buckets.values()).map(b => {
    const group: ValidationGroup = {
      reason: b.reason,
      field: b.field,
      count: b.nodes.length,
      sample_nodes: b.nodes.slice(0, SAMPLE_LIMIT),
      message: buildMessage(b.reason, b.field, b.nodes.length, b.values),
    };
    if (b.reason === 'ENUM_INVALID' && b.values.size > 0) {
      group.invalid_values = Array.from(b.values.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
    }
    return group;
  });
}

function buildMessage(
  reason: ClaimValidationReason,
  field: string,
  count: number,
  values: Map<string, number>,
): string {
  switch (reason) {
    case 'ENUM_INVALID': {
      const valueList = Array.from(values.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([v, c]) => `${v} (${c})`)
        .join(', ');
      return `${count} node(s) have values not in enum for field '${field}': ${valueList}. Either clean up the values on those nodes, extend the global enum, or enable enum_values_override on the global field.`;
    }
    case 'TYPE_MISMATCH':
      return `${count} node(s) have values incompatible with the declared type of field '${field}'. Fix the values on those nodes, or change the global field's type.`;
    case 'REQUIRED_MISSING':
      return `${count} node(s) are missing required field '${field}'. Provide values on those nodes, mark the claim non-required, or provide a default_value.`;
    case 'UNKNOWN_FIELD':
      return `Claim references unknown global field '${field}'. Create it first with create-global-field.`;
    case 'OVERRIDE_NOT_ALLOWED':
      return `Claim overrides a property on field '${field}' that is not marked overrides_allowed. Set the corresponding overrides_allowed flag on the global field first.`;
    case 'STRUCTURAL_INCOMPAT':
      return `Claim on field '${field}' is structurally incompatible (e.g. enum override on a non-enum field).`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/schema/errors.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Run type check**

Run: `npm run build`

Expected: clean exit, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/schema/errors.ts tests/schema/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): add SchemaValidationError + groupValidationIssues helper

Introduces the structured error-shape contract that schema-ops tools use to
surface per-node failures via MCP envelope details. Phase A foundation —
the tool handlers consume this in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Refactor `validateClaims` to throw `SchemaValidationError`

**Rationale.** The three existing throw sites in `validateClaims` (`UNKNOWN_FIELD`, `OVERRIDE_NOT_ALLOWED`, `STRUCTURAL_INCOMPAT`) map cleanly to `ValidationGroup`. Converting them now sets the tool handler up to branch on `err instanceof SchemaValidationError` uniformly.

**Files:**
- Modify: `src/schema/crud.ts` (the `validateClaims` function around lines 79-120)
- Test: `tests/schema/crud.test.ts` (existing — extend)

- [ ] **Step 1: Write failing tests extending `tests/schema/crud.test.ts`**

Append to `tests/schema/crud.test.ts` at the bottom (after any existing `describe` blocks):

```typescript
// ── SchemaValidationError path ──────────────────────────────────────

import { SchemaValidationError } from '../../src/schema/errors.js';

describe('validateClaims throws SchemaValidationError', () => {
  it('UNKNOWN_FIELD: claim referencing nonexistent global field', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'nonexistent' }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('UNKNOWN_FIELD');
    expect(err.groups[0].field).toBe('nonexistent');
    expect(err.groups[0].count).toBe(1);
  });

  it('OVERRIDE_NOT_ALLOWED: required override without overrides_allowed.required', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'due_date', required: true }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('OVERRIDE_NOT_ALLOWED');
    expect(err.groups[0].field).toBe('due_date');
  });

  it('STRUCTURAL_INCOMPAT: enum override on non-enum field', () => {
    // Allow the override so we reach the structural check
    createGlobalField(db, {
      name: 'body_text',
      field_type: 'string',
      overrides_allowed: { enum_values: true },
    });

    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [{ field: 'body_text', enum_values_override: ['a', 'b'] }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(1);
    expect(err.groups[0].reason).toBe('STRUCTURAL_INCOMPAT');
    expect(err.groups[0].field).toBe('body_text');
  });

  it('aggregates multiple claim-level failures into one throw (does not short-circuit)', () => {
    let caught: unknown = null;
    try {
      createSchemaDefinition(db, {
        name: 'Task',
        field_claims: [
          { field: 'nonexistent_a' },
          { field: 'nonexistent_b' },
          { field: 'due_date', required: true }, // OVERRIDE_NOT_ALLOWED
        ],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    expect(err.groups).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schema/crud.test.ts -t "SchemaValidationError"`

Expected: FAIL — currently throws generic `Error`, not `SchemaValidationError`. Also the aggregation test fails because current code short-circuits on first.

- [ ] **Step 3: Refactor `validateClaims` in `src/schema/crud.ts`**

Add this import at the top of the file, alongside the existing better-sqlite3 import:

```typescript
import { SchemaValidationError, type ValidationGroup } from './errors.js';
```

Replace the existing `validateClaims` function (lines 79-120) with:

```typescript
function validateClaims(db: Database.Database, claims: ClaimInput[]): void {
  const groups: ValidationGroup[] = [];

  for (const claim of claims) {
    const gf = db
      .prepare(`SELECT name, field_type, list_item_type, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values FROM global_fields WHERE name = ?`)
      .get(claim.field) as GlobalFieldRow | undefined;

    if (!gf) {
      groups.push({
        reason: 'UNKNOWN_FIELD',
        field: claim.field,
        count: 1,
        message: `Global field '${claim.field}' does not exist. Create it first with create-global-field.`,
      });
      continue; // subsequent checks on this claim are meaningless without gf
    }

    if (claim.required !== undefined && gf.overrides_allowed_required !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow required overrides. Set overrides_allowed.required = true on the global field.`,
      });
    }
    if ((claim.default_value !== undefined || claim.default_value_overridden) && gf.overrides_allowed_default_value !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow default_value overrides. Set overrides_allowed.default_value = true on the global field.`,
      });
    }
    if (claim.enum_values_override !== undefined && gf.overrides_allowed_enum_values !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow enum_values overrides. Set overrides_allowed.enum_values = true on the global field.`,
      });
    }

    if (claim.enum_values_override !== undefined) {
      const isEnumCompatible =
        gf.field_type === 'enum' ||
        (gf.field_type === 'list' && gf.list_item_type === 'enum');
      if (!isEnumCompatible) {
        groups.push({
          reason: 'STRUCTURAL_INCOMPAT',
          field: claim.field,
          count: 1,
          message: `Field '${claim.field}' (${gf.field_type}${gf.list_item_type ? '<' + gf.list_item_type + '>' : ''}) is structurally incompatible with enum_values_override. Only enum and list<enum> fields support enum overrides.`,
        });
      }
    }
  }

  if (groups.length > 0) throw new SchemaValidationError(groups);
}
```

- [ ] **Step 4: Run the new tests plus any existing ones that rely on the old string-match**

Run: `npx vitest run tests/schema/crud.test.ts`

Expected: new tests PASS. **Existing tests that use `.toThrow(/regex/)` — if they match on the old `Error.message` — will still pass because `SchemaValidationError.message` and the per-group `message` preserve the same remediation text substrings (e.g. `/overrides_allowed\.required/`).** If a regression surfaces, update the test to use the new structured check (pattern from Step 1). Do NOT change the thrown message templates.

- [ ] **Step 5: Run full schema test suite for regression**

Run: `npx vitest run tests/schema/`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema/crud.ts tests/schema/crud.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): validateClaims throws SchemaValidationError with grouped reasons

All three claim-level check sites (UNKNOWN_FIELD, OVERRIDE_NOT_ALLOWED,
STRUCTURAL_INCOMPAT) now accumulate into a single SchemaValidationError
instead of short-circuiting on the first failure. Existing remediation
messages preserved for CLI-style matchers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Refactor `propagateSchemaChange` to collect-all and throw `SchemaValidationError`

**Rationale.** Today's propagation throws `PipelineError` on the first per-node validation failure, obscuring the shape of the failure set. A1's goal is to let callers see all failures at once. Wrap the per-node loop in a transaction so successful writes roll back when the final throw fires; file-side partial-write leakage is accepted status quo until Phase B.

**Files:**
- Modify: `src/schema/propagate.ts`
- Test: `tests/schema/propagation.test.ts` (extend)

- [ ] **Step 1: Write failing test for collect-all behavior**

Append to `tests/schema/propagation.test.ts`:

```typescript
// ── collect-all behavior (Phase A) ─────────────────────────────────────

import { SchemaValidationError } from '../../src/schema/errors.js';

describe('propagateSchemaChange — collect-all validation failures', () => {
  it('throws SchemaValidationError aggregating all per-node ENUM_MISMATCH failures', () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
    });
    createSchemaDefinition(db, { name: 'note', field_claims: [] });

    // Seed three nodes with pre-existing enum-invalid values
    createNode({ file_path: 'a.md', title: 'A', types: ['note'], fields: { status: 'active' } });
    createNode({ file_path: 'b.md', title: 'B', types: ['note'], fields: { status: 'active' } });
    createNode({ file_path: 'c.md', title: 'C', types: ['note'], fields: { status: 'draft' } });

    // Now add the status claim — propagation should surface all three failures
    updateSchemaDefinition(db, 'note', { field_claims: [{ field: 'status', sort_order: 1 }] });
    const diff = diffClaims([], [{ field: 'status', sort_order: 1 }]);

    let caught: unknown = null;
    try {
      propagateSchemaChange(db, writeLock, vaultPath, 'note', diff);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    const err = caught as SchemaValidationError;
    const enumGroup = err.groups.find(g => g.reason === 'ENUM_INVALID' && g.field === 'status');
    expect(enumGroup).toBeDefined();
    expect(enumGroup!.count).toBe(3);
    expect(enumGroup!.invalid_values).toEqual([
      { value: 'active', count: 2 },
      { value: 'draft', count: 1 },
    ]);
    expect(enumGroup!.sample_nodes).toHaveLength(3);
  });

  it('happy-path unchanged: no failures means no throw', () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      default_value: 'open',
      required: true,
    });
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createNode({ file_path: 'd.md', title: 'D', types: ['note'], fields: {} });

    updateSchemaDefinition(db, 'note', { field_claims: [{ field: 'status', sort_order: 1 }] });
    const diff = diffClaims([], [{ field: 'status', sort_order: 1 }]);

    expect(() => propagateSchemaChange(db, writeLock, vaultPath, 'note', diff)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run tests/schema/propagation.test.ts -t "collect-all"`

Expected: FAIL — today the first node triggers `PipelineError` which propagates upward unchanged.

- [ ] **Step 3: Modify `src/schema/propagate.ts`**

Add the imports at the top:

```typescript
import { PipelineError } from '../pipeline/types.js';
import { SchemaValidationError, groupValidationIssues, type PerNodeIssue } from './errors.js';
```

In `propagateSchemaChange`, wrap the per-node loop in a `db.transaction(...)` and catch `PipelineError` per node. The full updated function body:

```typescript
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  syncLogger?: SyncLogger,
): PropagationResult {
  const result: PropagationResult = {
    nodes_affected: 0,
    nodes_rerendered: 0,
    defaults_populated: 0,
    fields_orphaned: 0,
  };

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return result;
  }

  const nodeIds = (db.prepare('SELECT node_id FROM node_types WHERE schema_type = ?').all(schemaName) as Array<{ node_id: string }>)
    .map(r => r.node_id);

  if (nodeIds.length === 0) return result;
  result.nodes_affected = nodeIds.length;

  const trigger = `update-schema: ${schemaName}`;
  const mergeCache = new Map<string, ReturnType<typeof mergeFieldClaims>>();
  const insertLog = db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)');

  const perNodeIssues: PerNodeIssue[] = [];

  const runLoop = db.transaction(() => {
    for (const nodeId of nodeIds) {
      const state = loadNodeState(db, nodeId);
      if (!state) continue;

      // Merge cache + adoption-default computation — unchanged from prior code
      const typeKey = [...state.types].sort().join(',');
      let mergeResult = mergeCache.get(typeKey);
      if (!mergeResult) {
        const ctx = loadSchemaContext(db, state.types);
        mergeResult = mergeFieldClaims(state.types, ctx.claimsByType, ctx.globalFields);
        mergeCache.set(typeKey, mergeResult);
      }
      const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

      const adoptionFieldsToDefault: Array<{ field: string; value: unknown }> = [];
      let fileCtx: FileContext | null = null;
      for (const field of diff.added) {
        if (field in state.currentFields) continue;
        const ef = effectiveFields.get(field);
        if (!ef?.resolved_required) continue;
        if (ef.resolved_default_value === null || ef.resolved_default_value === undefined) continue;
        if (fileCtx === null) fileCtx = buildFileContext(db, vaultPath, nodeId, state.file_path);
        adoptionFieldsToDefault.push({
          field,
          value: resolveDefaultValue(ef.resolved_default_value, fileCtx),
        });
      }

      const adoptionDefaults: Record<string, unknown> = {};
      const adoptionSources: Record<string, 'global' | 'claim'> = {};
      if (adoptionFieldsToDefault.length > 0) {
        const ctx = loadSchemaContext(db, state.types);
        for (const { field, value } of adoptionFieldsToDefault) {
          adoptionDefaults[field] = value;
          let src: 'global' | 'claim' = 'global';
          for (const claims of ctx.claimsByType.values()) {
            for (const c of claims) {
              if (c.field === field && c.default_value_override.kind === 'override') {
                src = 'claim';
                break;
              }
            }
            if (src === 'claim') break;
          }
          adoptionSources[field] = src;
        }
      }

      // Pipeline call — collect failures instead of re-throwing
      let pipelineResult: { node_id: string; file_path: string; file_written: boolean } | null = null;
      try {
        pipelineResult = rerenderNodeThroughPipeline(
          db, writeLock, vaultPath, nodeId, adoptionDefaults, syncLogger, state,
        );
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          for (const issue of err.validation.issues) {
            perNodeIssues.push({
              node_id: nodeId,
              title: state.title,
              field: issue.field,
              code: issue.code,
              value: state.currentFields[issue.field],
            });
          }
          continue;
        }
        throw err;
      }
      if (!pipelineResult) continue;

      // Post-mutation emission — unchanged
      const now = Date.now();
      for (const [field, value] of Object.entries(adoptionDefaults)) {
        insertLog.run(nodeId, now, 'field-defaulted', JSON.stringify({
          source: 'propagation',
          field,
          default_value: value,
          default_source: adoptionSources[field],
          trigger,
          node_types: state.types,
        }));
        result.defaults_populated++;
      }

      const orphanedInThisNode = diff.removed.filter(f => f in state.currentFields);
      if (orphanedInThisNode.length > 0) {
        insertLog.run(nodeId, now, 'fields-orphaned', JSON.stringify({
          source: 'propagation',
          trigger,
          orphaned_fields: orphanedInThisNode,
          node_types: state.types,
        }));
        result.fields_orphaned += orphanedInThisNode.length;
      }

      if (pipelineResult.file_written) result.nodes_rerendered++;
    }

    if (perNodeIssues.length > 0) {
      throw new SchemaValidationError(groupValidationIssues(perNodeIssues));
    }
  });

  runLoop();
  return result;
}
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run tests/schema/propagation.test.ts`

Expected: all PASS, including pre-existing happy-path tests.

- [ ] **Step 5: Run full build + test**

Run: `npm run build && npx vitest run tests/schema/`

Expected: clean build, all schema tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema/propagate.ts tests/schema/propagation.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): propagateSchemaChange collects per-node failures, throws aggregated SchemaValidationError

Per-node PipelineError from the pipeline call is now caught inside the
propagation loop and surfaced as PerNodeIssue entries. At the end of the
loop, accumulated issues are grouped via groupValidationIssues and
thrown as a SchemaValidationError, which rolls back the enclosing
db.transaction. Happy-path behavior unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `update-schema.ts` handler to surface structured errors in envelope

**Rationale.** The tool handler currently funnels every exception into `fail('INVALID_PARAMS', ...)` with an opaque "Validation failed" string. Add a narrowing branch for `SchemaValidationError` that emits `VALIDATION_FAILED` with `details.groups`.

**Files:**
- Modify: `src/mcp/tools/update-schema.ts`
- Test: `tests/mcp/update-schema.test.ts` (new)

- [ ] **Step 1: Write failing test for the MCP envelope shape**

Create `tests/mcp/update-schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateSchema(fakeServer, db, { writeLock, vaultPath });
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();

  createGlobalField(db, {
    name: 'status',
    field_type: 'enum',
    enum_values: ['open', 'closed'],
  });
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-schema structured validation errors', () => {
  it('claim-level UNKNOWN_FIELD surfaces VALIDATION_FAILED envelope with groups', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'does_not_exist' }],
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: unknown[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details?.groups).toBeDefined();
    const groups = err.details!.groups as Array<{ reason: string; field: string }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('UNKNOWN_FIELD');
    expect(groups[0].field).toBe('does_not_exist');
  });

  it('propagation ENUM_MISMATCH across multiple nodes surfaces aggregated group', async () => {
    for (const [i, v] of [['a', 'active'], ['b', 'active'], ['c', 'draft']]) {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: `${i}.md`,
        title: i.toUpperCase(),
        types: ['note'],
        fields: { status: v },
        body: '',
      });
    }

    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'note',
      field_claims: [{ field: 'status', sort_order: 1 }],
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; details?: { groups: unknown[] } } }).error;
    expect(err.code).toBe('VALIDATION_FAILED');
    const groups = err.details!.groups as Array<{
      reason: string;
      field: string;
      count: number;
      invalid_values?: Array<{ value: string; count: number }>;
    }>;
    const enumGroup = groups.find(g => g.reason === 'ENUM_INVALID');
    expect(enumGroup).toBeDefined();
    expect(enumGroup!.count).toBe(3);
    expect(enumGroup!.invalid_values).toEqual([
      { value: 'active', count: 2 },
      { value: 'draft', count: 1 },
    ]);
  });

  it('non-SchemaValidationError still funnels through INVALID_PARAMS', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      name: 'does_not_exist',
      display_name: 'x',
    }));
    expect(result.ok).toBe(false);
    const err = (result as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain("'does_not_exist' not found");
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run tests/mcp/update-schema.test.ts`

Expected: FAIL — currently everything funnels through `INVALID_PARAMS`.

- [ ] **Step 3: Modify `src/mcp/tools/update-schema.ts`**

Add the import at the top:

```typescript
import { SchemaValidationError } from '../../schema/errors.js';
```

Replace the existing catch block (the last 3 lines of the handler's try/catch):

```typescript
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
```

- [ ] **Step 4: Run the test to verify PASS**

Run: `npx vitest run tests/mcp/update-schema.test.ts`

Expected: all 3 tests PASS.

- [ ] **Step 5: Regression check on the overrides + phase3 tests**

Run: `npx vitest run tests/validation/overrides.test.ts tests/phase3/tools.test.ts`

Expected: PASS. If any test expected `error.code === 'INVALID_PARAMS'` for a case that is now `VALIDATION_FAILED`, update it to match — but only for true validation cases; schema-not-found etc. must stay `INVALID_PARAMS`.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(update-schema): surface SchemaValidationError via VALIDATION_FAILED envelope with grouped details

Callers now see actionable group details (reason, field, count,
invalid_values, sample_nodes) instead of an opaque "Validation failed"
string. Non-validation failures (schema not found, I/O) continue to route
through INVALID_PARAMS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Create `src/schema/paths.ts::resolveDirectory`

**Rationale.** Extract the directory-resolution logic so the same semantics can be reused by `create-node`, `batch-mutate`, and `rename-node` without copy-paste drift.

**Files:**
- Create: `src/schema/paths.ts`
- Test: `tests/schema/paths.test.ts`

- [ ] **Step 1: Write failing tests covering all branches**

Create `tests/schema/paths.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { resolveDirectory } from '../../src/schema/paths.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'task', field_claims: [], default_directory: 'TaskNotes/Tasks' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => db.close());

describe('resolveDirectory', () => {
  it('explicit directory with no schema default → explicit', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: 'Inbox', override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'Inbox', source: 'explicit' });
  });

  it('no directory + schema default → schema_default (uses first type)', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'Notes', source: 'schema_default' });
  });

  it('multi-typed: first type wins', () => {
    const r = resolveDirectory(db, { types: ['task', 'note'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: 'TaskNotes/Tasks', source: 'schema_default' });
  });

  it('no directory + no schema default → root', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });

  it('empty types + no directory → root', () => {
    const r = resolveDirectory(db, { types: [], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });

  it('explicit directory with schema default + no override → INVALID_PARAMS', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: 'Somewhere', override_default_directory: false });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; code: string }).code).toBe('INVALID_PARAMS');
    expect((r as { ok: false; message: string }).message).toMatch(/routes to "Notes\/"/);
  });

  it('explicit directory with schema default + override_default_directory=true → explicit', () => {
    const r = resolveDirectory(db, { types: ['note'], directory: 'Somewhere', override_default_directory: true });
    expect(r).toEqual({ ok: true, directory: 'Somewhere', source: 'explicit' });
  });

  it('directory ending with .md → INVALID_PARAMS (folder only)', () => {
    const r = resolveDirectory(db, { types: ['bare'], directory: 'x.md', override_default_directory: false });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; code: string }).code).toBe('INVALID_PARAMS');
    expect((r as { ok: false; message: string }).message).toMatch(/must be a folder path/);
  });

  it('type without schema → treated as no default (root)', () => {
    const r = resolveDirectory(db, { types: ['nosuch'], directory: undefined, override_default_directory: false });
    expect(r).toEqual({ ok: true, directory: '', source: 'root' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/schema/paths.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/schema/paths.ts`**

```typescript
// src/schema/paths.ts
//
// Shared directory-resolution helper used by create-node, batch-mutate,
// and rename-node. Single source of truth for "where does this node live
// given its types + optional caller override".

import type Database from 'better-sqlite3';

export interface ResolveDirectoryInput {
  types: string[];
  directory: string | undefined;
  override_default_directory: boolean;
}

export type ResolveDirectoryResult =
  | { ok: true; directory: string; source: 'explicit' | 'schema_default' | 'root' }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

export function resolveDirectory(
  db: Database.Database,
  input: ResolveDirectoryInput,
): ResolveDirectoryResult {
  if (input.directory !== undefined && input.directory.endsWith('.md')) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: '"directory" must be a folder path, not a filename. The filename is always derived from the node title.',
    };
  }

  let schemaDefaultDir: string | null = null;
  if (input.types.length >= 1) {
    const schema = db
      .prepare('SELECT default_directory FROM schemas WHERE name = ?')
      .get(input.types[0]) as { default_directory: string | null } | undefined;
    schemaDefaultDir = schema?.default_directory ?? null;
  }

  if (input.directory !== undefined && schemaDefaultDir && !input.override_default_directory) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: `Type "${input.types[0]}" routes to "${schemaDefaultDir}/" via schema. Pass override_default_directory: true to place this node elsewhere.`,
    };
  }

  if (input.directory !== undefined) return { ok: true, directory: input.directory, source: 'explicit' };
  if (schemaDefaultDir) return { ok: true, directory: schemaDefaultDir, source: 'schema_default' };
  return { ok: true, directory: '', source: 'root' };
}
```

- [ ] **Step 4: Run tests to verify PASS**

Run: `npx vitest run tests/schema/paths.test.ts`

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema/paths.ts tests/schema/paths.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): add resolveDirectory helper in src/schema/paths.ts

Single source of truth for directory resolution across node-mutation
tools. Consumers wired in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Refactor `create-node.ts` to use `resolveDirectory`

**Rationale.** `create-node` owns the semantics of directory resolution today; moving to the shared helper must be behavior-preserving so existing tests pass unchanged.

**Files:**
- Modify: `src/mcp/tools/create-node.ts` (lines 61-96 currently)

- [ ] **Step 1: Pre-change regression check**

Run: `npx vitest run tests/mcp/type-safety.test.ts tests/phase3/`

Expected: PASS baseline — any failures here block the refactor.

- [ ] **Step 2: Refactor `create-node.ts`**

Add the import at the top of `src/mcp/tools/create-node.ts`:

```typescript
import { resolveDirectory } from '../../schema/paths.js';
```

Replace the "Validate directory param" + "Derive file path" blocks (current lines 61-96) with:

```typescript
      // ── Resolve directory via shared helper ───────────────────────
      const dirResult = resolveDirectory(db, {
        types,
        directory,
        override_default_directory,
      });
      if (!dirResult.ok) return fail(dirResult.code, dirResult.message);

      // Filename template lookup — still inline (separate concern)
      let fileName = `${title}.md`;
      if (types.length >= 1) {
        const schema = db.prepare('SELECT filename_template FROM schemas WHERE name = ?')
          .get(types[0]) as { filename_template: string | null } | undefined;
        if (schema?.filename_template) {
          const derived = evaluateTemplate(schema.filename_template, title, fields);
          if (derived === null) {
            return fail('INVALID_PARAMS', 'Filename template has unresolved variables');
          }
          fileName = derived;
        }
      }
      const filePath = dirResult.directory
        ? `${dirResult.directory}/${fileName}`
        : fileName;
```

Remove the now-unused `schemaDefaultDir` declaration and the old conflict branch — both checks are now inside `resolveDirectory`. The outer `let filePath: string;` declaration also goes away (`const filePath =` replaces it).

- [ ] **Step 3: Run regression tests**

Run: `npx vitest run tests/mcp/type-safety.test.ts tests/phase3/`

Expected: all PASS — unchanged behavior.

- [ ] **Step 4: Run build**

Run: `npm run build`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/create-node.ts
git commit -m "$(cat <<'EOF'
refactor(create-node): use shared resolveDirectory helper

Behavior-preserving refactor. Inline directory logic replaced with a
call to src/schema/paths.ts::resolveDirectory. Filename-template
evaluation stays inline — it's a separate concern with its own shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Refactor `batch-mutate.ts` create op — rename `path` → `directory`, add `override_default_directory`, use `resolveDirectory`

**Rationale.** Fixes the actual bug (files landing in vault root when a schema has `default_directory`) and aligns `batch-mutate`'s create semantics with `create-node`'s. The `path` param is kept as a deprecated alias for one release.

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts`
- Test: `tests/mcp/batch-mutate-directory.test.ts` (new)

- [ ] **Step 1: Write failing integration tests**

Create `tests/mcp/batch-mutate-directory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: unknown): any {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerBatchMutate(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('batch-mutate create uses schema default_directory', () => {
  it('no directory, schema has default_directory → file lands in schema dir', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'MyNote', types: ['note'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Notes/MyNote.md');
    expect(existsSync(join(vaultPath, 'Notes/MyNote.md'))).toBe(true);
  });

  it('explicit directory conflicting with schema default, no override → BATCH_FAILED', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Rogue', types: ['note'], directory: 'Somewhere' } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BATCH_FAILED');
    expect(result.error.message).toMatch(/routes to "Notes\/"/);
  });

  it('directory + override_default_directory=true → lands in explicit directory', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Rogue', types: ['note'], directory: 'Somewhere', override_default_directory: true } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Somewhere/Rogue.md');
  });

  it('deprecated path alias alone → succeeds with DEPRECATED_PARAM warning', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'LegacyCall', types: ['bare'], path: 'Inbox' } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Inbox/LegacyCall.md');
    const deprecation = (result.warnings as Array<{ code: string }>).find(w => w.code === 'DEPRECATED_PARAM');
    expect(deprecation).toBeDefined();
  });

  it('both path and directory → BATCH_FAILED', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Conflict', types: ['bare'], path: 'A', directory: 'B' } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BATCH_FAILED');
    expect(result.error.message).toMatch(/path.*directory|Do not supply both/);
  });

  it('bare type (no schema default), no directory → root', async () => {
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Loose', types: ['bare'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data.results[0].file_path).toBe('Loose.md');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mcp/batch-mutate-directory.test.ts`

Expected: FAIL on the first case — today `batch-mutate` with no `path` writes to vault root, not `Notes/`.

- [ ] **Step 3: Modify `src/mcp/tools/batch-mutate.ts`**

Replace `createParamsSchema` (around lines 23-29) with:

```typescript
const createParamsSchema = z.object({
  title: z.string(),
  types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  body: z.string().optional(),
  directory: z.string().optional(),
  override_default_directory: z.boolean().optional(),
  path: z.string().optional().describe('DEPRECATED — use `directory`. Will be removed in a future release.'),
}).strict();
```

Add the import at the top:

```typescript
import { resolveDirectory } from '../../schema/paths.js';
```

Inside the create branch (inside `if (op === 'create')`), replace the block from `const title = opParams.title;` through the existing `throw new PipelineError('INVALID_PARAMS', \`File path "${filePath}" already exists\`);` line. The new block:

```typescript
              const title = opParams.title;
              const types = opParams.types ?? [];
              const fields = opParams.fields ?? {};
              const body = opParams.body ?? '';

              // Directory param reconciliation: `path` is a deprecated alias for `directory`.
              if (opParams.path !== undefined && opParams.directory !== undefined) {
                throw new PipelineError(
                  'INVALID_PARAMS',
                  "Do not supply both 'path' and 'directory' on a create op. 'path' is deprecated — use 'directory'.",
                );
              }
              let directoryParam = opParams.directory;
              if (opParams.path !== undefined && opParams.directory === undefined) {
                directoryParam = opParams.path;
                deprecationWarnings.push({
                  severity: 'warning',
                  code: 'DEPRECATED_PARAM',
                  message: "Param 'path' is deprecated in batch-mutate create; use 'directory' instead.",
                });
              }
              const override_default_directory = opParams.override_default_directory ?? false;

              // Type-schema check
              const typeCheck = checkTypesHaveSchemas(db, types);
              if (!typeCheck.valid) {
                throw new PipelineError('UNKNOWN_TYPE',
                  `Cannot create node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
              }

              const dirResult = resolveDirectory(db, { types, directory: directoryParam, override_default_directory });
              if (!dirResult.ok) throw new PipelineError(dirResult.code, dirResult.message);

              const filePath = dirResult.directory ? `${dirResult.directory}/${title}.md` : `${title}.md`;
              const absPath = safeVaultPath(vaultPath, filePath);

              const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath);
              if (existing || existsSync(absPath)) {
                throw new PipelineError('INVALID_PARAMS', `File path "${filePath}" already exists`);
              }
```

Before the `for (let i = 0; ...)` loop, add the deprecation-warning accumulator (top of the handler body, near the other `results: ...` declarations):

```typescript
      const deprecationWarnings: Array<{ severity: 'warning'; code: string; message: string }> = [];
```

In the success return branch (where `return ok({ applied: true, results: applied });` is called), pass `deprecationWarnings` as the second `ok` argument:

```typescript
          return ok({ applied: true, results: applied }, deprecationWarnings);
```

Update the tool-registration description (3rd arg to `server.tool`) to mention the new param. Current:
`'Execute multiple mutation operations atomically. All operations succeed or all roll back. Rename is not supported in batch.'`

New:
`'Execute multiple mutation operations atomically. All operations succeed or all roll back. Rename is not supported in batch. Create ops use schema default_directory when directory is omitted — pass override_default_directory: true to place elsewhere. The legacy path alias is deprecated; use directory.'`

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run tests/mcp/batch-mutate-directory.test.ts`

Expected: all 6 tests PASS.

- [ ] **Step 5: Run the existing batch-mutate coverage**

Run: `npx vitest run tests/mcp/type-safety.test.ts tests/undo/ tests/phase3/`

Expected: all PASS. If any test in `tests/mcp/type-safety.test.ts` passed `path` as a create param and expected no warnings, update the assertion to tolerate the new deprecation warning.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts tests/mcp/batch-mutate-directory.test.ts
git commit -m "$(cat <<'EOF'
fix(batch-mutate): create op respects schema default_directory via resolveDirectory

Previously, batch-mutate create without an explicit `path` wrote files
to the vault root regardless of the schema's default_directory. Now
delegates to the shared resolveDirectory helper matching create-node
semantics.

- Adds `directory` param (preferred)
- Adds `override_default_directory` param
- Accepts legacy `path` as a deprecated alias with DEPRECATED_PARAM warning
- Errors when both `path` and `directory` are supplied

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add `node_types.sort_order` migration + update write paths

**Rationale.** A3 needs a deterministic "first type" for multi-typed nodes so `rename-node` lines up with `create-node`. Today `node_types` has no ordering column, so `SELECT ... LIMIT 1` returns arbitrary rows. Add a `sort_order` column, populate at insert-time (preserving the `types: string[]` array order from the caller), and backfill existing rows using SQLite rowid as a best-effort proxy.

**Files:**
- Modify: `src/db/schema.ts` (CREATE TABLE for `node_types` so new DBs get sort_order natively)
- Modify: `src/db/migrate.ts` (add `addNodeTypesSortOrder`)
- Modify: `src/index.ts` (wire the migration)
- Modify: `tests/helpers/db.ts` (same wiring for in-memory test DB)
- Modify: `src/pipeline/execute.ts` (pass index as sort_order)
- Modify: `src/indexer/indexer.ts` (same)

- [ ] **Step 1: Write failing test confirming insertion order is preserved**

Append to `tests/schema/propagation.test.ts`:

```typescript
describe('node_types insertion order (Phase A3 prerequisite)', () => {
  it('sort_order column reflects order of types array on insert', () => {
    createGlobalField(db, { name: 'x', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [], default_directory: 'TaskNotes/Tasks' });
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });

    createNode({ file_path: 'z.md', title: 'Z', types: ['task', 'note'], fields: {}, body: '' });

    const rows = db.prepare(
      'SELECT schema_type, sort_order FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE title = ?) ORDER BY sort_order'
    ).all('Z') as Array<{ schema_type: string; sort_order: number }>;
    expect(rows.map(r => r.schema_type)).toEqual(['task', 'note']);
    expect(rows.map(r => r.sort_order)).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run tests/schema/propagation.test.ts -t "sort_order"`

Expected: FAIL — column does not exist.

- [ ] **Step 3: Update `src/db/schema.ts` — `node_types` CREATE TABLE**

Find the `node_types` block (around lines 22-27) and update it to include `sort_order`:

```sql
    CREATE TABLE IF NOT EXISTS node_types (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      schema_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (node_id, schema_type)
    );
    CREATE INDEX IF NOT EXISTS idx_node_types_schema_type ON node_types(schema_type);
```

- [ ] **Step 4: Add migration `addNodeTypesSortOrder` to `src/db/migrate.ts`**

Append to `src/db/migrate.ts`:

```typescript
/**
 * Migration: add node_types.sort_order column (2026-04-22, Phase A3).
 *
 * Enables deterministic "first type" lookup for multi-typed nodes — wins
 * back parity with the explicit types[0] ordering that create-node uses.
 *
 * Backfill uses SQLite rowid per (node_id) partition — best-effort proxy
 * for original insertion order. New inserts populate sort_order explicitly
 * via pipeline/indexer loops (caller-supplied types array index).
 *
 * Idempotent — safe to run on a database that already has the column.
 */
export function addNodeTypesSortOrder(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(node_types)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('sort_order')) {
      db.prepare('ALTER TABLE node_types ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0').run();
      db.prepare(`
        UPDATE node_types
        SET sort_order = (
          SELECT rn - 1 FROM (
            SELECT node_id, schema_type, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY rowid) AS rn
            FROM node_types
          ) sub
          WHERE sub.node_id = node_types.node_id AND sub.schema_type = node_types.schema_type
        )
      `).run();
    }
  });
  run();
}
```

- [ ] **Step 5: Wire the migration in `src/index.ts`**

In `src/index.ts`, update the import line that lists migration functions to include `addNodeTypesSortOrder`:

```typescript
import { upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6, addCreatedAt, upgradeForOverrides, ensureMetaTable, upgradeForResolvedTargetId, addUndoTables, addNodeTypesSortOrder } from './db/migrate.js';
```

After the `addUndoTables(db);` call (line 56 in current file), add:

```typescript
addNodeTypesSortOrder(db);
```

- [ ] **Step 6: Update `tests/helpers/db.ts`**

Replace contents:

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  return db;
}
```

The migration is idempotent and runs as a no-op on fresh DBs (the column already exists from Step 3). Keeping the call mirrors production startup ordering.

- [ ] **Step 7: Update `src/pipeline/execute.ts` to pass sort_order**

Find the line around 388:

```typescript
      const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
      for (const t of mutation.types) {
        insertType.run(nodeId, t);
      }
```

Replace with:

```typescript
      const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)');
      mutation.types.forEach((t, idx) => {
        insertType.run(nodeId, t, idx);
      });
```

- [ ] **Step 8: Update `src/indexer/indexer.ts` to pass sort_order**

In the prepared-statement block (around line 56):

```typescript
    insertType: db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)'),
```

Replace with:

```typescript
    insertType: db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)'),
```

Then find every call site of `statements.insertType.run(...)` in the file and update to pass a 3rd param (the index in the types array). Search:

Run: `grep -n "insertType" src/indexer/indexer.ts`

Update each caller's loop to pass the index:

```typescript
      types.forEach((t, idx) => {
        statements.insertType.run(nodeId, t, idx);
      });
```

- [ ] **Step 9: Run the test from Step 1**

Run: `npx vitest run tests/schema/propagation.test.ts -t "sort_order"`

Expected: PASS.

- [ ] **Step 10: Full regression**

Run: `npm run build && npx vitest run`

Expected: all PASS. Any test that inspects `node_types` rows directly without an `ORDER BY` may see reordered rows — search first: `grep -rn "FROM node_types" tests/`. If a test asserted row order without ORDER BY, add explicit ordering.

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/index.ts src/pipeline/execute.ts src/indexer/indexer.ts tests/helpers/db.ts tests/schema/propagation.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add node_types.sort_order column for deterministic first-type lookup

A3 prerequisite. Pipeline and indexer inserts pass the caller's
types-array index as sort_order, so multi-typed nodes have a stable
ordering that rename-node can rely on. Backfill uses rowid per partition
as a best-effort proxy for original insertion order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Refactor `rename-node.ts` to use `resolveDirectory` with ordered types

**Rationale.** Fixes the inconsistency where `create-node` uses `types[0]` (deterministic) but `rename-node` uses `LIMIT 1` without `ORDER BY` (non-deterministic). With sort_order in place, both tools now honor the same "first type wins" rule.

**Files:**
- Modify: `src/mcp/tools/rename-node.ts` (lines 234-253 currently)
- Test: `tests/mcp/rename-node-directory.test.ts` (new)

- [ ] **Step 1: Write failing integration tests**

Create `tests/mcp/rename-node-directory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: unknown): any {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerRenameNode(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  writeLock = new WriteLockManager();

  createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
  createSchemaDefinition(db, { name: 'task', field_claims: [], default_directory: 'TaskNotes/Tasks' });
  createSchemaDefinition(db, { name: 'bare', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('rename-node default-directory consistency for multi-typed nodes', () => {
  it('multi-typed [task, note] without directory param: stays in first-type dir (TaskNotes/Tasks)', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'TaskNotes/Tasks/Original.md',
      title: 'Original',
      types: ['task', 'note'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Original', new_title: 'Renamed' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('TaskNotes/Tasks/Renamed.md');
    expect(existsSync(join(vaultPath, 'TaskNotes/Tasks/Renamed.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/Renamed.md'))).toBe(false);
  });

  it('explicit directory wins over schema default', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'TaskNotes/Tasks/Another.md',
      title: 'Another',
      types: ['task'],
      fields: {},
      body: '',
    });

    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Another', new_title: 'Moved', directory: 'Archive' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('Archive/Moved.md');
  });

  it('single-typed node: unchanged behavior — falls into schema default dir', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Elsewhere/Solo.md',
      title: 'Solo',
      types: ['note'],
      fields: {},
      body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Solo', new_title: 'Solo2' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('Notes/Solo2.md');
  });

  it('node with no type-schema default preserves current directory', async () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Inbox/Untyped.md',
      title: 'Untyped',
      types: ['bare'],
      fields: {},
      body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ title: 'Untyped', new_title: 'UntypedNew' }));
    expect(result.ok).toBe(true);
    expect(result.data.new_file_path).toBe('Inbox/UntypedNew.md');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mcp/rename-node-directory.test.ts`

Expected: the multi-typed test FAILS (deterministically with the new sort_order ordering, or intermittently before). Other tests may pass accidentally.

- [ ] **Step 3: Refactor `rename-node.ts`**

Add the import at the top:

```typescript
import { resolveDirectory } from '../../schema/paths.js';
```

Replace the "Validate directory param" + "Derive new directory" blocks (current lines 234-253). Replace from `// ── Validate directory param ──` through the end of the `let newDir: string;` block:

```typescript
      // Read ordered types so we honor the same "first type wins" rule as create-node
      const orderedTypes = (db.prepare(
        'SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type'
      ).all(node.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);

      // Resolve directory via shared helper (covers .md guard + override semantics)
      const dirResult = resolveDirectory(db, {
        types: orderedTypes,
        directory: params.directory,
        override_default_directory: false,
      });
      if (!dirResult.ok) return fail(dirResult.code, dirResult.message);

      // When no type has a schema default, preserve the current directory
      // instead of moving the file to the vault root.
      const newDir = dirResult.source === 'root' ? dirname(oldFilePath) : dirResult.directory;
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run tests/mcp/rename-node-directory.test.ts`

Expected: all 4 PASS.

- [ ] **Step 5: Regression on existing rename-node tests**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts tests/phase3/rename-batch.test.ts tests/phase3/tools.test.ts tests/undo/integration.test.ts`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/rename-node.ts tests/mcp/rename-node-directory.test.ts
git commit -m "$(cat <<'EOF'
fix(rename-node): deterministic first-type directory resolution for multi-typed nodes

Previously rename-node used SELECT ... LIMIT 1 without ORDER BY to pick
which schema's default_directory wins — returning implementation-defined
results. Now delegates to resolveDirectory() with the node's types
ordered by sort_order, matching create-node's types[0] semantics.

Preserves existing fallback: when no claimed type has a default_directory,
the file stays in its current directory instead of moving to vault root.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Verify Phase A end-to-end

**Rationale.** Final gate before declaring Phase A done. Catches any gaps between the isolated task verifications and the integrated system.

- [ ] **Step 1: Full test suite**

Run: `npm run build && npx vitest run`

Expected: clean build, all PASS. If anything fails, investigate — do not skip.

- [ ] **Step 2: Verify spec coverage**

Re-read `docs/superpowers/specs/2026-04-21-schema-ops-phase-a-design.md`. Confirm each of:

- A1.1 ✓ `src/schema/errors.ts` exists with `SchemaValidationError` + grouping.
- A1.2 ✓ `propagateSchemaChange` collects and throws `SchemaValidationError`.
- A1.3 ✓ `update-schema.ts` surfaces `VALIDATION_FAILED` with `details.groups`.
- A2.1 ✓ `src/schema/paths.ts::resolveDirectory` exists with six branches.
- A2.2 ✓ `create-node.ts` uses `resolveDirectory`.
- A2.3 ✓ `batch-mutate.ts` create op uses `resolveDirectory`, accepts `directory`, deprecates `path`.
- A3 ✓ `rename-node.ts` uses `resolveDirectory` with ordered types; `node_types.sort_order` column + migration exist.

If any are missing, stop and address before closing Phase A.

- [ ] **Step 3: Manual smoke test — status-on-note scenario**

Against a staging vault (do NOT run against production `vault-new.db` unprotected — copy it first if needed), try adding the `status` claim to `note`'s schema via `update-schema` from the MCP surface.

Expected: `ok: false` with `error.code === 'VALIDATION_FAILED'` and `error.details.groups` containing an `ENUM_INVALID` entry for field `status` enumerating the bad values. **This is the self-diagnosing win Phase A delivers.**

- [ ] **Step 4: Manual smoke test — multi-typed rename**

Create a temporary node with `create-node` using `types: ["task", "note"]` (both schemas must have distinct `default_directory`s; e.g. `TaskNotes/Tasks` and `Notes`). Confirm it lands in `TaskNotes/Tasks/`. Then call `rename-node` on it with only `new_title` (no `directory`). Confirm the file stays in `TaskNotes/Tasks/`, not `Notes/`.

- [ ] **Step 5: Manual smoke test — batch-mutate directory**

Via batch-mutate, call `{op: 'create', params: {title: 'Smoke1', types: ['note']}}` (no `path`, no `directory`). Confirm the file is written at `Notes/Smoke1.md`, not at vault root.

- [ ] **Step 6: Final commit if there are CHANGELOG or docs updates**

If a `CHANGELOG.md` exists at repo root, add an entry under `[Unreleased]` (or the current version header). If not, skip:

```bash
git add -u
git diff --cached --quiet || git commit -m "$(cat <<'EOF'
chore: document Phase A (schema ops safety) in changelog

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Report back**

Phase A is done. Phase B depends on the Phase A surfaces (`SchemaValidationError`, `src/schema/paths.ts`, collect-all propagation, `node_types.sort_order`) already being in place, so it can now start.

---

## Open questions / implementation-time checks

1. **Does `node_types` have any deterministic ordering today?** Confirmed via reconnaissance: no — primary key is `(node_id, schema_type)`, no `sort_order` column. Task 8 adds it.
2. **Does `propagateSchemaChange`'s collect-all path introduce side effects?** The refactor in Task 3 wraps the loop in a `db.transaction` — if we throw at the end, the DB rolls back. File writes already flushed to disk by the per-node pipeline call are **not** rolled back; this matches the current behavior (update-schema has no file-level rollback today either) and is accepted until Phase B addresses it.
3. **Are there any other callers of inline directory logic besides `create-node`, `batch-mutate`, `rename-node`?** Confirmed via reconnaissance: no. If new sites surface during the refactors, update them to use `resolveDirectory` in the same task.
