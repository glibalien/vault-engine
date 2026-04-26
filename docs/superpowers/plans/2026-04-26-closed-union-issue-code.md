# Closed-union `Issue.code` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow `Issue.code` from `string` to a closed `IssueCode` union so the TypeScript compiler enforces canonical warning code names at every Issue construction site.

**Architecture:** Three-tier composition: `ValidationIssueCode` (renamed from existing `IssueCode` in `src/validation/types.ts`) ∪ `ToolIssueCode` (new, in `src/mcp/tools/title-warnings.ts`) ∪ tool-only-warning codes (in `src/mcp/tools/errors.ts`). The composed `IssueCode` lives in `errors.ts` and becomes the type of `Issue.code`. Wire format is invariant — only the TypeScript type narrows.

**Tech Stack:** TypeScript 5.x (strict mode), Vitest, Node.js ESM. No runtime dependencies introduced.

**Spec:** `docs/superpowers/specs/2026-04-26-closed-union-issue-code-design.md` (commit `3ece62e`).

---

## Pre-flight (re-grep before starting)

The code enumeration below was captured on 2026-04-26. If implementation begins much later, re-run these greps and reconcile any new additions into the union before completing Task 3:

```bash
grep -rn "code:\s*'[A-Z_]\+'" src/ | grep -v "\.d\.ts"
grep -rn "code:\s*string" src/ | grep -v "\.d\.ts"
```

Sites currently in scope (relevant rows from those greps):

| Code | Site(s) |
|------|---------|
| `REQUIRED_MISSING`, `ENUM_MISMATCH`, `TYPE_MISMATCH`, `COERCION_FAILED`, `LIST_ITEM_COERCION_FAILED`, `MERGE_CONFLICT`, `INTERNAL_CONSISTENCY` | `src/validation/types.ts:97-104` (existing closed union) — emitted in `src/validation/validate.ts:63,85,135,167-173` |
| `TITLE_WIKILINK_UNSAFE` | `src/mcp/tools/title-warnings.ts:13` |
| `FRONTMATTER_IN_BODY` | `src/mcp/tools/title-warnings.ts:42` |
| `TYPE_OP_CONFLICT` | `src/mcp/tools/update-node.ts:214` (inline `ToolIssue[]`) |
| `LAST_TYPE_REMOVAL` | `src/mcp/tools/remove-type-from-node.ts:78,102` |
| `PENDING_REFERENCES` | `src/mcp/tools/delete-node.ts:78` |
| `TITLE_FILENAME_SANITIZED` | `src/mcp/tools/rename-node.ts:320`; `src/mcp/tools/update-node.ts:266,328`; `src/mcp/tools/create-node.ts:94` |
| `RESULT_TRUNCATED` | `src/mcp/tools/query-sync-log.ts:90` |
| `CROSS_NODE_FILTER_UNRESOLVED` | `src/mcp/tools/update-node.ts:522`; `src/mcp/tools/query-nodes.ts:168` |
| `FIELD_OPERATOR_MISMATCH` | `src/mcp/tools/query-nodes.ts:205` |
| `DEPRECATED_PARAM` | `src/mcp/tools/batch-mutate.ts:147` |

`code: string` declarations in scope:

- `src/mcp/tools/errors.ts:19` — `Issue.code` (Task 3 narrows)
- `src/mcp/tools/title-warnings.ts:4` — `ToolIssue.code` (Task 2 narrows)
- `src/mcp/tools/batch-mutate.ts:105` — local `deprecationWarnings` array type (Task 3 retypes to `Issue[]`)

**Out of scope** (separate domains, not `Issue.code`):

- `src/pipeline/types.ts:43` — `PipelineError.code` (different union)
- `src/auth/provider.ts:69` — auth domain
- `src/mcp/tools/resolve-identity.ts:31,34,55` — local discriminated-union return type, not `Issue`
- `src/schema/paths.ts:17,26,42` — local discriminated-union for `resolveDirectory`

---

### Task 1: Rename validation `IssueCode` → `ValidationIssueCode`

**Why first:** Avoids name collision when Task 3 introduces a new `IssueCode` in `src/mcp/tools/errors.ts`.

**Files:**
- Modify: `src/validation/types.ts:92,97`
- Modify: `src/validation/validate.ts:9,167`
- Modify: `src/schema/errors.ts:6,33,45`

- [ ] **Step 1: Rename the type in `src/validation/types.ts`**

  Find lines 89-104:
  ```ts
  export interface ValidationIssue {
    field: string;
    severity: 'error';
    code: IssueCode;
    message: string;
    details?: unknown;
  }

  export type IssueCode =
    | 'REQUIRED_MISSING'
    | 'ENUM_MISMATCH'
    | 'TYPE_MISMATCH'
    | 'COERCION_FAILED'
    | 'LIST_ITEM_COERCION_FAILED'
    | 'MERGE_CONFLICT'
    | 'INTERNAL_CONSISTENCY';
  ```

  Replace with:
  ```ts
  export interface ValidationIssue {
    field: string;
    severity: 'error';
    code: ValidationIssueCode;
    message: string;
    details?: unknown;
  }

  export type ValidationIssueCode =
    | 'REQUIRED_MISSING'
    | 'ENUM_MISMATCH'
    | 'TYPE_MISMATCH'
    | 'COERCION_FAILED'
    | 'LIST_ITEM_COERCION_FAILED'
    | 'MERGE_CONFLICT'
    | 'INTERNAL_CONSISTENCY';
  ```

- [ ] **Step 2: Update import in `src/validation/validate.ts`**

  At line 9 (inside the import block), change `IssueCode,` to `ValidationIssueCode,`.

  At line 167, change:
  ```ts
  let code: IssueCode;
  ```
  to:
  ```ts
  let code: ValidationIssueCode;
  ```

- [ ] **Step 3: Update import + uses in `src/schema/errors.ts`**

  At line 6, change `import type { IssueCode } from '../validation/types.js';` to `import type { ValidationIssueCode } from '../validation/types.js';`.

  At line 33, change `code: IssueCode;` to `code: ValidationIssueCode;`.

  At line 45, change `Record<IssueCode, ClaimValidationReason | null>` to `Record<ValidationIssueCode, ClaimValidationReason | null>`.

- [ ] **Step 4: Build to verify clean**

  Run: `npm run build`
  Expected: PASS — no compiler errors. Rename is purely internal.

- [ ] **Step 5: Test to verify nothing broke**

  Run: `npm test`
  Expected: PASS. All tests green; the rename is type-only and tests don't import `IssueCode` by type name.

- [ ] **Step 6: Commit**

  ```bash
  git add src/validation/types.ts src/validation/validate.ts src/schema/errors.ts
  git commit -m "$(cat <<'EOF'
  refactor(validation): rename IssueCode to ValidationIssueCode

  Frees the IssueCode name for use in the wider Issue.code closed-union
  in src/mcp/tools/errors.ts (next commit). Validation-side codes are a
  named subset of the wider tool/pipeline Issue codes.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 2: Narrow `ToolIssue.code` to closed `ToolIssueCode` union

**Files:**
- Modify: `src/mcp/tools/title-warnings.ts:1-7`

- [ ] **Step 1: Add `ToolIssueCode` type**

  In `src/mcp/tools/title-warnings.ts`, just before the `ToolIssue` interface (line 3), add:

  ```ts
  export type ToolIssueCode =
    | 'TITLE_WIKILINK_UNSAFE'
    | 'FRONTMATTER_IN_BODY'
    | 'TYPE_OP_CONFLICT'
    | 'TITLE_FILENAME_SANITIZED';
  ```

  **Note (correction from initial plan draft):** `TITLE_FILENAME_SANITIZED` belongs to `ToolIssueCode`, not the wider tool-only-warnings list. Pre-flight grep classified it as a tool-only warning code, but the actual emission sites at `rename-node.ts:320`, `update-node.ts:266,328`, and `create-node.ts:94` all push into variables typed `ToolIssue[]`. Task 3's `IssueCode` definition therefore composes it via `ToolIssueCode` rather than re-listing it.

- [ ] **Step 2: Retype `ToolIssue.code`**

  Replace the existing `ToolIssue` interface:
  ```ts
  export interface ToolIssue {
    code: string;
    message: string;
    characters?: string[];
  }
  ```
  with:
  ```ts
  export interface ToolIssue {
    code: ToolIssueCode;
    message: string;
    characters?: string[];
  }
  ```

- [ ] **Step 3: Build to verify**

  Run: `npm run build`
  Expected: PASS.

  Inline `ToolIssue[]` construction at `src/mcp/tools/update-node.ts:211` already uses `'TYPE_OP_CONFLICT'` (in the union). The two `title-warnings.ts` emitters (line 13, line 42) use `'TITLE_WIKILINK_UNSAFE'` and `'FRONTMATTER_IN_BODY'` (both in the union).

  If a compiler error surfaces elsewhere, that's a code missed in the union — add it to `ToolIssueCode` and re-run.

- [ ] **Step 4: Test**

  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/mcp/tools/title-warnings.ts
  git commit -m "$(cat <<'EOF'
  refactor(tools): narrow ToolIssue.code to ToolIssueCode union

  Closes the ToolIssue subset so it composes cleanly into the wider
  IssueCode union added in the next commit.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 3: Define `IssueCode` and narrow `Issue.code`

**Files:**
- Modify: `src/mcp/tools/errors.ts`
- Modify: `src/mcp/tools/batch-mutate.ts:10,105`

- [ ] **Step 1: Add `IssueCode` union to `errors.ts`**

  At the top of `src/mcp/tools/errors.ts`, the existing imports look like:
  ```ts
  import type { ValidationIssue } from '../../validation/types.js';
  import type { ToolIssue } from './title-warnings.js';
  ```

  Add the type imports from the renamed/new union members. Replace those two lines with:
  ```ts
  import type { ValidationIssue } from '../../validation/types.js';
  import type { ValidationIssueCode } from '../../validation/types.js';
  import type { ToolIssue, ToolIssueCode } from './title-warnings.js';
  ```

  Then, immediately after the existing `ErrorCode` type (after line 16, before the `Issue` interface), add:
  ```ts
  export type IssueCode =
    | ValidationIssueCode
    | ToolIssueCode
    | 'CROSS_NODE_FILTER_UNRESOLVED'
    | 'DEPRECATED_PARAM'
    | 'FIELD_OPERATOR_MISMATCH'
    | 'LAST_TYPE_REMOVAL'
    | 'PENDING_REFERENCES'
    | 'RESULT_TRUNCATED';
  ```

  Note: `TITLE_FILENAME_SANITIZED` is **not** listed here — it lives in `ToolIssueCode` (per the Task 2 correction) and is union-included via composition.

  **Note:** Do **not** include `INVALID_PARAMS`, `NOT_FOUND`, `UNKNOWN_TYPE`, `BATCH_FAILED`, `OPERATION_NOT_FOUND`, `CONFIRMATION_REQUIRED`, `INTERNAL_ERROR`, `EXTRACTOR_UNAVAILABLE`, `AMBIGUOUS_FILENAME`, `AMBIGUOUS_MATCH`, `VALIDATION_FAILED`, `CONFLICT`. Those are `ErrorCode` (failure-envelope codes), not Issue codes. Keeping them separate preserves the existing two-union split.

- [ ] **Step 2: Retype `Issue.code`**

  Replace:
  ```ts
  export interface Issue {
    code: string;
    message: string;
    severity: 'error' | 'warning';
    field?: string;
    details?: unknown;
  }
  ```
  with:
  ```ts
  export interface Issue {
    code: IssueCode;
    message: string;
    severity: 'error' | 'warning';
    field?: string;
    details?: unknown;
  }
  ```

- [ ] **Step 3: Run build to surface drift**

  Run: `npm run build`
  Expected: build fails on at least `src/mcp/tools/batch-mutate.ts:105`. Drift sites surface here.

- [ ] **Step 4: Fix `batch-mutate.ts` local `deprecationWarnings` type**

  In `src/mcp/tools/batch-mutate.ts` line 10, the existing import is:
  ```ts
  import { ok, fail, adaptIssue } from './errors.js';
  ```

  Replace with:
  ```ts
  import { ok, fail, adaptIssue, type Issue } from './errors.js';
  ```

  At line 105:
  ```ts
  const deprecationWarnings: Array<{ severity: 'warning'; code: string; message: string }> = [];
  ```
  Replace with:
  ```ts
  const deprecationWarnings: Issue[] = [];
  ```

- [ ] **Step 5: Run build again**

  Run: `npm run build`
  Expected: PASS.

  If other drift sites surface (not anticipated from the pre-flight grep), fix each by either (a) using a literal that's already in the union, or (b) adding a missing literal to `IssueCode` if it represents a legitimate new code. Do **not** widen with `as IssueCode` casts — that defeats the point.

- [ ] **Step 6: Run tests**

  Run: `npm test`
  Expected: PASS. Tests construct `Issue` and `ValidationIssue` literals using codes already in the union; no test should fail.

- [ ] **Step 7: Commit**

  ```bash
  git add src/mcp/tools/errors.ts src/mcp/tools/batch-mutate.ts
  git commit -m "$(cat <<'EOF'
  refactor(mcp): close Issue.code as IssueCode union

  IssueCode = ValidationIssueCode | ToolIssueCode | tool-only warning
  codes. Wire format unchanged (the same string literals ship). The TS
  compiler now enforces canonical code names at every Issue construction
  site. Existing callers see no behavior change.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 4: Add exhaustiveness pin test

**Files:**
- Create: `tests/mcp/issue-code-union.test.ts`

- [ ] **Step 1: Write the test**

  Create `tests/mcp/issue-code-union.test.ts` with this content:

  ```ts
  import { describe, it, expect } from 'vitest';
  import type { IssueCode } from '../../src/mcp/tools/errors.js';

  // Compile-time exhaustiveness pin: every variant of IssueCode must
  // appear as a key in this map. If a future PR adds a code to the
  // union, TS will flag the missing key here. If a code is removed
  // from the union but left in the map, TS flags an unknown key.
  //
  // The Record<IssueCode, true> type IS the test. The runtime assertion
  // below just keeps Vitest from skipping the file as empty.
  const ALL_ISSUE_CODES: Record<IssueCode, true> = {
    // ValidationIssueCode subset
    REQUIRED_MISSING: true,
    ENUM_MISMATCH: true,
    TYPE_MISMATCH: true,
    COERCION_FAILED: true,
    LIST_ITEM_COERCION_FAILED: true,
    MERGE_CONFLICT: true,
    INTERNAL_CONSISTENCY: true,
    // ToolIssueCode subset
    TITLE_WIKILINK_UNSAFE: true,
    FRONTMATTER_IN_BODY: true,
    TYPE_OP_CONFLICT: true,
    TITLE_FILENAME_SANITIZED: true,
    // Tool-only warning codes (errors.ts)
    CROSS_NODE_FILTER_UNRESOLVED: true,
    DEPRECATED_PARAM: true,
    FIELD_OPERATOR_MISMATCH: true,
    LAST_TYPE_REMOVAL: true,
    PENDING_REFERENCES: true,
    RESULT_TRUNCATED: true,
  };

  describe('IssueCode union', () => {
    it('all variants are pinned (compile-time check via Record)', () => {
      // The Record<IssueCode, true> declaration is the actual exhaustiveness
      // check — it lives at compile time. This runtime assertion confirms
      // the map is non-empty and the import resolves.
      expect(Object.keys(ALL_ISSUE_CODES).length).toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Step 2: Run the test**

  Run: `npm test -- tests/mcp/issue-code-union.test.ts`
  Expected: PASS (1 assertion).

- [ ] **Step 3: Sanity check that the pin catches drift (optional)**

  Temporarily add a fake variant to `IssueCode` in `src/mcp/tools/errors.ts`:
  ```ts
  export type IssueCode =
    ...
    | 'TITLE_FILENAME_SANITIZED'
    | 'FAKE_DRIFT_CODE';   // temporary
  ```

  Run: `npm run build`
  Expected: compile error in `tests/mcp/issue-code-union.test.ts`: "Property 'FAKE_DRIFT_CODE' is missing in type ..." or similar.

  Revert: remove the fake line. Confirm `git diff src/mcp/tools/errors.ts` is empty.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/mcp/issue-code-union.test.ts
  git commit -m "$(cat <<'EOF'
  test(mcp): pin IssueCode union exhaustiveness

  Record<IssueCode, true> at compile time means any future PR that adds
  or removes a variant from the union must update the map (TS flags the
  drift). Runtime assertion just keeps Vitest from skipping the file.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 5: Final verification

**Files:** none modified.

- [ ] **Step 1: Full build**

  Run: `npm run build`
  Expected: PASS. No errors.

- [ ] **Step 2: Full test suite**

  Run: `npm test`
  Expected: PASS. All tests green, including the new pin.

- [ ] **Step 3: Confirm commit shape**

  Run: `git log --oneline -5`
  Expected: four new focused commits at HEAD, in this order (newest first):
  - `test(mcp): pin IssueCode union exhaustiveness`
  - `refactor(mcp): close Issue.code as IssueCode union`
  - `refactor(tools): narrow ToolIssue.code to ToolIssueCode union`
  - `refactor(validation): rename IssueCode to ValidationIssueCode`

- [ ] **Step 4: Confirm wire format unchanged**

  Spot-check: invoke `create-node` with `title: "Foo/Bar"` (slash triggers `TITLE_FILENAME_SANITIZED`). Confirm the JSON envelope's `warnings[0].code` is the literal string `"TITLE_FILENAME_SANITIZED"`.

  Quick way:
  ```bash
  npx tsx -e "
  import { ok } from './src/mcp/tools/errors.js';
  console.log(JSON.stringify(ok('hello', [{
    code: 'TITLE_FILENAME_SANITIZED',
    message: 'sanitized',
    severity: 'warning',
  }])));
  " | jq -r '.content[0].text' | jq '.warnings[0].code'
  ```
  Expected output: `"TITLE_FILENAME_SANITIZED"`. (No type narrowing affects the JSON.)

  If your environment doesn't have `jq` or running ad-hoc tsx is awkward, skip this — the existing test suite (which already serializes envelopes) covers the same property.
