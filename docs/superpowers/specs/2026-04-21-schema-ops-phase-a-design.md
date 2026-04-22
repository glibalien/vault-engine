# Schema Ops Phase A — Diagnostic Errors + batch-mutate Directory Fix

**Date:** 2026-04-21
**Status:** Draft — ready to plan-and-build
**Follow-on:** Phase B design — `2026-04-21-schema-ops-phase-b-design.md`
**Source notes:**
- `Notes/Vault Engine - Schema Operations Safety and Validation Gaps.md`
- `Notes/Vault Engine - batch-mutate create ignores schema default_directory.md`

## Context

A session adding a `context` claim to the `note` schema exposed a cascade of gaps in the schema-ops surface. `update-schema`'s opaque `"Validation failed"` error made debugging impossible from the MCP surface, turning a 1-minute change into a multi-step investigation; the atomic-replace semantics of `field_claims` silently orphaned values across 36 notes during probe attempts to isolate the failure; `batch-mutate` create ops were independently found to ignore schema `default_directory`, placing files in the vault root.

Prioritization was agreed during brainstorming: Phase A addresses the diagnostic layer (debuggability) plus one tight bug fix. Phase B layers safety guardrails (dry-run, confirmation, undo) on top. Phase A is smaller, tighter, and unblocks the other work — shipping it independently is valuable on its own because the new errors will immediately make the `note`-can't-claim-`status` issue self-diagnosing.

## Scope

**In scope (Phase A only):**

1. **A1 — Structured validation errors on schema ops.** Replace opaque `"Validation failed"` with grouped, actionable errors carrying `reason`, `field`, `count`, `invalid_values`, `sample_nodes`. Set the error-shape pattern for all schema-op tools.
2. **A2 — `batch-mutate` create respects schema `default_directory`.** Extract shared directory resolver into a charter-aligned `src/schema/paths.ts`, use it from both `create-node` and `batch-mutate`. Rename `batch-mutate`'s `path` param to `directory` for semantic alignment with `create-node` (accept `path` as a deprecated alias with warning).
3. **A3 — `rename-node` default-directory consistency for multi-typed nodes.** Today, `rename-node` picks a schema non-deterministically for multi-typed nodes (SQLite `SELECT ... LIMIT 1` without `ORDER BY`), producing different results from `create-node`'s explicit `types[0]`. Refactor `rename-node` to use the same `resolveDirectory()` helper from `src/schema/paths.ts`, driven by the node's ordered types list.

**Finding 1 (note can't claim status) is resolved by A1**, not a separate code change. The failure has a data cause: 10 of the 16 notes with orphaned status values hold enum-invalid values (`active`, `draft`, `spec`, `complete`). With A1 in place, the next attempt at adding `status` to `note`'s claims will surface the 10-node `ENUM_INVALID` group with the offending values listed — self-diagnosing.

**Out of scope — addressed in Phase B:**

- Dry-run for `update-schema` (Finding 3a).
- `confirm_large_change` gate (Finding 3c).
- Undo parity for schema ops (Finding 4).

**Out of scope — deferred entirely:**

- Patch-style claim operations (`add_field_claims` etc., Finding 3b).
- `describe-schema` compact variant (Finding 5).
- Undo for global-field ops.

## Architecture overview

Phase A lands in two existing files (`src/mcp/tools/update-schema.ts`, `src/mcp/tools/batch-mutate.ts`), refactors two existing files (`src/mcp/tools/create-node.ts` and `src/mcp/tools/rename-node.ts`) to use the new shared helper, and introduces two new files:

- **`src/schema/errors.ts`** — `SchemaValidationError` class, `ValidationGroup` type, grouping utilities.
- **`src/schema/paths.ts`** — shared `resolveDirectory()` helper.

**Expansion Charter alignment.** Both new files live in `src/schema/` — the core/schema layer that survives the forthcoming service extraction (Expansion Charter Priority #1). No transport-layer coupling. When `nodeService.create()` exists in a future pass, it'll import from the same locations unchanged.

## A1 — Structured validation errors (Findings 1 + 2)

**Goal.** Replace the opaque `"Validation failed"` surface with grouped, actionable errors. Sets the error-shape pattern for all schema-op tools.

**New file `src/schema/errors.ts`:**

```typescript
export type ClaimValidationReason =
  | 'UNKNOWN_FIELD'          // claim references field not in global pool
  | 'OVERRIDE_NOT_ALLOWED'   // tried to override a property without overrides_allowed
  | 'STRUCTURAL_INCOMPAT'    // e.g. enum_values_override on non-enum field
  | 'ENUM_INVALID'           // node value not in enum (from propagation)
  | 'TYPE_MISMATCH'          // node value wrong type (from propagation)
  | 'REQUIRED_MISSING';      // node missing required field (from propagation)

export interface ValidationGroup {
  reason: ClaimValidationReason;
  field: string;
  count: number;
  invalid_values?: Array<{ value: string; count: number }>;   // ENUM_INVALID only
  sample_nodes?: Array<{ id: string; title: string }>;        // up to 5
  message: string;                                            // human-readable + remediation hint
}

export class SchemaValidationError extends Error {
  constructor(public readonly groups: ValidationGroup[]) {
    super(`Schema change rejected: ${groups.length} validation group(s), ${groups.reduce((s, g) => s + g.count, 0)} total issue(s)`);
    this.name = 'SchemaValidationError';
  }
}
```

**Refactor `src/schema/crud.ts::validateClaims()`.** Accumulate issues into `ValidationGroup[]` rather than throwing on first hit. Throw a single `SchemaValidationError` at the end if non-empty. All three existing throw sites (`UNKNOWN_FIELD`, `OVERRIDE_NOT_ALLOWED`, `STRUCTURAL_INCOMPAT`) map to a `ValidationGroup` with `count: 1`.

**Refactor `src/schema/propagate.ts::propagateSchemaChange()`.** Today it calls `executeMutation` per node and throws on the first validation failure. New behavior: collect per-node failures into an array, continue iterating, then at the end — if any failures exist — roll back the transaction and throw a single `SchemaValidationError` with failures aggregated into groups.

**Grouping logic** (in `src/schema/errors.ts`): given a list of per-node issues `{ node_id, title, field, code, value? }`, group by `(code, field)` and produce:
- `count` = number of nodes hit
- `invalid_values` = for `ENUM_INVALID`, roll up values with counts
- `sample_nodes` = first 5 distinct nodes
- `message` = templated by reason (e.g., `"10 nodes have values not in enum for field 'status': active (6), draft (3), spec (1), complete (1). Either clean up the values, extend the enum, or enable enum_values_override on the global field."`)

**Tool handler in `src/mcp/tools/update-schema.ts`:** replace the catch-all `fail('INVALID_PARAMS', err.message)` with:

```typescript
if (err instanceof SchemaValidationError) {
  return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
}
// Other errors fall through to INVALID_PARAMS
```

**Envelope example (the status-on-note case):**

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Schema change rejected: 1 validation group(s), 10 total issue(s)",
    "details": {
      "groups": [{
        "reason": "ENUM_INVALID",
        "field": "status",
        "count": 10,
        "invalid_values": [
          {"value": "active", "count": 6},
          {"value": "draft", "count": 3},
          {"value": "spec", "count": 1}
        ],
        "sample_nodes": [{"id": "...", "title": "..."}],
        "message": "10 nodes have values not in enum for field 'status'. Either clean up values on those nodes, extend the global enum, or enable enum_values_override on the global 'status' field."
      }]
    }
  },
  "warnings": []
}
```

**Testing.**

- Unit: `tests/schema/crud.test.ts` extensions covering each reason.
- Unit: new `tests/schema/errors.test.ts` for grouping utility (aggregate counts, sample truncation, enum value rollup).
- Integration: new `tests/mcp/update-schema.test.ts` — seed 10 notes with invalid status values, attempt claim, assert envelope shape.

**Risks.**

- `propagateSchemaChange` switching from first-fail to collect-all does extra work in failed calls. Healthy calls are unaffected.
- Non-validation errors (DB constraint, I/O) continue to funnel through `INVALID_PARAMS` / `INTERNAL`. Only validation gets the specialized path.

## A2 — `batch-mutate` directory resolution (batch-mutate bug note)

**Goal.** Fix the bug (files landing in vault root), align `batch-mutate` create with `create-node`'s directory semantics, and extract the shared resolver into a charter-aligned location.

**New file `src/schema/paths.ts`:**

```typescript
export interface ResolveDirectoryInput {
  types: string[];
  directory: string | undefined;
  override_default_directory: boolean;
}

export type ResolveDirectoryResult =
  | { ok: true; directory: string; source: 'explicit' | 'schema_default' | 'root' }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

export function resolveDirectory(db: Database.Database, input: ResolveDirectoryInput): ResolveDirectoryResult {
  if (input.directory !== undefined && input.directory.endsWith('.md')) {
    return { ok: false, code: 'INVALID_PARAMS', message: '"directory" must be a folder path, not a filename. The filename is always derived from the node title.' };
  }
  let schemaDefaultDir: string | null = null;
  if (input.types.length >= 1) {
    const schema = db.prepare('SELECT default_directory FROM schemas WHERE name = ?').get(input.types[0]) as { default_directory: string | null } | undefined;
    schemaDefaultDir = schema?.default_directory ?? null;
  }
  if (input.directory !== undefined && schemaDefaultDir && !input.override_default_directory) {
    return { ok: false, code: 'INVALID_PARAMS', message: `Type "${input.types[0]}" routes to "${schemaDefaultDir}/" via schema. Pass override_default_directory: true to place this node elsewhere.` };
  }
  if (input.directory !== undefined) return { ok: true, directory: input.directory, source: 'explicit' };
  if (schemaDefaultDir) return { ok: true, directory: schemaDefaultDir, source: 'schema_default' };
  return { ok: true, directory: '', source: 'root' };
}
```

**Refactor `src/mcp/tools/create-node.ts`.** Replace the directory logic at lines 74–96 with a call to `resolveDirectory`. Behavior unchanged. Filename-template resolution stays inline for now (separate concern; different shape per-type).

**Refactor `src/mcp/tools/batch-mutate.ts` create op:**

- Rename zod param `path` → `directory`.
- Accept `path` as a deprecated alias. If `path` is passed but `directory` is not, copy internally and emit a warning into the envelope's `warnings` array: `{severity: 'warning', code: 'DEPRECATED_PARAM', message: "Param 'path' is deprecated in batch-mutate create; use 'directory' instead."}`. If both are passed, error with `INVALID_PARAMS`.
- Add `override_default_directory: boolean` param.
- Replace the single-line path assembly with:
  ```typescript
  const dirResult = resolveDirectory(db, { types, directory, override_default_directory });
  if (!dirResult.ok) throw new PipelineError(dirResult.code, dirResult.message);
  const dir = dirResult.directory;
  const filePath = dir ? `${dir}/${title}.md` : `${title}.md`;
  ```

**Filename-template support in `batch-mutate` create is out of scope** — batch-mutate has never supported templates and directory placement is the active bug. Keep `${title}.md` as-is.

**Tool description update on `batch-mutate`** — note that `directory` defaults to the schema's `default_directory` when unspecified, matching `create-node`.

**Deprecation timeline.** `path` alias stays for one release (CHANGELOG entry), then removed.

**Testing.**

- Unit: `tests/schema/paths.test.ts` covers all six branches of `resolveDirectory` (explicit, default, root, conflict, not-a-folder, no-schema).
- Integration: new or extended `tests/mcp/batch-mutate.test.ts`:
  - create, no `directory`, schema with `default_directory` → file lands in schema dir.
  - create, with `directory`, schema with `default_directory`, no override → fails.
  - create, `directory` + `override_default_directory: true` → file lands in `directory`.
  - create, deprecated `path` only → succeeds with warning.
  - create, both `path` and `directory` → fails with `INVALID_PARAMS`.
- Regression: existing `create-node` tests pass unchanged.

## A3 — `rename-node` default-directory consistency (multi-typed nodes)

**Goal.** Make `rename-node`'s default-directory resolution identical to `create-node`'s for multi-typed nodes, so a rename without an explicit `directory` param doesn't silently move the file to a different type's schema directory.

**Bug observed.** Creating a node with `types: ["task", "note"]` via `create-node` lands the file in `TaskNotes/Tasks/` (first-type wins, matching `task.default_directory`). Calling `rename-node` on that same node without a `directory` param moves the file to `Notes/` (`note.default_directory`). The two tools disagree on which schema's default_directory wins.

**Root cause.** In `src/mcp/tools/rename-node.ts:244-245`:

```typescript
const nodeType = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? LIMIT 1')
  .get(node.node_id) as { schema_type: string } | undefined;
```

The `LIMIT 1` without `ORDER BY` returns whichever row SQLite happens to yield first — implementation-defined, not user-specified. `create-node` uses the explicit `types[0]` from the user's input, which is deterministic.

**Fix.**

- Read the node's full types list in the same order `create-node` would honor (insertion order; add a `sort_order` column on `node_types` if one doesn't already exist).
- Pass the ordered list to `resolveDirectory()` from A2's new `src/schema/paths.ts`. Same helper, same semantics — first type wins.
- Keep the existing fallback to the current directory when no schema has a `default_directory`:
  ```typescript
  const types = readOrderedTypes(db, node.node_id);   // new helper
  const dirResult = resolveDirectory(db, { types, directory: params.directory, override_default_directory: false });
  if (!dirResult.ok) return fail(dirResult.code, dirResult.message);
  const newDir = dirResult.source === 'root' ? dirname(oldFilePath) : dirResult.directory;
  ```
  Note: `resolveDirectory` returns `source: 'root'` when no schema has a default — in that case, preserve the file's current directory (existing behavior).

**Out-of-scope consideration.** Other tools that mutate types (`add-type-to-node`, `remove-type-from-node`, `update-node` with `set_types`) could in principle change which type is "first" and therefore the notional default_directory — but none of them currently move files in response. We're not adding file-move semantics to those tools in this spec; only fixing the existing `rename-node` inconsistency. If a future finding calls for automatic directory reconciliation on type changes, that's its own design question.

**Testing.**

- Integration: extended `tests/mcp/rename-node.test.ts`:
  - Create a multi-typed `[task, note]` node via `create-node`; verify it lands in `TaskNotes/Tasks/`.
  - Rename without `directory` param; verify it stays in `TaskNotes/Tasks/` (not moved to `Notes/`).
  - Rename with explicit `directory`; verify it goes there.
  - Single-typed node rename continues to behave as before.
- Regression: existing single-typed `rename-node` tests pass unchanged.

## Testing strategy summary

- **New unit test files:** `tests/schema/errors.test.ts`, `tests/schema/paths.test.ts`.
- **New or extended integration test files:** `tests/mcp/update-schema.test.ts`, `tests/mcp/batch-mutate.test.ts`, `tests/mcp/rename-node.test.ts`.
- **Regression:** `tests/schema/crud.test.ts`, `tests/schema/propagation.test.ts`, existing `create-node` and single-typed `rename-node` tests pass unchanged.
- **Manual smoke test (post-merge):** retry adding `status` to `note`'s claims; confirm the 10-node `ENUM_INVALID` group appears with offending values enumerated. Also: rename a multi-typed `[task, note]` node and confirm it stays in the first type's default_directory.

## Implementation sequence

Each step is a focused commit. Verify `npm test && npm run build` before moving on.

1. **A1.1** — Create `src/schema/errors.ts`. Refactor `validateClaims` to throw `SchemaValidationError`. Unit tests for each reason.
2. **A1.2** — Refactor `propagateSchemaChange` to collect-all and aggregate per-node failures into `SchemaValidationError`. Integration test seeded with the status-on-note scenario.
3. **A1.3** — Wire `update-schema.ts` handler to surface structured errors in envelope `details`. Integration test for envelope shape.
4. **A2.1** — Create `src/schema/paths.ts::resolveDirectory`. Unit tests covering all six branches.
5. **A2.2** — Refactor `create-node.ts` to use `resolveDirectory`. Regression tests pass unchanged.
6. **A2.3** — Refactor `batch-mutate.ts`: rename `path` → `directory`, add `override_default_directory`, add deprecation warning for `path`, wire `resolveDirectory`. New integration tests.
7. **A3** — Refactor `rename-node.ts` to read ordered types list + use `resolveDirectory`. New integration test for multi-typed rename consistency.
8. **Verify Phase A:** full test suite, manual smoke tests of (a) validation errors via MCP (retry the status-on-note claim), (b) multi-typed rename staying in the first-type directory. Confirm A1 + A2 + A3 all work end-to-end.
9. **Commit Phase A** as one cohesive merge (or PR), ready to ship independently of Phase B.

## Open questions (implementation-time checks)

- Whether any callers other than `create-node`, `batch-mutate`, and `rename-node` rely on inline directory logic — verify during A2.2 and A3.
- Whether `node_types` already has a deterministic ordering (insertion order, a sort_order column, etc.) that can be relied on for A3, or whether a new column is needed. Check the DB schema during A3 — if there's no deterministic ordering today, add a migration.
- Whether `propagateSchemaChange`'s collect-all path has any side-effects that require adjustment when multiple per-node mutations fail sequentially in the same transaction.

## Appendix — referenced source notes

- `Notes/Vault Engine - Schema Operations Safety and Validation Gaps.md` — primary incident narrative.
- `Notes/Vault Engine - batch-mutate create ignores schema default_directory.md` — the batch-mutate bug.
- `Notes/Vault Engine - Charter.md` — single mutation pipeline, data is never silently deleted.
- `Notes/Vault Engine - Expansion Charter.md` — service extraction (Priority #1).
