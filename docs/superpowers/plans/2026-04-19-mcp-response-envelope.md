# MCP Response Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace seven-plus idiosyncratic MCP tool response shapes with a uniform `{ok, data, warnings: Issue[], error?: {code, message, details?}}` envelope across all 27 tool files, closing arch-review finding §3a.

**Architecture:** New `ok()` / `fail()` / `adaptIssue()` helpers in `src/mcp/tools/errors.ts` produce the envelope. Old helpers (`toolResult`, `toolErrorResult`, `toolValidationErrorResult`) are kept alongside during migration and deleted in the final task, keeping the build green between tasks. `Issue` is a new tool-boundary type; `ValidationIssue` and `ToolIssue` stay internal and adapt via `adaptIssue()`. Per-tool `data` shapes are not standardized by this sequence — envelope is a shape wrapper.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk`, `better-sqlite3`, `vitest`.

**Reference:** [Design spec](../specs/2026-04-19-mcp-response-envelope-design.md) — envelope schema, issue taxonomy, per-tool migration mapping.

---

## File Structure

**Modify:**
- `src/mcp/tools/errors.ts` — add new types + helpers in Task 1; delete old helpers in final task
- `src/mcp/tools/*.ts` — 27 tool files, migrated in Tasks 2-15
- `tests/mcp/*.test.ts`, `tests/phase3/*.test.ts`, `tests/integration/*.test.ts` — update assertions per migrated tool
- `src/validation/types.ts` — no change; `ValidationIssue` stays as the internal type
- `src/mcp/tools/title-warnings.ts` — no change; `ToolIssue` stays as the internal type

**Create:**
- `tests/mcp/envelope-helpers.test.ts` — unit tests for `ok()` / `fail()` / `adaptIssue()` (Task 1)
- `tests/mcp/envelope.test.ts` — envelope-invariant property tests across all registered tools (Task 16)

**Delete:**
- Nothing — tool files and helpers are modified, not deleted.

---

## Task 1: Add new envelope types and helpers to `errors.ts`

Old helpers are kept alongside the new ones. Build stays green after this task so subsequent tool migrations compile incrementally.

**Files:**
- Create: `tests/mcp/envelope-helpers.test.ts`
- Modify: `src/mcp/tools/errors.ts`

- [ ] **Step 1.1: Write the failing unit tests**

Create `tests/mcp/envelope-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ok, fail, adaptIssue } from '../../src/mcp/tools/errors.js';
import type { ValidationIssue } from '../../src/validation/types.js';
import type { ToolIssue } from '../../src/mcp/tools/title-warnings.js';

function parseEnvelope(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('ok()', () => {
  it('wraps data with empty warnings by default', () => {
    const env = parseEnvelope(ok({ foo: 1 }));
    expect(env).toEqual({ ok: true, data: { foo: 1 }, warnings: [] });
  });

  it('includes provided warnings', () => {
    const warnings = [{ code: 'W', message: 'm', severity: 'warning' as const }];
    const env = parseEnvelope(ok({ foo: 1 }, warnings));
    expect(env).toEqual({ ok: true, data: { foo: 1 }, warnings });
  });

  it('handles array data (read-only bare-array tools)', () => {
    const env = parseEnvelope(ok([1, 2, 3]));
    expect(env).toEqual({ ok: true, data: [1, 2, 3], warnings: [] });
  });
});

describe('fail()', () => {
  it('wraps error code + message with empty warnings and no details', () => {
    const env = parseEnvelope(fail('NOT_FOUND', 'missing'));
    expect(env).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing' },
      warnings: [],
    });
  });

  it('includes details when provided', () => {
    const env = parseEnvelope(fail('UNKNOWN_TYPE', 'bad type', {
      details: { unknown_types: ['X'], available_schemas: ['A', 'B'] },
    }));
    expect(env.error.details).toEqual({ unknown_types: ['X'], available_schemas: ['A', 'B'] });
  });

  it('includes warnings when provided', () => {
    const warnings = [{ code: 'W', message: 'm', severity: 'warning' as const }];
    const env = parseEnvelope(fail('INVALID_PARAMS', 'bad', { warnings }));
    expect(env.warnings).toEqual(warnings);
  });

  it('omits details key when not provided', () => {
    const env = parseEnvelope(fail('NOT_FOUND', 'x'));
    expect('details' in env.error).toBe(false);
  });
});

describe('adaptIssue()', () => {
  it('passes ValidationIssue through, preserving severity and details', () => {
    const vi: ValidationIssue = {
      field: 'status',
      severity: 'error',
      code: 'TYPE_MISMATCH',
      message: 'expected number',
      details: { expected: 'number', got: 'string' },
    };
    expect(adaptIssue(vi)).toEqual({
      field: 'status',
      severity: 'error',
      code: 'TYPE_MISMATCH',
      message: 'expected number',
      details: { expected: 'number', got: 'string' },
    });
  });

  it('converts ToolIssue with characters into warning with details.characters', () => {
    const ti: ToolIssue = {
      code: 'TITLE_WIKILINK_UNSAFE',
      message: 'bad chars',
      characters: ['[', ']'],
    };
    expect(adaptIssue(ti)).toEqual({
      code: 'TITLE_WIKILINK_UNSAFE',
      message: 'bad chars',
      severity: 'warning',
      details: { characters: ['[', ']'] },
    });
  });

  it('converts ToolIssue without characters into warning with no details', () => {
    const ti: ToolIssue = { code: 'FRONTMATTER_IN_BODY', message: 'm' };
    const out = adaptIssue(ti);
    expect(out).toEqual({ code: 'FRONTMATTER_IN_BODY', message: 'm', severity: 'warning' });
    expect('details' in out).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run tests — confirm they fail**

Run: `npx vitest run tests/mcp/envelope-helpers.test.ts`
Expected: FAIL with "ok/fail/adaptIssue is not a function" or equivalent.

- [ ] **Step 1.3: Implement new helpers in `errors.ts`**

Modify `src/mcp/tools/errors.ts` — add new exports ABOVE the existing ones, do NOT delete the old ones:

```typescript
import type { ValidationResult, ValidationIssue } from '../../validation/types.js';
import type { ToolIssue } from './title-warnings.js';
import { buildFixable } from '../../validation/fixable.js';

export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'AMBIGUOUS_MATCH'
  | 'INTERNAL_ERROR'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_TYPE'
  | 'EXTRACTOR_UNAVAILABLE'
  | 'AMBIGUOUS_FILENAME'
  | 'CONFLICT'
  | 'BATCH_FAILED';

export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;
}

export type Envelope<T> =
  | { ok: true; data: T; warnings: Issue[] }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

type ToolCallResult = { content: Array<{ type: 'text'; text: string }> };

function wrap(body: unknown): ToolCallResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

export function ok<T>(data: T, warnings: Issue[] = []): ToolCallResult {
  const env: Envelope<T> = { ok: true, data, warnings };
  return wrap(env);
}

export function fail(
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; warnings?: Issue[] },
): ToolCallResult {
  const error = options?.details !== undefined
    ? { code, message, details: options.details }
    : { code, message };
  const env: Envelope<never> = { ok: false, error, warnings: options?.warnings ?? [] };
  return wrap(env);
}

export function adaptIssue(v: ValidationIssue | ToolIssue): Issue {
  if ('severity' in v) {
    const issue: Issue = {
      code: v.code,
      message: v.message,
      severity: v.severity,
      field: v.field,
    };
    if (v.details !== undefined) issue.details = v.details;
    return issue;
  }
  const issue: Issue = { code: v.code, message: v.message, severity: 'warning' };
  if (v.characters !== undefined) issue.details = { characters: v.characters };
  return issue;
}

// ─── Legacy helpers — to be deleted in final task ─────────────────────

export function toolResult(data: unknown): ToolCallResult {
  return wrap(data);
}

export function toolErrorResult(code: ErrorCode, message: string) {
  return toolResult({ error: message, code });
}

export function toolValidationErrorResult(validation: ValidationResult) {
  const fixable = buildFixable(validation.issues, validation.effective_fields);
  return toolResult({
    error: `Validation failed with ${validation.issues.filter(i => i.severity === 'error').length} error(s)`,
    code: 'VALIDATION_FAILED' as ErrorCode,
    issues: validation.issues,
    fixable,
  });
}
```

- [ ] **Step 1.4: Run new tests — confirm they pass**

Run: `npx vitest run tests/mcp/envelope-helpers.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 1.5: Run full build + test suite**

Run: `npm run build && npm test`
Expected: PASS. No existing tests should break — old helpers are unchanged.

- [ ] **Step 1.6: Commit**

```bash
git add src/mcp/tools/errors.ts tests/mcp/envelope-helpers.test.ts
git commit -m "feat(mcp): add envelope helpers (ok, fail, adaptIssue) alongside legacy"
```

---

## Task 2: Migrate simple read-only tools

Tools with no special warning/error changes. All migrations follow the pattern `toolResult(X)` → `ok(X)` and `toolErrorResult(C, m)` → `fail(C, m)`.

**Scope:** `vault-stats`, `list-types`, `list-schemas`, `describe-schema`, `list-global-fields`, `describe-global-field`, `get-node`, `infer-field-type`, `list-field-values`, `validate-node`.

**Note on `validate-node`:** Its `data.issues` stays in `data` but the array elements are mapped through `adaptIssue` for shape consistency with envelope `warnings`. Envelope `warnings` stays empty.

**Files (modify each):**
- `src/mcp/tools/vault-stats.ts`
- `src/mcp/tools/list-types.ts`
- `src/mcp/tools/list-schemas.ts`
- `src/mcp/tools/describe-schema.ts`
- `src/mcp/tools/list-global-fields.ts`
- `src/mcp/tools/describe-global-field.ts`
- `src/mcp/tools/get-node.ts`
- `src/mcp/tools/infer-field-type.ts`
- `src/mcp/tools/list-field-values.ts`
- `src/mcp/tools/validate-node.ts`
- Their test files under `tests/` (grep for each tool name to find)

- [ ] **Step 2.1: Migrate each tool handler**

For each file, change imports:

```typescript
// Before
import { toolResult, toolErrorResult } from './errors.js';

// After
import { ok, fail } from './errors.js';
```

Then change call sites:

```typescript
// Before
return toolResult({ /* data */ });
return toolErrorResult('NOT_FOUND', 'not found');

// After
return ok({ /* data */ });
return fail('NOT_FOUND', 'not found');
```

For `validate-node` specifically, apply `adaptIssue` to the issues array:

```typescript
// Before (src/mcp/tools/validate-node.ts)
return toolResult({
  valid: result.valid,
  effective_fields: result.effective_fields,
  coerced_state: result.coerced_state,
  issues: result.issues,
  orphan_fields: result.orphan_fields,
  types_without_schemas,
});

// After
import { ok, adaptIssue } from './errors.js';
// ...
return ok({
  valid: result.valid,
  effective_fields: result.effective_fields,
  coerced_state: result.coerced_state,
  issues: result.issues.map(adaptIssue),
  orphan_fields: result.orphan_fields,
  types_without_schemas,
});
```

- [ ] **Step 2.2: Update test files**

For each migrated tool, grep tests for its name and update assertions. Pattern:

```typescript
// Before
const body = JSON.parse(result.content[0].text);
expect(body).toEqual({ /* bare shape */ });
expect(body.error).toBe('not found');

// After
const body = JSON.parse(result.content[0].text);
expect(body.ok).toBe(true);
expect(body.data).toEqual({ /* bare shape */ });
expect(body.warnings).toEqual([]);
// Or for errors:
expect(body.ok).toBe(false);
expect(body.error.code).toBe('NOT_FOUND');
expect(body.error.message).toBe('not found');
```

For `validate-node` tests, issues still live in `body.data.issues` but element shape becomes `{code, message, severity, field?, details?}`.

- [ ] **Step 2.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS. Any failures mean a missed migration or test update — fix before continuing.

- [ ] **Step 2.4: Commit**

```bash
git add src/mcp/tools/{vault-stats,list-types,list-schemas,describe-schema,list-global-fields,describe-global-field,get-node,infer-field-type,list-field-values,validate-node}.ts tests/
git commit -m "refactor(mcp): migrate simple read-only tools to envelope"
```

---

## Task 3: Migrate `query-nodes` (notice → CROSS_NODE_FILTER_UNRESOLVED)

**Files:**
- Modify: `src/mcp/tools/query-nodes.ts`
- Modify: tests touching `query-nodes` — grep for `query-nodes` and `notice` under `tests/`

- [ ] **Step 3.1: Update the tool handler**

Find the block in `src/mcp/tools/query-nodes.ts` that emits `notice`. Replace:

```typescript
// Before
if (unresolvedEdges.length > 0) {
  return toolResult({ nodes, total, notice: `Could not resolve cross-node filter edges: ${unresolvedEdges.join(', ')}` });
}
return toolResult({ nodes, total });

// After
import { ok, type Issue } from './errors.js';
// ...
const warnings: Issue[] = [];
if (unresolvedEdges.length > 0) {
  warnings.push({
    code: 'CROSS_NODE_FILTER_UNRESOLVED',
    severity: 'warning',
    message: `Could not resolve cross-node filter edges: ${unresolvedEdges.join(', ')}`,
    details: { edges: unresolvedEdges },
  });
}
return ok({ nodes, total }, warnings);
```

Note the `notice` field is removed entirely from `data`.

- [ ] **Step 3.2: Update tests**

Tests asserting `body.notice` change to asserting `body.warnings`:

```typescript
// Before
expect(body.notice).toContain('Could not resolve');

// After
expect(body.warnings).toEqual(
  expect.arrayContaining([expect.objectContaining({ code: 'CROSS_NODE_FILTER_UNRESOLVED' })])
);
```

Negative assertions (no notice):

```typescript
// Before
expect(body.notice).toBeUndefined();

// After
expect(body.warnings).toEqual([]);
```

- [ ] **Step 3.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 3.4: Commit**

```bash
git add src/mcp/tools/query-nodes.ts tests/
git commit -m "refactor(mcp): migrate query-nodes to envelope; notice -> CROSS_NODE_FILTER_UNRESOLVED"
```

---

## Task 4: Migrate `query-sync-log` (truncated → RESULT_TRUNCATED warning)

**Files:**
- Modify: `src/mcp/tools/query-sync-log.ts`
- Modify: tests under `tests/` touching `query-sync-log`

- [ ] **Step 4.1: Update the tool handler**

```typescript
// Before
return toolResult({ rows, count, truncated });

// After
import { ok, type Issue } from './errors.js';
// ...
const warnings: Issue[] = [];
if (truncated) {
  warnings.push({
    code: 'RESULT_TRUNCATED',
    severity: 'warning',
    message: `Result truncated at limit (${count} rows)`,
    details: { count, limit },
  });
}
return ok({ rows, count, truncated }, warnings);
```

`truncated` stays in `data` per spec §2 (mechanical-client compat).

- [ ] **Step 4.2: Update tests**

```typescript
// Tests asserting truncated=true should additionally check for the warning:
expect(body.data.truncated).toBe(true);
expect(body.warnings).toEqual(
  expect.arrayContaining([expect.objectContaining({ code: 'RESULT_TRUNCATED' })])
);
```

- [ ] **Step 4.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add src/mcp/tools/query-sync-log.ts tests/
git commit -m "refactor(mcp): migrate query-sync-log to envelope; add RESULT_TRUNCATED warning"
```

---

## Task 5: Migrate `read-embedded` (AMBIGUOUS_FILENAME matches → details.matches)

**Files:**
- Modify: `src/mcp/tools/read-embedded.ts`
- Modify: tests under `tests/` touching `read-embedded`

- [ ] **Step 5.1: Update the tool handler**

```typescript
// Before (success)
return toolResult({
  text: result.text,
  media_type: result.mediaType,
  extractor_id: result.extractorId,
  content_hash: result.contentHash,
  metadata: result.metadata,
});

// After
import { ok, fail } from './errors.js';
return ok({
  text: result.text,
  media_type: result.mediaType,
  extractor_id: result.extractorId,
  content_hash: result.contentHash,
  metadata: result.metadata,
});

// Before (ambiguous filename error)
return toolResult({
  error: `Multiple files match "${filename}"`,
  code: 'AMBIGUOUS_FILENAME',
  matches: matches.map(m => m.file_path),
});

// After
return fail('AMBIGUOUS_FILENAME', `Multiple files match "${filename}"`, {
  details: { matches: matches.map(m => m.file_path) },
});

// Before (other errors)
return toolResult({ error: 'File not found in vault: ...', code: 'NOT_FOUND' });

// After
return fail('NOT_FOUND', 'File not found in vault: ...');
```

Apply same `toolResult({error,code}) → fail(code, error)` transform to every error branch in the file.

- [ ] **Step 5.2: Update tests**

```typescript
// Before
expect(body.matches).toEqual(['a.md', 'b.md']);

// After
expect(body.error.details.matches).toEqual(['a.md', 'b.md']);
```

- [ ] **Step 5.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
git add src/mcp/tools/read-embedded.ts tests/
git commit -m "refactor(mcp): migrate read-embedded to envelope; matches -> error.details.matches"
```

---

## Task 6: Migrate schema tools (`create-schema`, `update-schema`, `delete-schema`)

**Files:**
- Modify: `src/mcp/tools/create-schema.ts`
- Modify: `src/mcp/tools/update-schema.ts`
- Modify: `src/mcp/tools/delete-schema.ts`
- Modify: tests under `tests/` touching these three tools

- [ ] **Step 6.1: Update each tool handler**

Mechanical pattern across all three files — no `issues`/`notice`/`warning` fields in these tools today:

```typescript
// Change imports
import { ok, fail } from './errors.js';

// Success responses
return toolResult({ /* data */ });
// becomes
return ok({ /* data */ });

// Error responses
return toolErrorResult('INVALID_PARAMS', 'bad input');
// becomes
return fail('INVALID_PARAMS', 'bad input');
```

Apply to every `toolResult` / `toolErrorResult` call site in each of the three files.

- [ ] **Step 6.2: Update tests**

Assertions updated to the envelope shape per the Task 2 pattern.

- [ ] **Step 6.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6.4: Commit**

```bash
git add src/mcp/tools/create-schema.ts src/mcp/tools/update-schema.ts src/mcp/tools/delete-schema.ts tests/
git commit -m "refactor(mcp): migrate schema tools to envelope"
```

---

## Task 7: Migrate global-field tools (`create-global-field`, `update-global-field`, `rename-global-field`, `delete-global-field`)

**Files:**
- Modify: `src/mcp/tools/create-global-field.ts`
- Modify: `src/mcp/tools/update-global-field.ts`
- Modify: `src/mcp/tools/rename-global-field.ts`
- Modify: `src/mcp/tools/delete-global-field.ts`
- Modify: tests under `tests/` touching these four tools

- [ ] **Step 7.1: Update each tool handler**

Mechanical pattern across all four files — no issues/notice/warning surface in these tools:

```typescript
import { ok, fail } from './errors.js';

// Success
return toolResult({ /* data */ });
// becomes
return ok({ /* data */ });

// Error
return toolErrorResult('INVALID_PARAMS', 'bad input');
// becomes
return fail('INVALID_PARAMS', 'bad input');
```

For `update-global-field` specifically, the type-change preview and confirmation each return `ok(X)` with the current data shape — no changes to the `uncoercible` array or `nodes_rerendered` fields; they stay in `data`.

- [ ] **Step 7.2: Update tests**

Envelope assertions per the Task 2 pattern.

- [ ] **Step 7.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 7.4: Commit**

```bash
git add src/mcp/tools/create-global-field.ts src/mcp/tools/update-global-field.ts src/mcp/tools/rename-global-field.ts src/mcp/tools/delete-global-field.ts tests/
git commit -m "refactor(mcp): migrate global-field tools to envelope"
```

---

## Task 8: Migrate `create-node`

**Files:**
- Modify: `src/mcp/tools/create-node.ts`
- Modify: tests under `tests/` touching `create-node`

- [ ] **Step 8.1: Update the tool handler**

Three major arms to update: dry-run success, non-dry-run success, UNKNOWN_TYPE error, VALIDATION_FAILED error.

```typescript
// Before (dry-run success around line 107)
return toolResult({
  dry_run: true,
  would_create: {
    file_path: filePath,
    title,
    types,
    coerced_state: validation.coerced_state,
    issues: allIssues,
    fixable: buildFixable(validation.issues, validation.effective_fields),
    orphan_fields: validation.orphan_fields,
    ...(conflict ? { conflict } : {}),
  },
});

// After — issues move to envelope warnings; fixable stays in would_create as actionable data
import { ok, fail, adaptIssue } from './errors.js';
return ok(
  {
    dry_run: true,
    would_create: {
      file_path: filePath,
      title,
      types,
      coerced_state: validation.coerced_state,
      fixable: buildFixable(validation.issues, validation.effective_fields),
      orphan_fields: validation.orphan_fields,
      ...(conflict ? { conflict } : {}),
    },
  },
  allIssues.map(adaptIssue),
);

// Before (non-dry-run success around line 141)
return toolResult({
  node_id: result.node_id,
  file_path: result.file_path,
  title,
  types,
  coerced_state: result.validation.coerced_state,
  issues: [...result.validation.issues, ...extraIssues],
  orphan_fields: result.validation.orphan_fields,
});

// After
return ok(
  {
    node_id: result.node_id,
    file_path: result.file_path,
    title,
    types,
    coerced_state: result.validation.coerced_state,
    orphan_fields: result.validation.orphan_fields,
  },
  [...result.validation.issues, ...extraIssues].map(adaptIssue),
);

// Before (UNKNOWN_TYPE error — custom shape)
return toolResult({
  error: `Unknown type(s): ${unknown.join(', ')}`,
  code: 'UNKNOWN_TYPE' as const,
  unknown_types: unknown,
  message: '...suggestion text...',
  available_schemas,
  suggestion: '...',
});

// After
return fail('UNKNOWN_TYPE', `Unknown type(s): ${unknown.join(', ')}`, {
  details: {
    unknown_types: unknown,
    available_schemas,
    suggestion: '...',
  },
});

// Before (VALIDATION_FAILED via toolValidationErrorResult)
return toolValidationErrorResult(err.validation);

// After
return fail(
  'VALIDATION_FAILED',
  `Validation failed with ${err.validation.issues.filter(i => i.severity === 'error').length} error(s)`,
  {
    details: {
      issues: err.validation.issues.map(adaptIssue),
      fixable: buildFixable(err.validation.issues, err.validation.effective_fields),
    },
  },
);
```

Apply the same patterns to every error arm (`INVALID_PARAMS`, `CONFLICT`, `INTERNAL_ERROR`, etc.).

- [ ] **Step 8.2: Update tests**

Assertions move from `body.issues` → `body.warnings`, `body.code` → `body.error.code`, `body.unknown_types` → `body.error.details.unknown_types`, etc. Use the Task 2 envelope pattern.

- [ ] **Step 8.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 8.4: Commit**

```bash
git add src/mcp/tools/create-node.ts tests/
git commit -m "refactor(mcp): migrate create-node to envelope"
```

---

## Task 9: Migrate `update-node` (both single and query modes)

**Files:**
- Modify: `src/mcp/tools/update-node.ts` (689 lines, ~22 call sites)
- Modify: tests under `tests/` touching `update-node` (largest test surface)

- [ ] **Step 9.1: Update the tool handler — single-node mode**

Import: `import { ok, fail, adaptIssue } from './errors.js';`

Patterns for each arm:

```typescript
// Before (single-mode success, no title change)
return toolResult({
  node_id,
  file_path,
  title,
  types,
  coerced_state,
  issues,
  orphan_fields,
});

// After
return ok(
  { node_id, file_path, title, types, coerced_state, orphan_fields },
  issues.map(adaptIssue),
);

// Before (single-mode success, title change)
return toolResult({
  node_id,
  file_path: newPath,
  title: newTitle,
  types,
  references_updated,
  coerced_state,
  issues,
  orphan_fields,
});

// After
return ok(
  { node_id, file_path: newPath, title: newTitle, types, references_updated, coerced_state, orphan_fields },
  issues.map(adaptIssue),
);

// Before (single-mode dry-run)
return toolResult({
  dry_run: true,
  preview: {
    node_id,
    file_path,
    title,
    types,
    coerced_state,
    issues,
    fixable,
    orphan_fields,
  },
});

// After — issues move to envelope warnings, fixable stays inside preview
return ok(
  {
    dry_run: true,
    preview: { node_id, file_path, title, types, coerced_state, fixable, orphan_fields },
  },
  issues.map(adaptIssue),
);

// Before (UNKNOWN_TYPE)
return toolResult({
  error: `Unknown type(s): ${unknown.join(', ')}`,
  code: 'UNKNOWN_TYPE' as const,
  unknown_types: unknown,
  message: '...',
  available_schemas,
  suggestion: '...',
});

// After
return fail('UNKNOWN_TYPE', `Unknown type(s): ${unknown.join(', ')}`, {
  details: { unknown_types: unknown, available_schemas, suggestion: '...' },
});

// Before (VALIDATION_FAILED)
return toolValidationErrorResult(err.validation);

// After
return fail(
  'VALIDATION_FAILED',
  `Validation failed with ${err.validation.issues.filter(i => i.severity === 'error').length} error(s)`,
  {
    details: {
      issues: err.validation.issues.map(adaptIssue),
      fixable: buildFixable(err.validation.issues, err.validation.effective_fields),
    },
  },
);

// Before (CONFLICT, INVALID_PARAMS, INTERNAL_ERROR — any toolErrorResult)
return toolErrorResult('CONFLICT', 'file exists');
// After
return fail('CONFLICT', 'file exists');
```

Type-op conflict issues (`TYPE_OP_CONFLICT`) are `ToolIssue` today — `adaptIssue` handles them by assigning `severity: 'warning'`.

- [ ] **Step 9.2: Update the tool handler — query mode**

Query-mode dry-run and execute responses stay in `data` per spec §3; `notice` hoists to envelope warning:

```typescript
// Before (query-mode dry-run success)
return toolResult({
  dry_run: true,
  batch_id,
  matched,
  would_update,
  would_skip,
  would_fail,
  preview: [...],
  ...(unresolvedEdges.length > 0 ? { notice: '...' } : {}),
});

// After
const warnings: Issue[] = [];
if (unresolvedEdges.length > 0) {
  warnings.push({
    code: 'CROSS_NODE_FILTER_UNRESOLVED',
    severity: 'warning',
    message: `Could not resolve cross-node filter edges: ${unresolvedEdges.join(', ')}`,
    details: { edges: unresolvedEdges },
  });
}
return ok(
  { dry_run: true, batch_id, matched, would_update, would_skip, would_fail, preview: [...] },
  warnings,
);

// Execute arm: per-node errors stay in data.errors (attribution matters per spec §2):
return ok({
  dry_run: false,
  batch_id,
  matched,
  updated,
  skipped,
  errors, // array of {node_id, file_path, error} — NOT moved
});
```

- [ ] **Step 9.3: Update tests**

This is the largest test-update surface in the plan. Assertions migrate via the Task 2 pattern. Pay particular attention to:
- Dry-run tests asserting `body.would_create.issues` or `body.preview.issues` — issues now live in `body.warnings`.
- Query-mode tests asserting `body.notice` — now in `body.warnings`.
- Query-mode tests asserting `body.errors` — stay at `body.data.errors`.

- [ ] **Step 9.4: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS. If update-node is still failing after your edits, break the failures into sub-commits (single mode first, then query mode).

- [ ] **Step 9.5: Commit**

```bash
git add src/mcp/tools/update-node.ts tests/
git commit -m "refactor(mcp): migrate update-node (single + query modes) to envelope"
```

---

## Task 10: Migrate `delete-node` (with PENDING_REFERENCES warning)

**Files:**
- Modify: `src/mcp/tools/delete-node.ts`
- Modify: tests under `tests/` touching `delete-node`

- [ ] **Step 10.1: Update the tool handler**

```typescript
// Before (confirm:false preview — around line 55-68)
return toolResult({
  preview: true,
  node_id: node.id,
  file_path: node.file_path,
  title: node.title,
  types,
  field_count,
  relationship_count,
  incoming_reference_count,
  referencing_nodes,
  warning: incoming_reference_count > 0
    ? `${incoming_reference_count} other node(s) reference this node. Deletion will leave dangling references.`
    : null,
});

// After
import { ok, fail, type Issue } from './errors.js';
const warnings: Issue[] = [];
if (incoming_reference_count > 0) {
  warnings.push({
    code: 'PENDING_REFERENCES',
    severity: 'warning',
    message: `${incoming_reference_count} other node(s) reference this node. Deletion will leave dangling references.`,
    details: { incoming_reference_count, referencing_nodes },
  });
}
return ok(
  {
    preview: true,
    node_id: node.id,
    file_path: node.file_path,
    title: node.title,
    types,
    field_count,
    relationship_count,
    incoming_reference_count,
    referencing_nodes,
  },
  warnings,
);

// Before (confirm:true success)
return toolResult({
  deleted: true,
  node_id,
  file_path,
  dangling_references,
});

// After
return ok({ deleted: true, node_id, file_path, dangling_references });
```

Convert every `toolErrorResult` in the file to `fail`.

- [ ] **Step 10.2: Update tests**

```typescript
// Before
expect(body.warning).toContain('2 other node(s) reference');

// After
expect(body.warnings).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ code: 'PENDING_REFERENCES' }),
  ]),
);
```

Note: `body.warnings` is the envelope warnings array; the old `body.warning` string field is gone from `data`.

- [ ] **Step 10.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 10.4: Commit**

```bash
git add src/mcp/tools/delete-node.ts tests/
git commit -m "refactor(mcp): migrate delete-node to envelope; warning -> PENDING_REFERENCES"
```

---

## Task 11: Migrate `rename-node`

**Files:**
- Modify: `src/mcp/tools/rename-node.ts`
- Modify: tests under `tests/` touching `rename-node`

- [ ] **Step 11.1: Update the tool handler**

```typescript
// Before (success)
return toolResult({
  node_id,
  old_file_path,
  new_file_path,
  old_title,
  new_title,
  references_updated,
  issues, // ToolIssue[] from title safety
});

// After
import { ok, fail, adaptIssue } from './errors.js';
return ok(
  { node_id, old_file_path, new_file_path, old_title, new_title, references_updated },
  issues.map(adaptIssue),
);
```

Convert every `toolErrorResult` to `fail`.

- [ ] **Step 11.2: Update tests**

Envelope assertions per the Task 2 pattern.

- [ ] **Step 11.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add src/mcp/tools/rename-node.ts tests/
git commit -m "refactor(mcp): migrate rename-node to envelope"
```

---

## Task 12: Migrate `add-type-to-node`

**Files:**
- Modify: `src/mcp/tools/add-type-to-node.ts`
- Modify: tests under `tests/` touching `add-type-to-node`

- [ ] **Step 12.1: Update the tool handler**

Three arms: type-already-present success (with empty issues), type-added success (with issues from validation + readopt), UNKNOWN_TYPE error, VALIDATION_FAILED error.

```typescript
// Before (success)
return toolResult({
  node_id,
  file_path,
  types,
  added_fields,
  readopted_fields,
  issues,
  already_present: false,
});

// After
return ok(
  { node_id, file_path, types, added_fields, readopted_fields, already_present: false },
  issues.map(adaptIssue),
);

// Before (UNKNOWN_TYPE)
return toolResult({
  error: `Unknown type(s): ${unknown.join(', ')}`,
  code: 'UNKNOWN_TYPE' as const,
  unknown_types: unknown,
  message: '...suggestion text...',
  available_schemas,
  suggestion: '...',
});

// After
return fail('UNKNOWN_TYPE', `Unknown type(s): ${unknown.join(', ')}`, {
  details: { unknown_types: unknown, available_schemas, suggestion: '...' },
});

// Before (VALIDATION_FAILED)
return toolValidationErrorResult(err.validation);

// After
return fail(
  'VALIDATION_FAILED',
  `Validation failed with ${err.validation.issues.filter(i => i.severity === 'error').length} error(s)`,
  {
    details: {
      issues: err.validation.issues.map(adaptIssue),
      fixable: buildFixable(err.validation.issues, err.validation.effective_fields),
    },
  },
);
```

- [ ] **Step 12.2: Update tests**

Envelope assertions per the Task 2 pattern.

- [ ] **Step 12.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 12.4: Commit**

```bash
git add src/mcp/tools/add-type-to-node.ts tests/
git commit -m "refactor(mcp): migrate add-type-to-node to envelope"
```

---

## Task 13: Migrate `remove-type-from-node` (with LAST_TYPE_REMOVAL warning)

**Files:**
- Modify: `src/mcp/tools/remove-type-from-node.ts`
- Modify: tests under `tests/` touching `remove-type-from-node`

- [ ] **Step 13.1: Update the tool handler**

```typescript
// Before (preview of last-type removal, confirm:false)
return toolResult({
  preview: true,
  node_id,
  file_path,
  current_types,
  removing_type,
  resulting_types: [],
  would_orphan_fields,
  warning: 'Removing this type leaves the node with no types. All fields will become orphans.',
});

// After
import { ok, fail, type Issue } from './errors.js';
const warnings: Issue[] = [
  {
    code: 'LAST_TYPE_REMOVAL',
    severity: 'warning',
    message: 'Removing this type leaves the node with no types. All fields will become orphans.',
    details: { would_orphan_fields },
  },
];
return ok(
  {
    preview: true,
    node_id,
    file_path,
    current_types,
    removing_type,
    resulting_types: [],
    would_orphan_fields,
  },
  warnings,
);

// Before (confirmed removal success)
return toolResult({
  node_id,
  file_path,
  types,
  orphaned_fields,
  edits_logged,
});

// After
return ok({ node_id, file_path, types, orphaned_fields, edits_logged });
```

Convert every `toolErrorResult` to `fail`.

- [ ] **Step 13.2: Update tests**

```typescript
// Before
expect(body.warning).toMatch(/All fields will become orphans/);

// After
expect(body.warnings).toEqual(
  expect.arrayContaining([expect.objectContaining({ code: 'LAST_TYPE_REMOVAL' })]),
);
```

- [ ] **Step 13.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 13.4: Commit**

```bash
git add src/mcp/tools/remove-type-from-node.ts tests/
git commit -m "refactor(mcp): migrate remove-type-from-node; warning -> LAST_TYPE_REMOVAL"
```

---

## Task 14: Migrate `batch-mutate` (with BATCH_FAILED)

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts`
- Modify: tests under `tests/` touching `batch-mutate`

- [ ] **Step 14.1: Update the tool handler**

```typescript
// Before (success)
return toolResult({ applied: true, results });

// After
import { ok, fail, adaptIssue } from './errors.js';
return ok({ applied: true, results });

// Before (failure — current shape)
return toolResult({
  applied: false,
  failed_at: idx,
  error: {
    op: opType,
    message: err.message,
    ...(err.validation ? { issues: err.validation.issues, fixable: buildFixable(...) } : {}),
  },
  ...(rollbackFailures.length > 0 ? { rollback_failures: rollbackFailures } : {}),
});

// After (new BATCH_FAILED code + flattened details)
const details: Record<string, unknown> = {
  failed_at: idx,
  op: opType,
};
if (err.validation) {
  details.issues = err.validation.issues.map(adaptIssue);
  details.fixable = buildFixable(err.validation.issues, err.validation.effective_fields);
}
if (rollbackFailures.length > 0) {
  details.rollback_failures = rollbackFailures;
}
return fail('BATCH_FAILED', err.message, { details });
```

Convert any other `toolErrorResult`/`toolResult` error shape in the file to `fail`.

- [ ] **Step 14.2: Update tests**

```typescript
// Before
expect(body.applied).toBe(false);
expect(body.failed_at).toBe(2);
expect(body.error.op).toBe('create');

// After
expect(body.ok).toBe(false);
expect(body.error.code).toBe('BATCH_FAILED');
expect(body.error.details.failed_at).toBe(2);
expect(body.error.details.op).toBe('create');
```

- [ ] **Step 14.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 14.4: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts tests/
git commit -m "refactor(mcp): migrate batch-mutate to envelope; new BATCH_FAILED code"
```

---

## Task 15: Add envelope-invariant property tests

**Files:**
- Create: `tests/mcp/envelope.test.ts`

- [ ] **Step 15.1: Write the envelope invariant test file**

Create `tests/mcp/envelope.test.ts`. Follows the existing `tests/mcp/tools.test.ts` handler-capture pattern (no reliance on SDK internals):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerListTypes } from '../../src/mcp/tools/list-types.js';
import { registerListSchemas } from '../../src/mcp/tools/list-schemas.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity: 'error' | 'warning' }>;
}

function parse(result: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(result.content[0].text) as Envelope;
}

function captureHandler(registerFn: (server: McpServer, ...args: unknown[]) => void, ...extras: unknown[]) {
  let captured: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      captured = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, ...extras);
  return captured!;
}

function assertEnvelope(env: Envelope): void {
  expect(env).toHaveProperty('ok');
  expect(typeof env.ok).toBe('boolean');
  expect(Array.isArray(env.warnings)).toBe(true);
  if (env.ok) {
    expect(env).toHaveProperty('data');
    expect(env).not.toHaveProperty('error');
  } else {
    expect(env).toHaveProperty('error');
    expect(env).not.toHaveProperty('data');
    expect(typeof env.error?.code).toBe('string');
    expect(typeof env.error?.message).toBe('string');
  }
  for (const w of env.warnings) {
    expect(typeof w.code).toBe('string');
    expect(typeof w.message).toBe('string');
    expect(['error', 'warning']).toContain(w.severity);
  }
}

describe('envelope invariant', () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'envelope-test-'));
    db = createTestDb();
  });

  it('list-types returns a valid success envelope', async () => {
    const handler = captureHandler(registerListTypes, db);
    const env = parse(await handler({}) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(true);
  });

  it('list-schemas returns a valid success envelope', async () => {
    const handler = captureHandler(registerListSchemas, db);
    const env = parse(await handler({}) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(true);
  });

  it('get-node returns a valid failure envelope on missing node', async () => {
    const handler = captureHandler(registerGetNode, db);
    const env = parse(await handler({ node_id: 'does-not-exist' }) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('NOT_FOUND');
  });

  it('create-node returns a valid failure envelope with UNKNOWN_TYPE details', async () => {
    const writeLock = new WriteLockManager();
    const handler = captureHandler(registerCreateNode, db, writeLock, tmp);
    const env = parse(await handler({ title: 'x', types: ['NoSuchType'] }) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_TYPE');
    expect(env.error?.details).toHaveProperty('unknown_types');
    expect(env.error?.details).toHaveProperty('available_schemas');
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

The test covers the three envelope arms: success (`list-types`, `list-schemas`), structured failure (`get-node` NOT_FOUND), and failure-with-details (`create-node` UNKNOWN_TYPE). The invariant helper `assertEnvelope` is the reusable shape check.

- [ ] **Step 15.2: Run the new tests**

Run: `npx vitest run tests/mcp/envelope.test.ts`
Expected: PASS.

- [ ] **Step 15.3: Run full build + tests**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 15.4: Commit**

```bash
git add tests/mcp/envelope.test.ts
git commit -m "test(mcp): add envelope invariant property tests"
```

---

## Task 16: Delete legacy helpers from `errors.ts`

All tools migrated; legacy helpers are no longer referenced.

**Files:**
- Modify: `src/mcp/tools/errors.ts`

- [ ] **Step 16.1: Verify no remaining references**

Run: `Grep for pattern "toolResult|toolErrorResult|toolValidationErrorResult" in src/`
Expected: matches only inside `src/mcp/tools/errors.ts` itself (the definitions).

If any other file still references them, migrate that file first — do not proceed with deletion.

- [ ] **Step 16.2: Delete the legacy helpers**

Remove the three exported legacy functions from `src/mcp/tools/errors.ts`:
- `toolResult(data)`
- `toolErrorResult(code, message)`
- `toolValidationErrorResult(validation)`

Also remove the `buildFixable` import if it's no longer used (migration moved each usage into the per-tool handler).

- [ ] **Step 16.3: Run build + tests**

Run: `npm run build && npm test`
Expected: PASS. TypeScript will flag any missed consumer.

- [ ] **Step 16.4: Commit**

```bash
git add src/mcp/tools/errors.ts
git commit -m "refactor(mcp): remove legacy toolResult/toolErrorResult/toolValidationErrorResult"
```

---

## Task 17: Manual claude.ai connector sanity check

Not a code change — manual verification before merging the PR.

- [ ] **Step 17.1: Start the server with the new build**

```bash
npm run build
npm run start:http
```

- [ ] **Step 17.2: Exercise the tool surface via claude.ai connector**

Connect the running server to the claude.ai connector and run, from a chat:

1. A read tool — e.g. `list-types` or `vault-stats`. Confirm the LLM can read the envelope and format a useful answer.
2. A simple mutation — e.g. `create-node` with a valid schema type.
3. A bulk mutation — e.g. `batch-mutate` with one create + one update.
4. An intentional error — e.g. `create-node` with an unknown type. Confirm the LLM reads `error.details.available_schemas` and proposes a correction.
5. A tool that emits a warning — e.g. `delete-node` with `confirm: false` on a node with incoming references. Confirm the LLM surfaces the `PENDING_REFERENCES` warning.

- [ ] **Step 17.3: Document any connector issues**

If the LLM misinterprets any envelope, capture the response verbatim and decide: fix in this PR (if a clear bug) or file as follow-up (if connector-side adaptation lag).

- [ ] **Step 17.4: Merge to `main`**

Assuming all checks pass and the sanity check is clean:

```bash
git checkout main
git merge --no-ff <feature-branch>
git push
```

---

## Completion criteria

- All 27 tool files use `ok` / `fail` exclusively; no calls to the legacy helpers remain.
- `npm run build` passes with no TypeScript errors.
- `npm test` passes across all existing test files and the new `tests/mcp/envelope-helpers.test.ts` + `tests/mcp/envelope.test.ts`.
- Legacy helpers (`toolResult`, `toolErrorResult`, `toolValidationErrorResult`) are deleted from `errors.ts`.
- Manual claude.ai connector check exercises at least five distinct envelope shapes (success, success-with-warnings, simple failure, structured failure with `details`, bulk failure).
- No DB migration. No `search_version` bump.
