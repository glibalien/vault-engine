# Date Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `$ctime`, `$mtime`, and `$now` tokens in global field `default_value`, resolved at write time from file metadata.

**Architecture:** New `resolve-default.ts` module handles token parsing and date formatting. `validateProposedState` gains a `FileContext` parameter and resolves tokens when applying defaults. The required+default interaction is fixed so required fields with defaults populate instead of erroring. The normalizer gains a backfill step that discovers missing fields with defaults and includes them in its mutation.

**Tech Stack:** TypeScript, Node.js `fs.statSync`, vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/validation/resolve-default.ts` | Create | Token parsing, date formatting, `resolveDefaultValue()` |
| `src/validation/validate.ts` | Modify | Accept `FileContext`, resolve tokens in defaults, fix required+default |
| `src/pipeline/populate-defaults.ts` | Modify | Accept `FileContext`, resolve tokens when populating |
| `src/pipeline/execute.ts` | Modify | Stat file for `FileContext`, thread into validation |
| `src/pipeline/types.ts` | Modify | Re-export `FileContext` type |
| `src/sync/normalizer.ts` | Modify | Backfill missing fields with defaults before mutation |
| `tests/validation/resolve-default.test.ts` | Create | Unit tests for token resolution |
| `tests/validation/validate.test.ts` | Modify | Tests for required+default fix and token resolution |
| `tests/sync/normalizer.test.ts` | Modify | Tests for normalizer backfill |

---

### Task 1: `resolveDefaultValue` — Token Parser and Date Formatter

**Files:**
- Create: `src/validation/resolve-default.ts`
- Create: `tests/validation/resolve-default.test.ts`

- [ ] **Step 1: Write failing tests for token parsing and formatting**

```typescript
// tests/validation/resolve-default.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDefaultValue, type FileContext } from '../../src/validation/resolve-default.js';

// Use local time (no Z suffix) — formatDate uses getHours() etc. which return local time
const ctx: FileContext = {
  birthtimeMs: new Date('2024-03-15T10:30:00').getTime(),
  mtimeMs: new Date('2025-01-20T14:45:00').getTime(),
};

describe('resolveDefaultValue', () => {
  // ── Non-token passthrough ──────────────────────────────────────────
  it('returns non-string values unchanged', () => {
    expect(resolveDefaultValue(42, ctx)).toBe(42);
    expect(resolveDefaultValue(null, ctx)).toBe(null);
    expect(resolveDefaultValue(true, ctx)).toBe(true);
    expect(resolveDefaultValue(['a'], ctx)).toEqual(['a']);
  });

  it('returns non-token strings unchanged', () => {
    expect(resolveDefaultValue('open', ctx)).toBe('open');
    expect(resolveDefaultValue('$unknown', ctx)).toBe('$unknown');
    expect(resolveDefaultValue('ctime:YYYY', ctx)).toBe('ctime:YYYY');
  });

  // ── $ctime ─────────────────────────────────────────────────────────
  it('$ctime with default format', () => {
    expect(resolveDefaultValue('$ctime', ctx)).toBe('2024-03-15');
  });

  it('$ctime with explicit format', () => {
    expect(resolveDefaultValue('$ctime:YYYY-MM-DD', ctx)).toBe('2024-03-15');
  });

  it('$ctime with time format', () => {
    expect(resolveDefaultValue('$ctime:YYYY-MM-DDTHH:mm', ctx)).toBe('2024-03-15T10:30');
  });

  it('$ctime with MM/DD/YYYY format', () => {
    expect(resolveDefaultValue('$ctime:MM/DD/YYYY', ctx)).toBe('03/15/2024');
  });

  // ── $mtime ─────────────────────────────────────────────────────────
  it('$mtime with default format', () => {
    expect(resolveDefaultValue('$mtime', ctx)).toBe('2025-01-20');
  });

  it('$mtime with explicit format', () => {
    expect(resolveDefaultValue('$mtime:YYYY-MM-DDTHH:mm:ss', ctx)).toBe('2025-01-20T14:45:00');
  });

  // ── $now ───────────────────────────────────────────────────────────
  it('$now resolves to current date', () => {
    const result = resolveDefaultValue('$now', null) as string;
    // Should be today's date in YYYY-MM-DD
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(result).toBe(expected);
  });

  it('$now ignores fileCtx and uses Date.now()', () => {
    const result = resolveDefaultValue('$now', ctx) as string;
    // Should NOT be 2024-03-15 (ctime) or 2025-01-20 (mtime)
    expect(result).not.toBe('2024-03-15');
    expect(result).not.toBe('2025-01-20');
  });

  // ── Null FileContext fallback ──────────────────────────────────────
  it('$ctime with null fileCtx falls back to $now', () => {
    const withCtx = resolveDefaultValue('$now', null);
    const withoutCtx = resolveDefaultValue('$ctime', null);
    expect(withoutCtx).toBe(withCtx);
  });

  it('$mtime with null fileCtx falls back to $now', () => {
    const withCtx = resolveDefaultValue('$now', null);
    const withoutCtx = resolveDefaultValue('$mtime', null);
    expect(withoutCtx).toBe(withCtx);
  });

  // ── Format tokens ─────────────────────────────────────────────────
  it('format with seconds', () => {
    expect(resolveDefaultValue('$ctime:HH:mm:ss', ctx)).toBe('10:30:00');
  });

  it('format with only year', () => {
    expect(resolveDefaultValue('$ctime:YYYY', ctx)).toBe('2024');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/validation/resolve-default.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement resolveDefaultValue**

```typescript
// src/validation/resolve-default.ts

export interface FileContext {
  birthtimeMs: number;
  mtimeMs: number;
}

const TOKEN_RE = /^\$(ctime|mtime|now)(?::(.+))?$/;
const DEFAULT_FORMAT = 'YYYY-MM-DD';

/**
 * If `defaultValue` is a date token ($ctime, $mtime, $now), resolve it
 * to a formatted date string. Otherwise return unchanged.
 */
export function resolveDefaultValue(
  defaultValue: unknown,
  fileCtx: FileContext | null,
): unknown {
  if (typeof defaultValue !== 'string') return defaultValue;

  const match = defaultValue.match(TOKEN_RE);
  if (!match) return defaultValue;

  const [, token, formatStr] = match;
  const format = formatStr || DEFAULT_FORMAT;

  let timestampMs: number;
  switch (token) {
    case 'ctime':
      timestampMs = fileCtx?.birthtimeMs ?? Date.now();
      break;
    case 'mtime':
      timestampMs = fileCtx?.mtimeMs ?? Date.now();
      break;
    case 'now':
      timestampMs = Date.now();
      break;
    default:
      return defaultValue;
  }

  return formatDate(new Date(timestampMs), format);
}

function formatDate(date: Date, format: string): string {
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  };

  let result = format;
  // Replace longest tokens first to avoid partial matches
  for (const [token, value] of Object.entries(tokens)) {
    result = result.replaceAll(token, value);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/validation/resolve-default.test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/validation/resolve-default.ts tests/validation/resolve-default.test.ts
git commit -m "feat: add resolveDefaultValue for date token parsing"
```

---

### Task 2: Fix Required + Default Interaction in `validateProposedState`

**Files:**
- Modify: `src/validation/validate.ts:1-12,17-22,70-89`
- Modify: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write failing tests for required + default behavior**

Add to `tests/validation/validate.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify the first new test fails**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: "required + default — missing field populated" FAILS (currently errors with REQUIRED_MISSING)

- [ ] **Step 3: Fix required + default logic in validate.ts**

In `src/validation/validate.ts`, replace lines 70-89:

```typescript
    if (!provided) {
      if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" is missing`,
        });
        continue;
      }

      if (ef.resolved_default_value !== null) {
        coerced_state[fieldName] = {
          field: fieldName,
          value: ef.resolved_default_value,
          source: 'defaulted',
          changed: false,
        };
      }
      continue;
    }
```

With:

```typescript
    if (!provided) {
      if (ef.resolved_default_value !== null) {
        coerced_state[fieldName] = {
          field: fieldName,
          value: ef.resolved_default_value,
          source: 'defaulted',
          changed: false,
        };
      } else if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" is missing`,
        });
      }
      continue;
    }
```

Logic: check for default first; only error if both required AND no default.

- [ ] **Step 4: Update the existing "REQUIRED_MISSING" test expectation**

The existing test at line 61 ("REQUIRED_MISSING — required field not provided") still passes because that field has no default. The test at line 124 ("null on required field — raises REQUIRED_MISSING") also still passes because explicit `null` is deletion intent and handled in the earlier `value === null` block (lines 56-68), not the `!provided` block.

Verify no existing tests broke.

- [ ] **Step 5: Run all validation tests**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: all pass (old and new)

- [ ] **Step 6: Commit**

```bash
git add src/validation/validate.ts tests/validation/validate.test.ts
git commit -m "fix: required fields with defaults populate instead of erroring"
```

---

### Task 3: Wire Date Token Resolution into `validateProposedState`

**Files:**
- Modify: `src/validation/validate.ts:1-12,17-22,70-89`
- Modify: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write failing tests for token resolution in validation**

Add to `tests/validation/validate.test.ts`, updating the import at top to include `FileContext`:

```typescript
import type { FileContext } from '../../src/validation/resolve-default.js';
```

Then add tests:

```typescript
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
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: new token tests FAIL — `validateProposedState` doesn't accept 5th arg yet

- [ ] **Step 3: Add FileContext parameter and token resolution to validate.ts**

In `src/validation/validate.ts`:

Add import at top:

```typescript
import { resolveDefaultValue, type FileContext } from './resolve-default.js';
```

Update function signature (line 17-22):

```typescript
export function validateProposedState(
  proposedFields: Record<string, unknown>,
  types: string[],
  claimsByType: Map<string, FieldClaim[]>,
  globalFields: Map<string, GlobalFieldDefinition>,
  fileCtx?: FileContext | null,
): ValidationResult {
```

Update the default-application block (the one from Task 2) — wrap the default value through `resolveDefaultValue`:

```typescript
    if (!provided) {
      if (ef.resolved_default_value !== null) {
        const resolved = resolveDefaultValue(ef.resolved_default_value, fileCtx ?? null);
        coerced_state[fieldName] = {
          field: fieldName,
          value: resolved,
          source: 'defaulted',
          changed: false,
        };
      } else if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" is missing`,
        });
      }
      continue;
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/validation/validate.ts tests/validation/validate.test.ts
git commit -m "feat: wire date token resolution into validateProposedState"
```

---

### Task 4: Wire `FileContext` into Pipeline and `populateDefaults`

**Files:**
- Modify: `src/pipeline/execute.ts:1-7,42-56`
- Modify: `src/pipeline/populate-defaults.ts:1-9,22-26,41-42`
- Modify: `src/pipeline/types.ts`

- [ ] **Step 1: Re-export FileContext from pipeline types**

In `src/pipeline/types.ts`, add at top:

```typescript
export type { FileContext } from '../validation/resolve-default.js';
```

- [ ] **Step 2: Update populateDefaults to accept and use FileContext**

In `src/pipeline/populate-defaults.ts`:

Add import:

```typescript
import { resolveDefaultValue, type FileContext } from '../validation/resolve-default.js';
```

Update function signature (line 22-26):

```typescript
export function populateDefaults(
  db: Database.Database,
  types: string[],
  currentFields: Record<string, unknown>,
  fileCtx?: FileContext | null,
): { defaults: Record<string, unknown>; populated: PopulatedDefault[] } {
```

Update line 42 where the default value is assigned:

```typescript
    if (ef.resolved_default_value !== null) {
      const resolved = resolveDefaultValue(ef.resolved_default_value, fileCtx ?? null);
      defaults[fieldName] = resolved;
```

And update the `populated.push` on line 56 to use the resolved value:

```typescript
      populated.push({ field: fieldName, default_value: resolved, default_source: source });
```

- [ ] **Step 3: Update executeMutation to stat the file and thread FileContext**

In `src/pipeline/execute.ts`:

Add imports:

```typescript
import { statSync } from 'node:fs';
import type { FileContext } from '../validation/resolve-default.js';
```

After line 42 (`const absPath = ...`), before the transaction, stat the file:

```typescript
  // Stat file for date token resolution (ctime/mtime defaults)
  let fileCtx: FileContext | null = null;
  try {
    const st = statSync(absPath);
    fileCtx = { birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs };
  } catch {
    // File doesn't exist yet (create-node) — tokens fall back to $now
  }
```

Update the `validateProposedState` call (line 51-56) to pass `fileCtx`:

```typescript
    const validation = validateProposedState(
      mutation.fields,
      mutation.types,
      claimsByType,
      globalFields,
      fileCtx,
    );
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: all pass — existing tests should not break since `fileCtx` is optional

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/populate-defaults.ts src/pipeline/execute.ts
git commit -m "feat: thread FileContext into pipeline for date token resolution"
```

---

### Task 5: Normalizer Backfill — Populate Missing Defaults

**Files:**
- Modify: `src/sync/normalizer.ts:1-21,92-166`
- Modify: `tests/sync/normalizer.test.ts`

- [ ] **Step 1: Write failing test for normalizer backfill**

Add to `tests/sync/normalizer.test.ts`, after the existing imports:

```typescript
import { runNormalizerSweep } from '../../src/sync/normalizer.js';
```

Then add a new `describe` block:

```typescript
describe('normalizer backfill of missing defaults', () => {
  it('populates missing field with static default on normalize sweep', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    createSchemaDefinition(db, { name: 'task', field_claims: [
      { field: 'status', sort_order: 100 },
    ] });

    // Create node WITHOUT status field (simulates pre-existing node)
    const nodeId = createNodeViaToolPath('backfill.md', {
      title: 'Backfill Test',
      types: ['task'],
      fields: {},
    });

    // Remove the status field from DB (simulates it never having been set —
    // the tool path would have defaulted it, so we strip it to simulate a
    // node created before the default was configured)
    db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?').run(nodeId, 'status');
    // Invalidate content hash so normalizer sees it as stale
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run('stale', nodeId);

    makeFileOld('backfill.md', 2 * 60 * 60 * 1000);

    const stats = runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
      skipQuiescence: true,
    });

    expect(stats.rewritten).toBeGreaterThanOrEqual(1);

    // Verify the field was populated in DB
    const row = db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'status') as { value_text: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value_text).toBe('open');
  });

  it('populates missing field with $ctime token using file birthtime', () => {
    createGlobalField(db, { name: 'date', field_type: 'reference', reference_target: 'daily-note', default_value: '$ctime:YYYY-MM-DD' });
    createSchemaDefinition(db, { name: 'note', field_claims: [
      { field: 'date', sort_order: 100 },
    ] });

    const nodeId = createNodeViaToolPath('ctime-backfill.md', {
      title: 'Ctime Backfill',
      types: ['note'],
      fields: {},
    });

    // Strip the date field and invalidate hash
    db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?').run(nodeId, 'date');
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run('stale', nodeId);

    makeFileOld('ctime-backfill.md', 2 * 60 * 60 * 1000);

    const stats = runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
      skipQuiescence: true,
    });

    expect(stats.rewritten).toBeGreaterThanOrEqual(1);

    // Verify the date field was populated (value will be the file's birthtime)
    const row = db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'date') as { value_text: string } | undefined;
    expect(row).toBeDefined();
    // Should be a YYYY-MM-DD formatted date string
    expect(row!.value_text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not overwrite existing field values during backfill', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    createSchemaDefinition(db, { name: 'task', field_claims: [
      { field: 'status', sort_order: 100 },
    ] });

    const nodeId = createNodeViaToolPath('no-overwrite.md', {
      title: 'No Overwrite',
      types: ['task'],
      fields: { status: 'closed' },
    });

    // Invalidate hash so normalizer processes it
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run('stale', nodeId);
    makeFileOld('no-overwrite.md', 2 * 60 * 60 * 1000);

    runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
      skipQuiescence: true,
    });

    const row = db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'status') as { value_text: string };
    expect(row.value_text).toBe('closed');
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run tests/sync/normalizer.test.ts`
Expected: backfill tests FAIL — normalizer doesn't populate missing defaults yet

- [ ] **Step 3: Add backfill logic to normalizer**

In `src/sync/normalizer.ts`:

Add imports:

```typescript
import { resolveDefaultValue, type FileContext } from '../validation/resolve-default.js';
```

In `runNormalizerSweep`, modify the section that loads node fields and calls `executeMutation` (around lines 130-166). After building the `fields` object from DB rows and before the `executeMutation` call, add the backfill step:

```typescript
      // ── Backfill missing defaults ──────────────────────────────────
      // Check effective fields for any that are missing from the node
      // and have a default value. Resolve tokens and add to fields.
      const ctx = loadSchemaContext(db, types);
      const mergeResult = mergeFieldClaims(types, ctx.claimsByType, ctx.globalFields);
      const effFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

      let fileCtx: FileContext | null = null;
      try {
        const fileStat = statSync(absPath);
        fileCtx = { birthtimeMs: fileStat.birthtimeMs, mtimeMs: fileStat.mtimeMs };
      } catch {
        // Already checked file exists above, but guard anyway
      }

      for (const [fieldName, ef] of effFields) {
        if (fieldName in fields && fields[fieldName] !== undefined && fields[fieldName] !== null) continue;
        if (ef.resolved_default_value === null) continue;
        fields[fieldName] = resolveDefaultValue(ef.resolved_default_value, fileCtx);
      }
```

This goes between the field-reconstruction loop (lines 150-155) and the `executeMutation` call (line 157). The normalizer already has `loadSchemaContext` and `mergeFieldClaims` imported.

Note: `statSync` is already imported at the top of the file. The `absPath` variable is already available from line 94.

- [ ] **Step 4: Run normalizer tests**

Run: `npx vitest run tests/sync/normalizer.test.ts`
Expected: all pass

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/sync/normalizer.ts tests/sync/normalizer.test.ts
git commit -m "feat: normalizer backfills missing fields with resolved defaults"
```

---

### Task 6: End-to-End Verification

**Files:**
- No new files — uses existing test infrastructure

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: no TypeScript errors

- [ ] **Step 3: Commit (if any fixups needed)**

Only if Tasks 1-5 required corrections. Otherwise this is a verification-only step.
