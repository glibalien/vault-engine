# MCP Response Envelope Standardization — Design

**Date:** 2026-04-19
**Status:** Spec
**Sequence:** 4 of the architecture-review follow-ups
**Addresses:** [Architecture Review 2026-04-18](2026-04-18-architecture-review.md) finding §3a
**Precedents:**
- [Unified Deletion Design 2026-04-19](2026-04-19-unified-deletion-design.md) (sequence 2, merged)
- [Schema Propagation Through the Pipeline 2026-04-19](2026-04-19-schema-propagation-through-pipeline-design.md) (sequence 3, merged)

## Goal

Collapse the seven-plus idiosyncratic MCP response shapes across 27 tool files into a single envelope: `{ok, data, warnings: Issue[], error?: {code, message, details?}}`. One parse path for every client, structured warnings in place of free-text `notice`/`warning` strings, and the load-bearing type-error detail preserved inside `error.details` for LLM self-correction.

Parallel to the pipeline work; orthogonal to undo.

## Non-goals

- **§3c — uniform dry-run.** `dry_run` / `confirm: false` / `preview`-wrapping stays as-is inside `data`. Separate sequence.
- **§3d — default-population consolidation.** Separate.
- **§3e — override-resolution reuse.** Separate.
- **MCP protocol-level `isError: true`** on the content envelope. Errors remain in-band in the JSON payload. Decided against because we have no documentation of how the claude.ai connector treats `isError` — scope is limited to the in-band envelope.
- **Per-op warnings in batch-mutate** with an added `op_index` field. Future work; out of scope here to keep the sequence tight.
- **Closed-union `Issue.code` enum.** Stays open `string` because codes originate in multiple pipelines (validation, coercion, title-safety, structure). A cross-cutting refactor to a closed union is its own ticket.
- **Standardizing per-tool `data` shapes.** Envelope standardization does not force internal shape uniformity — `validate-node`'s `data.issues` vs. mutation tools' envelope-level `warnings` is a deliberate, contract-driven split (see §2).

## Current state

Every tool already goes through one of three helpers in `src/mcp/tools/errors.ts`:

```ts
export function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> }
export function toolErrorResult(code: ErrorCode, message: string)
export function toolValidationErrorResult(validation: ValidationResult)
```

No tool throws `McpError`; no tool sets `isError: true`. Every response — success or failure — is `{content: [{type: 'text', text: JSON.stringify(body)}]}` where `body` is tool-defined.

**Observed shapes across 27 tool files (verified post sequences 1-3):**

| Category | Example | Shape |
|---|---|---|
| Bare array | `list-types`, `list-schemas`, `list-global-fields` | `[...]` |
| Bare object | `get-node`, `describe-schema`, `vault-stats` | `{...}` |
| Validation report | `validate-node` | `{valid, issues, effective_fields, coerced_state, orphan_fields, types_without_schemas}` |
| Query result | `query-nodes` | `{nodes, total, notice?}` |
| Query result | `query-sync-log` | `{rows, count, truncated}` |
| Mutation | `create-node`, `update-node`, `add-type-to-node` | `{node_id, file_path, title, types, coerced_state, issues, orphan_fields}` |
| Preview | `delete-node` (confirm:false) | `{preview:true, ..., warning: string \| null}` |
| Preview | `remove-type-from-node` (confirm:false, last type) | `{preview:true, ..., warning: string}` |
| Bulk atomic | `batch-mutate` success | `{applied:true, results:[{op,node_id,file_path}]}` |
| Bulk atomic | `batch-mutate` failure | `{applied:false, failed_at, error:{op,message,issues?,fixable?}, rollback_failures?}` |
| Bulk query | `update-node` query mode dry-run | `{dry_run:true, batch_id, matched, would_update, would_skip, would_fail, preview:[...], notice?}` |
| Bulk query | `update-node` query mode execute | `{dry_run:false, batch_id, matched, updated, skipped, errors:[]}` |
| Error (standard) | most tools | `{error:msg, code}` |
| Error (validation) | `toolValidationErrorResult` | `{error:msg, code:'VALIDATION_FAILED', issues, fixable}` |
| Error (type-aware) | `create-node`, `update-node`, `add-type-to-node` on unknown type | `{error, code:'UNKNOWN_TYPE', unknown_types, message, available_schemas, suggestion}` |
| Error (file-aware) | `read-embedded` on ambiguity | `{error, code:'AMBIGUOUS_FILENAME', matches}` |

~136 call sites to `toolResult*` across 28 files. Tests with `notice` or `warning` string assertions: 12 hits across 3 files.

Three distinct warning surfaces today:
- `notice: string` — query-nodes, update-node query mode.
- `warning: string` — delete-node preview, remove-type-from-node preview.
- `issues[]` — all validation-producing tools. The runtime array is a **mix of two internal types**:
  - `ValidationIssue` (from `src/validation/types.ts`): `{field, severity: 'error', code, message, details?}` — severity is a single literal `'error'`. Closed-union `IssueCode`.
  - `ToolIssue` (from `src/mcp/tools/title-warnings.ts`): `{code, message, characters?}` — no `severity`, no `field`. Open-string code. Treated as a warning by convention (the `toolValidationErrorResult` error-count filter uses `severity === 'error'` which skips these).

No tool emits an issue with `severity: 'warning'` in the literal-type sense today — the warning/error split is implicit from the type origin, not from an explicit field.

## Design

### §1 — Envelope

The MCP transport shape `{content: [{type: 'text', text: JSON.stringify(...)}]}` is unchanged. The JSON body inside `text` becomes:

```ts
type Envelope<T> =
  | { ok: true;  data: T;  warnings: Issue[] }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;   // carries structured context rescued from ValidationIssue.details or ToolIssue.characters
}
```

**`Issue` is a new type** defined in `src/mcp/tools/errors.ts` — distinct from the internal `ValidationIssue` and `ToolIssue` types, which keep their current shapes and internal use. The new `Issue` is the tool-boundary shape only.

**Naming caveat.** `warnings: Issue[]` carries mixed severity (`'error' | 'warning'`). A mutation that completes after tolerated coercion still surfaces its `severity: 'error'` ValidationIssues in envelope `warnings`. The field name comes from the arch review and is kept for consistency with that proposal; semantically it's "advisory issues regardless of severity." The LLM/client reads `severity` per-element to distinguish.

**Invariants:**

1. `ok: true` ↔ `data` present, `error` absent.
2. `ok: false` ↔ `error` present, `data` absent.
3. `warnings` is always present (possibly empty) on both `ok: true` and `ok: false` envelopes. A failure response can still surface warnings about things evaluated before the failure.
4. `error.details` is optional and free-form. Structured fields rescued from today's ad-hoc error shapes live here.

**Helpers in `src/mcp/tools/errors.ts` (rewritten):**

```ts
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

export interface Envelope<T> { /* as above */ }

export function ok<T>(data: T, warnings?: Issue[]): ToolResult;
export function fail(
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; warnings?: Issue[] },
): ToolResult;

// Adapter: collapse the two internal issue shapes into the tool-boundary Issue.
export function adaptIssue(v: ValidationIssue | ToolIssue): Issue;
```

`BATCH_FAILED` is new — captures what `batch-mutate` currently surfaces as `applied: false` + untagged error.

The three old exports (`toolResult`, `toolErrorResult`, `toolValidationErrorResult`) are deleted. Every call site moves to `ok` or `fail`.

### §2 — Issue taxonomy

Today's free-text `notice` and `warning` strings become structured Issues. New codes:

| Source | New code | Severity | Notes |
|---|---|---|---|
| `query-nodes` / `update-node` query mode `notice` | `CROSS_NODE_FILTER_UNRESOLVED` | `warning` | Emitted when `join_filters` can't resolve one or more edges. |
| `delete-node` preview `warning` | `PENDING_REFERENCES` | `warning` | Emitted when `incoming_reference_count > 0`. |
| `remove-type-from-node` preview `warning` | `LAST_TYPE_REMOVAL` | `warning` | Emitted when removal would leave the node with zero types. |
| `query-sync-log` `truncated: true` | `RESULT_TRUNCATED` | `warning` | Emitted alongside the existing `data.truncated` boolean (kept for mechanical clients). |

Existing internal issue types adapt to the new `Issue` at the tool boundary:

| From | To |
|---|---|
| `ValidationIssue {field, severity: 'error', code, message, details?}` | `Issue {field, severity: 'error', code, message, details?}` — straight carry-over. |
| `ToolIssue {code, message, characters?}` (e.g. `TITLE_WIKILINK_UNSAFE`, `FRONTMATTER_IN_BODY`) | `Issue {code, message, severity: 'warning', details: characters ? {characters} : undefined}` — add severity, nest `characters` into `details`. |

The adaptation happens at the tool handler boundary (inside the tool's `.ts` file) before calling `ok(...)`/`fail(...)`. An `adaptIssue(v: ValidationIssue | ToolIssue): Issue` helper lives in `src/mcp/tools/errors.ts` to keep this one-liner.

Internal types (`ValidationIssue`, `ToolIssue`) are unchanged. Their downstream producers (`src/validation/*`, `src/mcp/tools/title-warnings.ts`) keep their current shapes.

Pipeline-emitted codes (`VALUE_COERCED`, `MERGE_CONFLICT`, `REQUIRED_MISSING`, `TYPE_MISMATCH`, `TITLE_WIKILINK_UNSAFE`, `TYPE_OP_CONFLICT`, etc.) stay in use — they become the `Issue.code` values surfaced via the adapter above.

**Where validation issues go:**

- `create-node`, `update-node` single mode, `add-type-to-node`, `remove-type-from-node`, `rename-node`: issues move out of `data` into envelope `warnings`. `coerced_state`, `orphan_fields`, etc. stay in `data` as the "what happened" payload.
- `validate-node`: **issues stay in `data.issues`.** This tool's entire contract is "report what's wrong with this node" — the issues ARE its output, not side-channel metadata. Envelope `warnings` stays empty unless a non-validation warning fires (none currently do).
- `batch-mutate`: per-op issues stay nested inside each `results[i]` element (attribution matters). Envelope `warnings` is reserved for batch-level signals.
- `update-node` query mode: per-node `errors[]` (from execute path) stays in `data.errors`. `CROSS_NODE_FILTER_UNRESOLVED` surfaces at envelope level.

**`truncated` duplication.** `RESULT_TRUNCATED` warning is emitted in parallel with the existing `data.truncated` boolean. Two paths for one fact; mechanical clients reading the boolean keep working while LLM clients reading envelope `warnings` get the structured signal. Explicitly called out so a future maintainer doesn't "simplify" by removing one side.

### §3 — Per-tool migration mapping

**Bucket 1 — Read-only tools (12):** `vault-stats`, `list-types`, `list-schemas`, `describe-schema`, `list-global-fields`, `describe-global-field`, `query-nodes`, `query-sync-log`, `get-node`, `infer-field-type`, `list-field-values`, `read-embedded`.

- `toolResult(X)` → `ok(X)`. Data shape unchanged.
- `query-nodes` / `update-node` query: hoist `notice` string → `CROSS_NODE_FILTER_UNRESOLVED` warning; remove `notice` from `data`.
- `query-sync-log`: emit `RESULT_TRUNCATED` warning when `truncated: true`; keep `truncated` field.
- `read-embedded` `AMBIGUOUS_FILENAME`: `matches[]` → `error.details.matches`.

**Bucket 2 — Single-node mutations (13):** `create-node`, `update-node` single mode, `delete-node`, `rename-node`, `add-type-to-node`, `remove-type-from-node`, `create-schema`, `update-schema`, `delete-schema`, `create-global-field`, `update-global-field`, `rename-global-field`, `delete-global-field`.

- Success path `issues[]` → envelope `warnings`; remove from `data`.
- `delete-node` preview `warning: string | null` → `PENDING_REFERENCES` warning when present; remove from `data`. The `preview: true` flag, counts, and `referencing_nodes[]` stay in `data`.
- `remove-type-from-node` preview `warning: string` → `LAST_TYPE_REMOVAL` warning; remove from `data`.
- Dry-run response wrappers (`dry_run: true`, `would_create`, `preview`) stay in `data`. §3c (uniform dry-run) is a separate sequence. **However**: issues inside those wrappers still migrate to envelope `warnings` (so clients look in one place regardless of dry-run vs. non-dry-run). `fixable` stays inside the dry-run wrapper as actionable data, not a warning.
- `UNKNOWN_TYPE` error: `{error, code, unknown_types, message, available_schemas, suggestion}` → `fail('UNKNOWN_TYPE', message, {details: {unknown_types, available_schemas, suggestion}})`. The suggestion string migrates verbatim from `message` into `error.details.suggestion`; the human-readable `message` keeps the primary error narrative.
- `VALIDATION_FAILED` error: `issues` → `error.details.issues`; `fixable` → `error.details.fixable`.

**Bucket 3 — Bulk tools (2):** `batch-mutate`, `update-node` query mode.

- `batch-mutate` success: `{applied: true, results: [...]}` → `ok({applied: true, results})`.
- `batch-mutate` failure: `{applied: false, failed_at, error: {op, message, issues?, fixable?}, rollback_failures?}` → `fail('BATCH_FAILED', message, {details: {failed_at, op, issues?: issues.map(adaptIssue), fixable?, rollback_failures?}})`. The per-op error object flattens into `error.details`; any `issues[]` inside passes through `adaptIssue` for shape consistency.
- `update-node` query mode: dry-run and execute shapes stay in `data`; `notice` → envelope warning (above).

**Special: `validate-node` (1).** Data stays `{valid, effective_fields, coerced_state, issues, orphan_fields, types_without_schemas}`. The `data.issues` array is `Issue[]` (passes through `adaptIssue` so the shape is identical to the envelope `warnings` element type — consumers seeing "issues" in either location get the same shape). Envelope `warnings` stays empty.

Bucket totals: 12 + 13 + 2 + 1 = 28 handler paths across 27 tool files (`update-node` is one file serving two modes).

### §4 — Call-site migration pattern

Mechanical find/replace per file:

| Before | After |
|---|---|
| `return toolResult({data…, issues})` | `return ok({data…}, issues.map(adaptIssue))` |
| `return toolResult({data…, notice})` | `return ok({data…}, [{code:'CROSS_NODE_FILTER_UNRESOLVED', severity:'warning', message: notice}])` |
| `return toolResult({data…, warning: text})` (delete-node / remove-type) | `return ok({data…}, [{code:'PENDING_REFERENCES' \| 'LAST_TYPE_REMOVAL', severity:'warning', message: text}])` |
| `return toolErrorResult('CODE', msg)` | `return fail('CODE', msg)` |
| `return toolResult({error:msg, code:'CODE', ...extras})` | `return fail('CODE', msg, {details: {...extras}})` |
| `return toolValidationErrorResult(v)` | `return fail('VALIDATION_FAILED', \`${n} error(s)\`, {details: {issues: v.issues, fixable: buildFixable(v.issues, v.effective_fields)}})` |

Touch counts per file (approx): read-only tools 1-3 sites each; single-node mutations 5-15; `update-node.ts` ~22 (biggest file).

No tool handler constructs the outer `{content: [...]}` wrapper directly — that stays inside `ok` / `fail`.

## Test strategy

### Envelope invariant tests — new file `tests/mcp/envelope.test.ts`

Property-level coverage running across all registered tools via the MCP test harness:

- Every tool response matches `Envelope<unknown>` structurally.
- `ok: true` ↔ `data` key present, `error` key absent.
- `ok: false` ↔ `error` key present, `data` key absent.
- `warnings` is always an array (possibly empty) regardless of `ok`.
- Exercise: each tool called with (a) valid params (success envelope), (b) invalid params (failure envelope). Validates the invariant on both arms.

This is additive — does not replace per-tool content assertions.

### Per-tool test updates

- **Structured assertions** migrate mechanically:
  - `result.issues` → `result.warnings` (for mutation tools where issues moved to envelope).
  - `result.error` → `result.error.message`.
  - `result.code` → `result.error.code`.
  - `result.fixable` → `result.error.details.fixable`.
  - `result.issues` on `VALIDATION_FAILED` → `result.error.details.issues`.
  - `result.unknown_types` / `available_schemas` / `suggestion` → `result.error.details.{field}`.
  - `result.matches` on `AMBIGUOUS_FILENAME` → `result.error.details.matches`.
- **Free-text assertions** (12 grep hits): `result.notice` → look for `{code: 'CROSS_NODE_FILTER_UNRESOLVED'}` in `result.warnings`. Similar for `result.warning`.
- **`validate-node`**: no change to `result.issues` assertions (issues stay in data).

### Per-new-code tests

One test per new code verifying the warning is emitted when expected and omitted when not:

- `CROSS_NODE_FILTER_UNRESOLVED` — query with unresolvable `join_filters` edge → warning present; clean query → absent.
- `PENDING_REFERENCES` — delete-node preview on a referenced node → warning present; on a clean node → absent.
- `LAST_TYPE_REMOVAL` — remove-type preview on last type → warning present; on not-last → absent.
- `RESULT_TRUNCATED` — sync-log query hitting limit → warning present AND `data.truncated === true`.

### Regression preservation

Every existing test that asserts observable tool behavior (not response shape) passes unchanged. The envelope is a shape wrapper, not a semantic change.

### Connector sanity check (manual, pre-merge)

Before merge: run the new build behind the claude.ai connector, exercise (a) a read tool, (b) a simple mutation, (c) a bulk mutation, (d) an intentional error, (e) a tool that emits a warning. Confirm the LLM adapts. Not part of CI.

## Risk notes

- **External consumers breaking.** Anyone reading the old flat `{error, code}` shape breaks. No known external consumers outside the claude.ai connector; manual check in pre-merge validates. The new shape is a strict superset of information — nothing is dropped, only restructured — so LLM clients adapt naturally.
- **Per-tool `data` is not standardized.** `validate-node`'s `data.issues` vs. mutation tools' envelope-level `warnings` is a deliberate split, not drift. Documented in §2 so future readers don't see it as an oversight.
- **200+ test assertion migrations in one PR.** Mechanical but error-prone. Commit per bucket (read-only, then single-node, then bulk); `npm test` after each; don't squash during development.
- **Envelope invariant tests are additive.** They guard the invariant, not content. Per-tool content assertions stay in place.
- **`truncated` duplication.** Warning + data field for the same fact. Deliberate; called out so a future "simplifier" doesn't remove one side.
- **`BATCH_FAILED` is a new error code.** Adds to the `ErrorCode` union. Every `ErrorCode` consumer downstream must handle it — grep confirms the union is only referenced inside `src/mcp/tools/`, so the blast radius is local.

## Sequencing

One implementation pass, one PR:

1. Rewrite `src/mcp/tools/errors.ts` with `ok` / `fail` helpers, `Envelope<T>`, `ErrorCode` (including `BATCH_FAILED`), new `Issue` type, and `adaptIssue` helper. Commit.
2. Migrate read-only tools (12). Update their tests. `npm run build` + `npm test`. Commit.
3. Migrate single-node mutation tools. Update tests. Build + test. Commit.
4. Migrate bulk tools (`batch-mutate`, `update-node` query mode). Update tests. Build + test. Commit.
5. Add `tests/mcp/envelope.test.ts`. Commit.
6. Manual claude.ai connector check.
7. Merge to `main`.

No DB migration. No `search_version` bump. No MCP tool surface change beyond wire format.
