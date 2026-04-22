# Schema Ops Safety & Validation Gaps — Design

**Date:** 2026-04-21
**Status:** Draft — pending review
**Source notes:**
- `Notes/Vault Engine - Schema Operations Safety and Validation Gaps.md`
- `Notes/Vault Engine - batch-mutate create ignores schema default_directory.md`

## Context

A session adding a `context` claim to the `note` schema exposed a cascade of gaps in the schema-ops surface:

- `update-schema`'s opaque `"Validation failed"` error made debugging impossible from the MCP surface, turning a 1-minute change into a multi-step investigation.
- The atomic-replace semantics of `field_claims` silently orphaned values across 36 notes during probe attempts to isolate the failure.
- Schema operations were absent from `list-undo-history`, so recovery required manual state reconstruction.
- In parallel, `batch-mutate` create ops were found to ignore schema `default_directory`, placing files in the vault root rather than their schema-configured location.

The meta-observation from the incident: schema operations have 10–100× the blast radius of node operations but the same safety defaults and the same error envelope. This spec closes that asymmetry.

Prioritization was agreed in advance (recorded in the first source note). This spec covers six findings, grouped into two implementation phases.

## Scope

**In scope (six findings):**

1. Structured validation errors on schema ops (Finding 2).
2. Diagnosis of "note can't claim status" — reduces entirely to Finding 2 once errors are legible; no separate code fix.
3. `batch-mutate` create respects schema `default_directory` (the batch-mutate bug note).
4. Dry-run for `update-schema` (Finding 3a).
5. `confirm_large_change` gate for schema ops that would orphan data (Finding 3c).
6. Undo parity for schema ops — covering `update-schema`, `create-schema`, `delete-schema` (Finding 4).

**Out of scope (deferred):**

- Patch-style claim operations (`add_field_claims`, `remove_field_claims`, `update_field_claim`) — Finding 3b. Once the other guardrails are in place, the atomic-replace foot-gun is largely defanged. Patch-style is ergonomic polish rather than damage prevention.
- `describe-schema` compact variant (Finding 5) — separate concern, tracked in its own note.
- Undo for global-field ops (`create-global-field`, `update-global-field`, `delete-global-field`, `rename-global-field`). Different blast-radius profile; deserves its own pass.

## Architecture overview

Six findings land primarily in three files (`update-schema.ts`, `create-node.ts`, `batch-mutate.ts`), with supporting infrastructure in five new files.

**New files:**

- `src/schema/errors.ts` — `SchemaValidationError` class, `ValidationGroup` type, grouping utilities.
- `src/schema/paths.ts` — shared directory resolver (charter-aligned location; survives service extraction).
- `src/schema/preview.ts` — `previewSchemaChange()` used by dry-run, confirm gate, and non-dry-run pre-commit checks.
- `src/undo/schema-snapshot.ts` — `captureSchemaSnapshot()` and `restoreSchemaSnapshot()`.
- One DB migration for `undo_schema_snapshots` table and `undo_operations.schema_count` column.

**Expansion Charter alignment.** All new logic lives in `src/schema/`, `src/undo/`, or is referenced through pure-function helpers — layers that survive the forthcoming service extraction (Expansion Charter Priority #1). No transport-layer coupling. `previewSchemaChange()` also anticipates the app-API's `POST /query/preview` pattern from Expansion Charter Priority #5.

**Two-phase delivery:**

- **Phase A** (diagnostic + quick wins) ships independently: structured errors + batch-mutate directory fix. Resolves Findings 1–3.
- **Phase B** (safety guardrails) builds on A: dry-run, confirm gate, undo parity. Resolves Findings 4–6.

Each phase ends with verify + commit. Phase A is small enough to complete in a single implementation pass; Phase B is roughly twice as large and may benefit from splitting across sub-commits per finding.

## Phase A

### A1 — Structured validation errors (Findings 1 + 2)

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

**Finding 1 diagnosis (for the record).** The status-on-note claim failure has a data cause: 10 of the 16 notes with orphaned status values hold enum-invalid values (`active`, `draft`, `spec`, `complete`) relative to the current enum (`open, in-progress, pending, done, dropped, backlog, next`). Propagation validation correctly rejects the re-claim; the failure was only opaque because the error surface didn't report *which* nodes failed *which* check. With A1 in place, the next attempt at adding `status` to `note`'s claims will surface this data directly. No additional code change is needed for Finding 1.

**Testing.**

- Unit: `tests/schema/crud.test.ts` extensions covering each reason.
- Unit: new `tests/schema/errors.test.ts` for grouping utility (aggregate counts, sample truncation, enum value rollup).
- Integration: new `tests/mcp/update-schema.test.ts` — seed 10 notes with invalid status values, attempt claim, assert envelope shape.

**Risks.**

- `propagateSchemaChange` switching from first-fail to collect-all does extra work in failed calls. Healthy calls are unaffected.
- Non-validation errors (DB constraint, I/O) continue to funnel through `INVALID_PARAMS` / `INTERNAL`. Only validation gets the specialized path.

### A2 — `batch-mutate` directory resolution (batch-mutate bug note)

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

**Filename-template support in `batch-mutate` create is out of scope** for this spec — batch-mutate has never supported templates and directory placement is the active bug. Keep `${title}.md` as-is.

**Tool description update on `batch-mutate`** — note that `directory` defaults to the schema's `default_directory` when unspecified, matching `create-node`.

**Deprecation timeline.** `path` alias stays for one release (CHANGELOG entry), then removed. Low cost since Barry is effectively the only caller.

**Testing.**

- Unit: `tests/schema/paths.test.ts` covers all six branches of `resolveDirectory` (explicit, default, root, conflict, not-a-folder, no-schema).
- Integration: new or extended `tests/mcp/batch-mutate.test.ts`:
  - create, no `directory`, schema with `default_directory` → file lands in schema dir.
  - create, with `directory`, schema with `default_directory`, no override → fails.
  - create, `directory` + `override_default_directory: true` → file lands in `directory`.
  - create, deprecated `path` only → succeeds with warning.
  - create, both `path` and `directory` → fails with `INVALID_PARAMS`.
- Regression: existing `create-node` tests pass unchanged.

## Phase B

### B1 — Dry-run for `update-schema` (Finding 3a)

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
- `preview: false` (today's behavior): unchanged for the happy path; error path aggregates into `SchemaValidationError` per A1.

**Tool handler changes in `src/mcp/tools/update-schema.ts`.** Add `dry_run: z.boolean().optional()`. Handler becomes:

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

// (B2 confirm gate lands here)
// ... existing commit path with B3 undo threading ...
```

**Response semantics.** `env.ok` directly answers "would this change succeed?" No `would_succeed` field inside `data`; no two-level check for callers. On dry-run failure, preview data (claim diff, propagation numbers, orphan names) rides in `error.details` alongside `groups`. On dry-run success, the same preview data is in `data`.

**Tool description** must explicitly state: *"When `dry_run: true`, a response with `ok: false` means the change would be rejected if committed — not that the dry-run itself failed. Preview data (claim diff, propagation counts, orphan names) is in `error.details`."*

**Design rationale.**

- SAVEPOINT runs the real code path. Alternative (pure-function preview) would duplicate logic and drift. Cost is running real work that gets rolled back — acceptable for an opt-in preview.
- Non-dry-run commits *always* run the preview first. Extra milliseconds buys single-code-path validation detail (A1), single source of numbers for the confirm gate (B2), and single preview shape shared with dry-run.
- SAVEPOINTs nest cleanly with inner transactions in SQLite, so `updateSchemaDefinition`'s existing internal transaction does not need to change.

**Known constraints.**

- `renderSchemaFile` (the tool's own YAML re-render) is skipped in preview mode. Committed calls still run it.
- Preview does not expose the literal rendered YAML in the response. If ever wanted, add later.

**Testing.**

- Unit: `tests/schema/preview.test.ts` — valid change, claim-level invalid, propagation-level invalid (the status-on-note case), display-name-only change (no claim diff). Assert shape correctness for each.
- Integration: `tests/mcp/update-schema.test.ts` — `dry_run: true` returns preview without committing; subsequent `describe-schema` confirms state unchanged.
- Regression: commit path behavior-preserving.

### B2 — `confirm_large_change` gate (Finding 3c)

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

**Threshold is strict: `fields_orphaned > 0`.** Single orphan triggers the gate. No node-count threshold. Per the original prioritization note — charter's "data is never silently deleted" governs.

**Workflow.** Preview → confirm → commit is two round-trips minimum. A caller who knows in advance that orphans are acceptable can pass `confirm_large_change: true` on the first call; internal preview runs once and commit proceeds — single call.

**Testing.**

- Integration: `tests/mcp/update-schema.test.ts`:
  - Change with orphans, no `confirm_large_change` → `CONFIRMATION_REQUIRED`; details include `orphaned_field_names`.
  - Same change + `confirm_large_change: true` → succeeds.
  - Change with zero orphans + no `confirm_large_change` → succeeds (gate doesn't fire).
  - Dry-run with orphans, no confirmation → preview returns; gate does not fire.

### B3 — Undo parity for schema ops (Finding 4)

**Goal.** `list-undo-history` shows `update-schema`, `create-schema`, `delete-schema` calls. `undo-operations` restores both schema state and every node change propagation produced, atomically, under one `operation_id`.

**Scope:** `update-schema`, `create-schema`, `delete-schema`. Global-field ops deferred.

#### New table — `undo_schema_snapshots`

```sql
-- migration (respect migration-ordering rule: CREATE INDEX in migration, not createSchema)
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

#### New helper — `src/undo/schema-snapshot.ts`

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

#### Thread `operation_id` through propagation

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

#### Tool handler flows

**`update-schema.ts`:**

Order matters: all early-return checks (validation, confirmation, dry-run) run **before** `createOperation`, so no undo-history pollution. Only committing paths create an operation. The `diff` and `result` outer-scope captures let the transaction closure write back into handler-scope variables.

```typescript
// Preview first — no operation_id needed, no side effects.
const preview = previewSchemaChange(db, ctx.vaultPath, name, rest);
if (!preview.ok) {
  return fail('VALIDATION_FAILED', messageFromGroups(preview.groups), { details: preview });
}
if (preview.propagation.fields_orphaned > 0 && !confirm_large_change) {
  return fail('CONFIRMATION_REQUIRED', /* message */, { details: { /* see B2 */ } });
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
      const oldClaims = readCurrentClaims(db, name);   // re-read inside txn for diff construction
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

**Note:** `diff` is recomputed inside the transaction rather than pulled from the preview. Reason: the preview ran against the pre-savepoint DB state and rolled back. By the time we reach the commit path, we re-read current claims to ensure `diff` reflects exactly what's about to happen in this transaction. (Preview's claim-name arrays are still safe for the description string, since those name lists are stable across re-read unless the caller raced.)

**`create-schema.ts`:** `createOperation` → `captureSchemaSnapshot(..., {was_new: true})` → existing create logic → `finalizeOperation`. Restore = DELETE schema.

**`delete-schema.ts`:** `createOperation` → `captureSchemaSnapshot(..., {was_deleted: true})` (captures full pre-delete state) → existing delete logic → `finalizeOperation`. Restore = re-INSERT schema + claims.

#### Dry-run and operation creation

Dry-run paths **do not create an operation** at all. `dry_run: true` returns the preview before reaching `createOperation`. Avoids polluting undo history with no-op entries and removes reliance on background orphan sweep.

#### Restore path in `undo-operations` tool

Existing tool iterates `undo_snapshots` (node level). Extend with a schema-restore pass that runs **before** node restores:

```typescript
const schemaSnapshots = db.prepare('SELECT schema_name FROM undo_schema_snapshots WHERE operation_id = ?').all(op_id);
for (const snap of schemaSnapshots) {
  restoreSchemaSnapshot(db, vaultPath, op_id, snap.schema_name);
}
for (const nodeSnap of nodeSnapshots) { /* existing restore */ }
```

**Order is load-bearing.** Restoring nodes re-runs validation against the schema. Schema-first means nodes are validated against the pre-change schema.

#### `list-undo-history` cosmetic changes

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

#### Transaction wrapping (explicit in-scope work)

Today's `update-schema` handler does not wrap `updateSchemaDefinition` + `propagateSchemaChange` in a single outer transaction. Each sub-call has its own inner transaction, which is fine for consistency within each call but leaves us exposed if propagation throws partway through: schema changed, some nodes propagated, snapshot captured, but no rollback.

**Required:** wrap the commit block (`captureSchemaSnapshot` → `updateSchemaDefinition` → `propagateSchemaChange`) in an outer `db.transaction(() => {...})`. SQLite nested transactions resolve as savepoints, so inner transactions continue to work. A throw anywhere in the block rolls back all four state changes atomically.

**Out-of-transaction work:** `renderSchemaFile` (filesystem write) stays outside the transaction. A failure there leaves DB consistent but disk stale — accepted status quo (node restore paths have the same exposure).

#### Testing

- Unit: `tests/undo/schema-snapshot.test.ts` — capture+restore roundtrip for update/create/delete cases.
- Integration: `tests/mcp/update-schema.test.ts` — claim change with propagation, `list-undo-history` shows the op, `undo-operations` restores schema + node state.
- Integration: validation-rejecting commit leaves no half-finalized operation behind (transaction rollback).
- Regression: existing node-level undo tests pass.

#### Risks

- **Transaction wrapping breaks an internal assumption.** Highest implementation risk in this spec. Need to confirm during work that no sub-call assumes it owns the outermost transaction.
- **Snapshot bloat.** Schema change affecting 1000 nodes → 1000 node snapshots + 1 schema snapshot. Matches existing bulk undo behavior. 24h retention sweep handles it.
- **`renderSchemaFile` outside transaction** — accepted status quo, see above.

## Testing strategy summary

- **Unit:** new test files for `errors.ts`, `paths.ts`, `preview.ts`, `schema-snapshot.ts`. Each covers the branches of its component.
- **Integration:** new `tests/mcp/update-schema.test.ts` and extended `tests/mcp/batch-mutate.test.ts`. These cover end-to-end tool behavior, envelope shapes, and undo roundtrips — the codebase currently lacks tool-level tests for `update-schema`.
- **Regression:** existing `tests/schema/crud.test.ts`, `tests/schema/propagation.test.ts`, `tests/validation/validate.test.ts`, and node-level undo tests continue to pass.
- **Manual smoke test (post-merge):** retry adding `status` to `note`'s claims with detailed errors in place; confirm the 10-node ENUM_INVALID group appears as designed.

## Implementation sequence

Each step is a focused commit. Verify `npm test && npm run build` before moving on.

**Phase A:**

1. A1.1 — Create `src/schema/errors.ts`. Refactor `validateClaims` to throw `SchemaValidationError`. Unit tests.
2. A1.2 — Refactor `propagateSchemaChange` to collect-all and aggregate into `SchemaValidationError`. Integration test (status-on-note scenario).
3. A1.3 — Wire `update-schema.ts` handler to surface structured errors.
4. A2.1 — Create `src/schema/paths.ts::resolveDirectory`. Unit tests.
5. A2.2 — Refactor `create-node.ts` to use `resolveDirectory`. Regression tests.
6. A2.3 — Refactor `batch-mutate.ts`: rename `path` → `directory`, add `override_default_directory`, add deprecation warning, wire `resolveDirectory`. Integration tests.
7. Verify Phase A: full test suite, manual smoke test of validation errors via MCP.
8. Commit Phase A.

**Phase B:**

9. B1.1 — Add `{preview: boolean}` option to `propagateSchemaChange`; implement preview mode.
10. B1.2 — Create `src/schema/preview.ts::previewSchemaChange` (SAVEPOINT-based).
11. B1.3 — Wire `dry_run` param into `update-schema.ts`. Integration test.
12. B2 — Add `CONFIRMATION_REQUIRED` error code. Wire `confirm_large_change` gate into `update-schema.ts`. Integration test.
13. B3.1 — Migration: `undo_schema_snapshots` table + `schema_count` column.
14. B3.2 — Create `src/undo/schema-snapshot.ts::captureSchemaSnapshot` and `restoreSchemaSnapshot`. Unit tests.
15. B3.3 — Thread `operation_id` through `propagateSchemaChange` to the inner per-node mutation call.
16. B3.4 — Wrap commit block in `update-schema.ts` in a single `db.transaction`. Wire schema snapshot capture.
17. B3.5 — Extend `create-schema.ts` and `delete-schema.ts` with operation + snapshot capture.
18. B3.6 — Extend `undo-operations` tool restore path (schema-first, then nodes).
19. B3.7 — Extend `list-undo-history` to surface `schema_count`.
20. Verify Phase B: full test suite, manual undo roundtrip test.
21. Commit Phase B.

## Open questions

All substantive decisions resolved during brainstorming. The remaining items are implementation-time checks, not design questions:

- **Transaction nesting verification.** During step 16, confirm no downstream call assumes it owns the outermost transaction. If any do, either loosen that assumption or adjust the wrapping strategy.
- **`renderSchemaFile` delete semantics.** For the `was_new=1` restore case, we need to delete the on-disk YAML. Implementation should use `safeVaultPath` to guard against path-traversal edge cases and no-op cleanly if the file is already gone.

## Appendix — referenced source notes

- `Notes/Vault Engine - Schema Operations Safety and Validation Gaps.md` — primary incident narrative and proposed changes (Findings 1–5).
- `Notes/Vault Engine - batch-mutate create ignores schema default_directory.md` — the batch-mutate bug.
- `Notes/Vault Engine - Charter.md` — original charter: single mutation pipeline, data is never silently deleted, DB-as-truth.
- `Notes/Vault Engine - Expansion Charter.md` — service extraction (Priority #1), app-API `POST /query/preview` pattern (Priority #5).
