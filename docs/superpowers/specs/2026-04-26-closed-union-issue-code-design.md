# Closed-union `Issue.code` (Design)

**Status:** spec
**Date:** 2026-04-26
**Predecessor postmortem:** `docs/superpowers/specs/2026-04-25-bundle-b-postmortem.md`

## Background

This was originally one of three "Bundle B v2" tool-surface-symmetry items spec'd alongside `op_index` on batch-mutate warnings and a global-field undo system. After value review, the other two were dropped:

- **`op_index` on batch-mutate** — deferred. Today batch-mutate's only per-op warning is `DEPRECATED_PARAM`, and `failed_at: i` already identifies the failing op on errors. The warnings that would benefit (`TITLE_FILENAME_SANITIZED`, `TITLE_WIKILINK_UNSAFE` from `executeMutation`) aren't surfaced through batch-mutate today; surfacing them is its own work. `op_index` should bundle with that surfacing fix when it lands.
- **Global-field undo** — deferred to backlog. Real symmetry gap, real complexity, low expected use frequency, and inherits a pre-existing atomicity gap in `restoreOperation`. File as backlog; let demand drive priority.

This spec covers only the closed-union narrowing of `Issue.code`.

## Current state

`Issue` at `src/mcp/tools/errors.ts:18-24`:

```ts
export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;
}
```

`code: string` is open. The adjacent failure-envelope union `ErrorCode` (lines 4-16) is already closed. The validation-side union `ValidationIssue.IssueCode` exists at `src/validation/types.ts:97-104`.

## Codes emitted today

Verified via `grep -rn "code: '<UPPER_SNAKE>'"` across `src/mcp/tools/`, `src/validation/`, `src/pipeline/`:

- Tool / pipeline / validation warnings: `CROSS_NODE_FILTER_UNRESOLVED`, `DEPRECATED_PARAM`, `ENUM_MISMATCH`, `FIELD_OPERATOR_MISMATCH`, `FRONTMATTER_IN_BODY`, `INVALID_PARAMS`, `LAST_TYPE_REMOVAL`, `NOT_FOUND`, `PENDING_REFERENCES`, `REQUIRED_MISSING`, `RESULT_TRUNCATED`, `TITLE_FILENAME_SANITIZED`, `TITLE_WIKILINK_UNSAFE`, `TYPE_OP_CONFLICT`.
- Validation-side (`ValidationIssue.IssueCode` at `src/validation/types.ts:97-104`): `REQUIRED_MISSING`, `ENUM_MISMATCH`, `TYPE_MISMATCH`, `COERCION_FAILED`, `LIST_ITEM_COERCION_FAILED`, `MERGE_CONFLICT`, `INTERNAL_CONSISTENCY`.

(Implementation step verifies the final list. A fresh grep at implementation time may surface additions; the union must include them.)

## Design

1. In `src/mcp/tools/errors.ts`, define a single closed `IssueCode` union — superset of the warning codes and the emitted-validation codes above.
2. Retype `Issue.code: IssueCode` (was `string`).
3. `adaptIssue()` continues to bridge `ValidationIssue` and `ToolIssue`. Both incoming code types must be subsets of `IssueCode`. The function compiles cleanly with no widening (no `as IssueCode`/`as string` casts).
4. Mechanical sweep of every site that constructs an `Issue` literal or pushes onto a `warnings: Issue[]` array. The compiler flags drift; no runtime check needed.

## What does **not** change

- **Wire format.** The string literals shipped on the wire are unchanged.
- **Severity model.**
- **`ErrorCode`** (the failure-envelope union — already closed; not re-litigated).
- **Code names.** No renames.
- **`Issue` shape.** No new fields.

## Tests

The TypeScript compiler is the primary check. No new runtime tests are strictly required — if any site constructs an `Issue` with an out-of-union code, `tsc` fails.

One small smoke test is worth adding: a unit test that exhaustively switches on `IssueCode` (with TypeScript's exhaustiveness check via `never`) and asserts every variant maps to a non-empty string. This pins the union as the source of truth and makes future drift loud.

## Files touched

- `src/mcp/tools/errors.ts` — add `IssueCode` union, retype `Issue.code`.
- `src/validation/types.ts` — verify `ValidationIssue.IssueCode` is a subset of `IssueCode` (or unify if cleaner).
- All sites that construct `Issue` objects — mechanical type fixups, no logic changes. The compiler enumerates these.
- One new test file (e.g. `tests/mcp/issue-code-union.test.ts`) — the exhaustiveness pin.

## Risks

- **Validation/Tool union drift.** `ValidationIssue.IssueCode` is currently a separate union that must be a subset of `IssueCode`. If they diverge, `adaptIssue()` widens. The fix is to either make `IssueCode` a strict superset and assert at compile time, or to define `IssueCode` as `ValidationIssueCode | ToolIssueCode` so the union is trivially correct. Implementer's call during build.
- **Future contributor friction.** Adding a new warning code now requires updating the union. This is the intended trade-off; it's also low-friction once visible.
