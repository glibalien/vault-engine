# Schema Ops Phase B — Dry-Run, Confirm Gate, Undo Parity

**Date:** 2026-04-21
**Status:** Draft — ready to plan-and-build (after Phase A is merged)
**Depends on:** Phase A — `2026-04-21-schema-ops-phase-a-design.md`
**Source notes:**
- `Notes/Vault Engine - Schema Operations Safety and Validation Gaps.md`

## Context

Phase A established the diagnostic layer — structured validation errors and the first charter-aligned shared helper. Phase B builds on that foundation to close the safety-default asymmetry between schema ops and node ops. From the incident: *"schema operations have 10–100× the blast radius of node operations but the same safety defaults and the same error envelope."*

Phase B addresses that asymmetry with three interlocking features:

- **Dry-run** so callers can preview the full effect (diff, orphan names, propagation numbers) before committing.
- **Confirmation gate** so any non-zero orphan count requires explicit opt-in.
- **Undo parity** so `update-schema`, `create-schema`, `delete-schema` participate in the existing undo system — both the schema-level state and every per-node propagation change restore atomically under one operation.

These three features share infrastructure: the preview workhorse produces the numbers used both by dry-run and by the confirm gate; the undo integration threads `operation_id` through the same propagation pipeline that dry-run previews. That coupling is why they ship as one phase.

## Pre-requisites

Phase A must be merged before starting Phase B:

- `src/schema/errors.ts` with `SchemaValidationError` and `ValidationGroup` types exist.
- `propagateSchemaChange()` already uses the collect-all-and-throw-SchemaValidationError pattern from A1.2.
- `src/schema/paths.ts` exists (though Phase B doesn't modify it).

If Phase A isn't merged, Phase B's preview function will have nothing clean to build on for structured error output — don't start B until A has landed.

## Scope

**In scope:**

1. **B1 — Dry-run for `update-schema`** (Finding 3a). New `dry_run: boolean` param. Implementation uses a new `previewSchemaChange()` function that runs the real mutation inside a SQLite SAVEPOINT, captures effects, and unconditionally rolls back.
2. **B2 — `confirm_large_change` gate** (Finding 3c). On non-dry-run calls, if the computed (pre-commit) `fields_orphaned > 0`, require `confirm_large_change: true`. Uses the same preview workhorse as B1 to compute numbers.
3. **B3 — Undo parity** (Finding 4). New `undo_schema_snapshots` table + `schema_count` column on `undo_operations`. Tool handler for `update-schema` (and `create-schema`, `delete-schema`) uses `createOperation` → `captureSchemaSnapshot` → mutation (+ propagation with threaded `operation_id`) → `finalizeOperation`. Restore path in `undo-operations` restores schema first, then nodes.

**Out of scope — deferred:**

- Patch-style claim operations (Finding 3b).
- `describe-schema` compact variant (Finding 5).
- Undo for global-field ops (`create-global-field` etc.).

## Architecture overview

Phase B adds two new files, modifies four existing files, and introduces one DB migration:

**New files:**

- `src/schema/preview.ts` — `previewSchemaChange()` used by dry-run, confirm gate, and non-dry-run pre-commit checks.
- `src/undo/schema-snapshot.ts` — `captureSchemaSnapshot()` and `restoreSchemaSnapshot()`.

**Modified files:**

- `src/mcp/tools/update-schema.ts` — adds `dry_run`, `confirm_large_change`; wraps commit block in a single transaction; threads `operation_id`.
- `src/schema/propagate.ts` — `propagateSchemaChange()` gains `{ preview: boolean; operation_id?: string }` options.
- `src/mcp/tools/create-schema.ts` and `src/mcp/tools/delete-schema.ts` — add operation + snapshot capture.
- `src/mcp/tools/undo-operations.ts` (or equivalent) — restore path gains a schema-first pass.
- `src/mcp/tools/errors.ts` — new `CONFIRMATION_REQUIRED` error code.

**DB migration:** `undo_schema_snapshots` table + `undo_operations.schema_count` column.

**Expansion Charter alignment.** All new logic lives in `src/schema/`, `src/undo/`, or is referenced through pure-function helpers — layers that survive service extraction unchanged. `previewSchemaChange()` anticipates the app-API's `POST /query/preview` pattern (Expansion Charter Priority #5).

## B1 — Dry-run for `update-schema`

**Goal.** Let callers preview the full effect of an `update-schema` call — validation outcome, claim diff, orphan names, propagation numbers — before committing.

**New file `src/schema/preview.ts`:**

```typescript
interface PropagationNumbers {
  nodes_affected: number;
  nodes_rerendered: number;
  defaults_populated: number;
  fields_orphaned: number;
}

export type SchemaPreviewResult =
  | {
      ok: true;
      claims_added: string[];
      claims_removed: string[];
      claims_modified: string[];
      orphaned_field_names: Array<{ field: string; count: number }>;
      propagation: PropagationNumbers;
    }
  | {
      ok: false;
      groups: ValidationGroup[];
      claims_added: string[];
      claims_removed: string[];
      claims_modified: string[];
      orphaned_field_names: Array<{ field: string; count: number }>;
      propagation: PropagationNumbers;
    };

export function previewSchemaChange(
  db: Database.Database,
  vaultPath: string,
  name: string,
  proposedUpdate: SchemaUpdateInput
): SchemaPreviewResult;
```

**Implementation — SAVEPOINT rollback.** `previewSchemaChange()` runs the real mutation inside a SQLite SAVEPOINT and *always* rolls back. The sequence:

1. Open SAVEPOINT `preview`.
2. Compute claim diff from current DB state.
3. Run `validateClaims` — on `SchemaValidationError`, set `{ok: false, groups, ...}` and jump to rollback.
4. Apply `updateSchemaDefinition` inside the savepoint.
5. Run `propagateSchemaChange(..., { preview: true })` — see below.
6. If propagation surfaced validation failures, set `{ok: false, ...}`; else `{ok: true, ...}`.
7. In `finally`: `ROLLBACK TO SAVEPOINT preview` then `RELEASE SAVEPOINT preview`.

The rollback is unconditional — this is a preview, not a tentative commit.

**`propagateSchemaChange` gains a `{ preview: boolean }` option:**

- `preview: true`:
  - Render-to-string only; do NOT write files to disk.
  - Do NOT acquire the write-lock.
  - Collect per-node validation failures into `validation_groups` rather than throwing on first hit.
  - Collect orphan field names during the claim-removal pass.
  - Return an augmented `PropagationResult` with `validation_groups` and `orphaned_field_names`.
- `preview: false` (today's Phase-A behavior): unchanged for the happy path; error path aggregates into `SchemaValidationError` (from A1).

**Tool handler changes in `src/mcp/tools/update-schema.ts`.** Add `dry_run: z.boolean().optional()`. Handler becomes (in Phase B the commit path also gets B3 undo threading):

```typescript
const preview = previewSchemaChange(db, ctx.vaultPath, name, rest);

if (dry_run) {
  return preview.ok
    ? ok(pickPreviewSuccessShape(preview))
    : fail('VALIDATION_FAILED', messageFromGroups(preview.groups), { details: preview });
}

if (!preview.ok) {
  return fail('VALIDATION_FAILED', messageFromGroups(preview.groups), { details: preview });
}

// B2 confirm gate lands here (see below)
// Then B3 commit-with-undo flow
```

**Response semantics.** `env.ok` directly answers "would this change succeed?" No `would_succeed` field inside `data`; no two-level check for callers. On dry-run failure, preview data (claim diff, propagation numbers, orphan names) rides in `error.details` alongside `groups`. On dry-run success, the same preview data is in `data`.

**Tool description** must explicitly state: *"When `dry_run: true`, a response with `ok: false` means the change would be rejected if committed — not that the dry-run itself failed. Preview data (claim diff, propagation counts, orphan names) is in `error.details`."*

**Design rationale.**

- SAVEPOINT runs the real code path. Alternative (pure-function preview) would duplicate logic and drift. Cost is running real work that gets rolled back — acceptable for an opt-in preview.
- Non-dry-run commits *always* run the preview first. Extra milliseconds buys single-code-path validation detail, single source of numbers for the confirm gate, and single preview shape shared with dry-run.
- SAVEPOINTs nest cleanly with inner transactions in SQLite, so `updateSchemaDefinition`'s existing internal transaction does not need to change.

**Known constraints.**

- `renderSchemaFile` (the tool's own YAML re-render) is skipped in preview mode. Committed calls still run it.
- Preview does not expose the literal rendered YAML in the response.

**Testing.**

- Unit: `tests/schema/preview.test.ts` — valid change, claim-level invalid, propagation-level invalid (the status-on-note case), display-name-only change (no claim diff). Assert shape correctness for each.
- Integration: `tests/mcp/update-schema.test.ts` — `dry_run: true` returns preview without committing; subsequent `describe-schema` confirms state unchanged.
- Regression: commit path behavior-preserving.

## B2 — `confirm_large_change` gate

**Goal.** Prevent accidental orphaning on non-dry-run `update-schema` calls. Any non-zero `fields_orphaned` requires explicit `confirm_large_change: true`.

**Tool handler additions in `src/mcp/tools/update-schema.ts`.** Add `confirm_large_change: z.boolean().optional()`. Between preview and commit:

```typescript
if (preview.propagation.fields_orphaned > 0 && !confirm_large_change) {
  return fail('CONFIRMATION_REQUIRED',
    `This change would orphan ${preview.propagation.fields_orphaned} field value(s) across ${preview.orphaned_field_names.length} field(s). Set confirm_large_change: true to proceed, or run with dry_run: true to preview.`,
    { details: {
      orphaned_field_names: preview.orphaned_field_names,
      propagation: preview.propagation,
      claims_removed: preview.claims_removed,
    }}
  );
}
```

**New error code `CONFIRMATION_REQUIRED`** in `src/mcp/tools/errors.ts::ErrorCode`. Distinct from `INVALID_PARAMS` — it's a policy gate satisfiable by re-calling with one more flag, not a "fix your data" error.

**No gate on dry-run.** `dry_run: true` always runs the preview; confirmation only applies at commit time.

**Threshold is strict: `fields_orphaned > 0`.** Single orphan triggers the gate. No node-count threshold. Per charter's "data is never silently deleted."

**Workflow.** Preview → confirm → commit is two round-trips minimum. A caller who knows in advance that orphans are acceptable can pass `confirm_large_change: true` on the first call; internal preview runs once and commit proceeds — single call.

**Testing.**

- Integration: `tests/mcp/update-schema.test.ts`:
  - Change with orphans, no `confirm_large_change` → `CONFIRMATION_REQUIRED`; details include `orphaned_field_names`.
  - Same change + `confirm_large_change: true` → succeeds.
  - Change with zero orphans + no `confirm_large_change` → succeeds (gate doesn't fire).
  - Dry-run with orphans, no confirmation → preview returns; gate does not fire.

## B3 — Undo parity for schema ops

**Goal.** `list-undo-history` shows `update-schema`, `create-schema`, `delete-schema` calls. `undo-operations` restores both schema state and every node change propagation produced, atomically, under one `operation_id`.

**Scope:** `update-schema`, `create-schema`, `delete-schema`. Global-field ops deferred.

### New table — `undo_schema_snapshots`

```sql
CREATE TABLE undo_schema_snapshots (
  operation_id       TEXT NOT NULL,
  schema_name        TEXT NOT NULL,
  was_new            INTEGER NOT NULL DEFAULT 0,  -- 1 when op created schema; restore = DELETE
  was_deleted        INTEGER NOT NULL DEFAULT 0,  -- 1 when op deleted schema; restore = re-INSERT
  display_name       TEXT,
  icon               TEXT,
  filename_template  TEXT,
  default_directory  TEXT,
  metadata           TEXT,  -- JSON
  field_claims       TEXT,  -- JSON array of pre-change claims
  PRIMARY KEY (operation_id, schema_name),
  FOREIGN KEY (operation_id) REFERENCES undo_operations(id) ON DELETE CASCADE
);

ALTER TABLE undo_operations ADD COLUMN schema_count INTEGER NOT NULL DEFAULT 0;
```

Per the migration-ordering rule — `CREATE INDEX` on any new column lives in the migration, not in the `CREATE TABLE IF NOT EXISTS` path.

### New helper — `src/undo/schema-snapshot.ts`

```typescript
export function captureSchemaSnapshot(
  db: Database.Database,
  operation_id: string,
  schema_name: string,
  opts?: { was_new?: boolean; was_deleted?: boolean }
): void;

export function restoreSchemaSnapshot(
  db: Database.Database,
  vaultPath: string,
  operation_id: string,
  schema_name: string
): void;
```

- `captureSchemaSnapshot`: reads current `schemas` + `schema_field_claims` rows, serializes claims as JSON, inserts into `undo_schema_snapshots` with `INSERT OR IGNORE` (idempotent for multi-call tool handlers sharing an `operation_id`).
- `restoreSchemaSnapshot`:
  - `was_new=1` → `DELETE FROM schemas WHERE name = ?` (cascades to `schema_field_claims`); delete the schema's on-disk YAML file via `safeVaultPath`-guarded unlink.
  - `was_deleted=1` → INSERT schema row + claims from snapshot; `renderSchemaFile()` to rewrite YAML.
  - Otherwise → UPDATE `schemas` row to snapshot values; DELETE + re-INSERT `schema_field_claims`; `renderSchemaFile()` to rewrite YAML.

### Thread `operation_id` through propagation

```typescript
// src/schema/propagate.ts — extended signature
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schema_name: string,
  diff: ClaimDiff,
  syncLogger: SyncLogger | null,
  opts?: { operation_id?: string; preview?: boolean }
): PropagationResult;
```

When `operation_id` is present, each `executeMutation` call inside propagation receives `undoContext: { operation_id }`. Existing per-node snapshot capture then ties to the schema operation automatically.

### Tool handler flows

**`update-schema.ts`** — order matters: all early-return checks run *before* `createOperation`, so dry-run and failed commits don't pollute undo history:

```typescript
// Preview first — no operation_id needed, no side effects.
const preview = previewSchemaChange(db, ctx.vaultPath, name, rest);
if (!preview.ok) {
  return fail('VALIDATION_FAILED', messageFromGroups(preview.groups), { details: preview });
}
if (preview.propagation.fields_orphaned > 0 && !confirm_large_change) {
  return fail('CONFIRMATION_REQUIRED', /* message */, { details: { /* B2 details */ } });
}
if (dry_run) return ok(pickPreviewSuccessShape(preview));

// Commit path — only now do we open an operation.
const operation_id = createOperation(db, {
  source_tool: 'update-schema',
  description: `update-schema: ${name}${rest.field_claims ? ` (+${preview.claims_added.length}/-${preview.claims_removed.length}/~${preview.claims_modified.length} claims)` : ''}`,
});

let result: SchemaDefinition;
let propagation: PropagationResult | undefined;
try {
  db.transaction(() => {
    captureSchemaSnapshot(db, operation_id, name);
    result = updateSchemaDefinition(db, name, rest);
    if (rest.field_claims && ctx?.writeLock && ctx?.vaultPath) {
      const oldClaims = readCurrentClaims(db, name);
      const newClaims = buildNewClaims(rest.field_claims);
      const diff = diffClaims(oldClaims, newClaims);
      propagation = propagateSchemaChange(
        db, ctx.writeLock, ctx.vaultPath, name, diff, ctx.syncLogger,
        { operation_id }
      );
    }
  })();

  if (ctx?.vaultPath) renderSchemaFile(db, ctx.vaultPath, name);
  return ok({ ...result!, propagation, operation_id });
} finally {
  finalizeOperation(db, operation_id);
}
```

**Note on `diff` scope.** `diff` is recomputed inside the transaction rather than pulled from the preview. The preview ran against the pre-savepoint DB state and rolled back. By the time we reach the commit path, we re-read current claims to ensure `diff` reflects exactly what's about to happen in this transaction.

**`create-schema.ts`:** `createOperation` → `captureSchemaSnapshot(..., {was_new: true})` → existing create logic → `finalizeOperation`. Restore = DELETE schema.

**`delete-schema.ts`:** `createOperation` → `captureSchemaSnapshot(..., {was_deleted: true})` (captures full pre-delete state) → existing delete logic → `finalizeOperation`. Restore = re-INSERT schema + claims.

### Dry-run and operation creation

Dry-run paths **do not create an operation** at all. `dry_run: true` returns the preview before reaching `createOperation`. Avoids polluting undo history with no-op entries and removes reliance on background orphan sweep.

### Restore path in `undo-operations` tool

Existing tool iterates `undo_snapshots` (node level). Extend with a schema-restore pass that runs **before** node restores:

```typescript
const schemaSnapshots = db.prepare('SELECT schema_name FROM undo_schema_snapshots WHERE operation_id = ?').all(op_id);
for (const snap of schemaSnapshots) {
  restoreSchemaSnapshot(db, vaultPath, op_id, snap.schema_name);
}
for (const nodeSnap of nodeSnapshots) { /* existing restore */ }
```

**Order is load-bearing.** Restoring nodes re-runs validation against the schema. Schema-first means nodes are validated against the pre-change schema.

### `list-undo-history` cosmetic changes

Include `schema_count` alongside `node_count`:

```json
{
  "operation_id": "...",
  "source_tool": "update-schema",
  "description": "update-schema: note (+1/-1/~0 claims)",
  "node_count": 36,
  "schema_count": 1,
  "created_at": "..."
}
```

### Transaction wrapping (explicit in-scope work)

Today's `update-schema` handler does not wrap `updateSchemaDefinition` + `propagateSchemaChange` in a single outer transaction. Each sub-call has its own inner transaction, which is fine for consistency within each call but leaves us exposed if propagation throws partway through: schema changed, some nodes propagated, snapshot captured, but no rollback.

**Required:** wrap the commit block (`captureSchemaSnapshot` → `updateSchemaDefinition` → `propagateSchemaChange`) in an outer `db.transaction(() => {...})`. SQLite nested transactions resolve as savepoints, so inner transactions continue to work. A throw anywhere in the block rolls back all four state changes atomically.

**Out-of-transaction work:** `renderSchemaFile` (filesystem write) stays outside the transaction. A failure there leaves DB consistent but disk stale — accepted status quo (node restore paths have the same exposure).

### Testing

- Unit: `tests/undo/schema-snapshot.test.ts` — capture+restore roundtrip for update/create/delete cases.
- Integration: `tests/mcp/update-schema.test.ts` — claim change with propagation, `list-undo-history` shows the op, `undo-operations` restores schema + node state.
- Integration: validation-rejecting commit leaves no half-finalized operation behind (transaction rollback).
- Regression: existing node-level undo tests pass.

### Risks

- **Transaction wrapping breaks an internal assumption.** Highest implementation risk in this phase. Need to confirm during work that no sub-call assumes it owns the outermost transaction.
- **Snapshot bloat.** Schema change affecting 1000 nodes → 1000 node snapshots + 1 schema snapshot. Matches existing bulk undo behavior. 24h retention sweep handles it.
- **`renderSchemaFile` outside transaction** — accepted status quo.

## Testing strategy summary

- **New unit test files:** `tests/schema/preview.test.ts`, `tests/undo/schema-snapshot.test.ts`.
- **Extended integration files:** `tests/mcp/update-schema.test.ts` (dry-run shape, confirm gate, undo roundtrip).
- **Regression:** all Phase A tests + node-level undo tests pass unchanged.
- **Manual smoke test (post-merge):** do a schema change that orphans values; verify dry-run preview, then verify confirm gate blocks without flag, then verify commit + undo roundtrip restores both schema and node state.

## Implementation sequence

Each step is a focused commit. Verify `npm test && npm run build` before moving on.

1. **B1.1** — Add `{preview: boolean}` option to `propagateSchemaChange`; implement preview mode (no writes, no lock, collect-all validation, collect orphan names).
2. **B1.2** — Create `src/schema/preview.ts::previewSchemaChange` (SAVEPOINT-based). Unit tests for each outcome (valid/claim-invalid/propagation-invalid/display-only).
3. **B1.3** — Wire `dry_run` param into `update-schema.ts`. Integration test: dry-run does not commit.
4. **B2** — Add `CONFIRMATION_REQUIRED` error code to `src/mcp/tools/errors.ts`. Wire `confirm_large_change` gate into `update-schema.ts`. Integration tests.
5. **B3.1** — Migration: `undo_schema_snapshots` table + `undo_operations.schema_count` column.
6. **B3.2** — Create `src/undo/schema-snapshot.ts::captureSchemaSnapshot` and `restoreSchemaSnapshot`. Unit tests for all three cases (update/create-new/delete).
7. **B3.3** — Thread `operation_id` through `propagateSchemaChange` to the inner per-node mutation call.
8. **B3.4** — Wrap commit block in `update-schema.ts` in a single `db.transaction`. Wire schema snapshot capture.
9. **B3.5** — Extend `create-schema.ts` and `delete-schema.ts` with operation + snapshot capture.
10. **B3.6** — Extend `undo-operations` tool restore path (schema-first, then nodes).
11. **B3.7** — Extend `list-undo-history` to surface `schema_count`.
12. **Verify Phase B:** full test suite, manual undo roundtrip test (do a real orphaning update, then undo; confirm schema state + node state both restore).
13. **Commit Phase B.**

## Open questions (implementation-time checks)

- **Transaction nesting verification.** During step 8, confirm no downstream call assumes it owns the outermost transaction. If any do, either loosen that assumption or adjust the wrapping strategy.
- **`renderSchemaFile` delete semantics.** For the `was_new=1` restore case, use `safeVaultPath` to guard against path-traversal edge cases and no-op cleanly if the file is already gone.

## Appendix — referenced source notes

- `Notes/Vault Engine - Schema Operations Safety and Validation Gaps.md` — primary incident narrative (Findings 2, 3a, 3c, 4).
- `Notes/Vault Engine - Charter.md` — data is never silently deleted; single mutation pipeline.
- `Notes/Vault Engine - Expansion Charter.md` — service extraction (Priority #1), `POST /query/preview` pattern (Priority #5).
