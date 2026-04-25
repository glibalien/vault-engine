# Uniform `dry_run` Across Mutation Tools

**Date:** 2026-04-25
**Status:** Draft — ready to plan-and-build
**Addresses:** [Architecture Review 2026-04-18](2026-04-18-architecture-review.md) finding §3c

## Goal

Add `dry_run: false` (default) to the four mutation tools that currently lack it: `delete-node`, `add-type-to-node`, `remove-type-from-node`, `batch-mutate`. The parameter is orthogonal to existing `confirm` semantics — `confirm` continues to gate destructive operations; `dry_run` is the explicit "preview without applying" signal.

## Scope

**In:**
- `dry_run: z.boolean().default(false)` on all four tools.
- Per-tool preview branches that short-circuit before any DB or file write.
- Tool description updates noting the new parameter.
- Tests for each tool's dry-run path plus a `batch-mutate` composed-ops test.

**Out:**
- Flipping `update-node` query-mode `dry_run` default from `true` to `false`. Documented here as a known asymmetry; revisit independently.
- A shared `dry_run` abstraction. Each tool's preview shape is slightly different; the existing per-tool inline pattern in `create-node` / `update-node` is the precedent.

## Design

### Convention

When `dry_run: true`, every tool returns:

```ts
{ dry_run: true, ...tool_specific_preview_fields }
```

Validation issues, deprecation warnings, and `LAST_TYPE_REMOVAL`-style warnings flow through the standard envelope `warnings` array — they are not duplicated in the data payload. No DB writes, no file writes, no `createOperation`/`finalizeOperation` calls (no real op to record).

### `delete-node`

- Add `dry_run: z.boolean().default(false)`.
- When `dry_run: true`: return the same preview payload the existing `confirm: false` branch already produces — `{ dry_run: true, node_id, file_path, title, types, field_count, relationship_count, incoming_reference_count, referencing_nodes }` plus the `PENDING_REFERENCES` warning if applicable. Do not require a follow-up `confirm: true`.
- When `dry_run: false`: existing behavior unchanged. `confirm: false` still produces the safety preview; `confirm: true` still deletes.
- **Edge case:** `dry_run: true, confirm: true` → still returns the preview. `dry_run` wins because it is the explicit "do not apply" signal.
- **Flag asymmetry (intentional).** The `confirm: false` safety preview keeps its existing flagless shape (no `dry_run` field). The `dry_run: true` preview adds `dry_run: true`. The two paths are semantically distinct — confirm-gated means "I'm gating you, please confirm"; dry_run means "the caller asked to preview" — and the flag only appears when the caller asked for it.

### `add-type-to-node`

- Add `dry_run: z.boolean().default(false)`.
- When `dry_run: true`: build the preview by running existing logic up to (but not including) `executeMutation`. Specifically:
  - Resolve identity, run `checkTypesHaveSchemas`, load current state.
  - If the type is already present, return `{ dry_run: true, would_be_no_op: true, types: currentTypes }`.
  - Otherwise compute `newTypes`, run `populateDefaults`, detect `readoptedFields`, build the merged-fields snapshot.
  - Call `loadSchemaContext` + `validateProposedState` (same approach as `create-node` dry-run) to surface validation issues.
  - Return `{ dry_run: true, types: newTypes, would_add_fields, would_readopt_fields, would_be_no_op: false }` plus `validation.issues` and any `UNKNOWN_TYPE` errors via `warnings` / failure envelope.

### `remove-type-from-node`

- Add `dry_run: z.boolean().default(false)`.
- When `dry_run: true`: return `{ dry_run: true, current_types, removing_type, resulting_types, would_orphan_fields }` for any removal — not just the last-type case the existing `confirm` gate handles.
- The existing last-type confirmation gate (`confirm: false` + `resultingTypes.length === 0` → preview with `LAST_TYPE_REMOVAL` warning) stays as-is. The two paths can both return preview shapes; the warning surfaces in either case.
- **Edge case:** dry-run on a last-type removal still emits the `LAST_TYPE_REMOVAL` warning so callers see the destructive nature in a single round-trip.

### `batch-mutate`

The composed-ops case requires a transaction-and-rollback approach so op N can see the in-flight effects of ops 1..N-1. Per-op preview without a transaction would mis-report any sequence like `[create X, update X]` because op 2 wouldn't see op 1's result.

- Add `dry_run: z.boolean().default(false)`.
- When `dry_run: true`:
  - **Undo gating.** Skip `createOperation` entirely (no `operation_id` is generated). Pass `operation_id: undefined` to every `executeMutation` / `executeDeletion` call inside the txn so undo snapshots are not captured. Skip `finalizeOperation` — the `finally` block becomes conditional on `!dry_run` (or guards on `if (operation_id)`). Rationale: a preview leaves zero traces in `undo_operations` / `undo_snapshots`.
  - **File backup gating.** Skip `backupFile` calls in update and delete branches. With `db_only: true` on update mutations and `unlink_file: false` on delete ops, no physical file write occurs, so nothing needs reverting. Consequence on the catch path: `backups[]` is empty (the `restoreFile` loop is a no-op) and `createdFiles[]` is empty (`result.file_written` is `false` under `db_only: true`, so the push at the create branch never fires).
  - Open the existing `db.transaction(() => { ... })` callback as today.
  - For each `executeMutation` invocation (create / update ops), set `db_only: true` on the mutation. This already-existing flag suppresses file writes (used by the watcher path); it is semantically appropriate here because the txn will be rolled back regardless.
  - For delete ops, set `unlink_file: false` on the `executeDeletion` call — do not change `executeDeletion`'s signature. The DB-side cascade still runs (and gets rolled back).
  - Build a closure-captured `would_apply: WouldApplyEntry[]` array, populated as each op's pipeline call returns (shape below). The array survives the txn rollback because it's plain JS state, not DB state.
  - At the end of the txn callback, throw a `DryRunRollback` sentinel (a typed error class local to `batch-mutate.ts`) to force `ROLLBACK`.
  - Catch the sentinel in the outer handler. Return `{ dry_run: true, op_count, would_apply }` with deprecation warnings preserved.
- **Edge case (failing op inside dry-run txn):** transaction rolls back as today, but the response is `ok: true` with `{ dry_run: true, failed_at, op, message, would_apply: [...partial] }`. The error surfaces as inline data rather than a failure envelope so callers can see how far the preview got and what blocked it. Mirrors the contract that "preview" never returns a hard error for the work itself — only for invalid params.
- Deprecation warnings (`path` → `directory`) surface in dry-run identically to the live path.

#### `would_apply` entry shapes

```ts
type WouldApplyEntry =
  | { op: 'create'; node_id: string; file_path: string; title: string }
  | { op: 'update'; node_id: string; file_path: string;
      fields_changed: string[]; types_after?: string[];
      body_changed: boolean; title_changed: boolean }
  | { op: 'delete'; node_id: string; file_path: string;
      incoming_reference_count: number;
      referencing_nodes: Array<{ node_id: string; title: string; file_path: string }> };
```

All four update-entry change-indicators (`fields_changed`, `types_after`, `body_changed`, `title_changed`) report **actual** differences between current and proposed state, not whether the op specified the relevant param. A no-op param (e.g. `set_types: [...currentTypes]`, `set_body` with identical content) yields no entry / `false`.

- **`create.node_id`** is ephemeral — assigned during the rolled-back txn and will differ on a real run (IDs are random nanoids). Documented but emitted because `executeMutation` returns it; callers should not treat it as a stable identifier.
- **`update.fields_changed`** is the list of field names whose values differ between current and proposed state, including additions, modifications, and `set_fields: { x: null }` deletions. Names only — no before/after values, to keep payload bounded for large batches.
- **`update.types_after`** is present iff types would actually change; absent when the resolved type set equals the current type set.
- **`update.body_changed` / `update.title_changed`** are `true` iff the resolved body / title differs from current.
- **`delete.referencing_nodes`** is capped at 10 (matches `delete-node` standalone preview); `incoming_reference_count` is the unbounded total.

## Implementation Order

1. **`delete-node`** — rewires existing preview branch into a `dry_run`-gated preview. Smallest change.
2. **`remove-type-from-node`** — generalizes the existing `confirm:false → preview` branch. Last-type gate stays orthogonal.
3. **`add-type-to-node`** — new preview branch using `loadSchemaContext` + `validateProposedState`.
4. **`batch-mutate`** — txn-and-rollback with `db_only: true` and the `DryRunRollback` sentinel. Most involved.

Each step ships with its own tests; bisect-able commits per tool.

## Tool Description Updates

- `delete-node`: add `"Use dry_run: true to preview without applying. dry_run is independent of confirm — dry_run: true always previews."`
- `add-type-to-node`: add `"Use dry_run: true to preview the type addition and field defaults without applying."`
- `remove-type-from-node`: add `"Use dry_run: true to preview the removal and orphaned fields without applying."`
- `batch-mutate`: add `"Use dry_run: true to preview the entire batch atomically (composed effects via SAVEPOINT-style rollback) without applying."`

## Tests

Per tool, verify:
- `dry_run: true` returns a payload with `dry_run: true`.
- DB row counts unchanged across `nodes`, `node_fields`, `node_types`, `edits_log`, `undo_operations` (snapshot before/after).
- For tools that touch files (`delete-node`, `batch-mutate`): no file added, removed, or modified — `stat` and content hash before/after.

Tool-specific:
- **`delete-node`:** `dry_run: true, confirm: true` still previews; live deletion paths regression-pass when `dry_run` omitted.
- **`add-type-to-node`:** dry-run preview's `would_add_fields` matches the actual run's `added_fields` for a successful add. Already-present case returns `would_be_no_op: true`.
- **`remove-type-from-node`:** non-last-type dry-run works (the path the existing `confirm` gate doesn't cover). Last-type dry-run still emits `LAST_TYPE_REMOVAL` warning.
- **`batch-mutate`:** composed `[create X, update X]` produces coherent preview where op 2 reflects op 1's effect. A failing op mid-batch returns `ok: true` with `failed_at`, `op`, `message`, and partial `would_apply`. Each `would_apply` entry matches its op's discriminated-union shape — `update.fields_changed` reports the correct names (including null-deletion intent); `update.types_after` is present iff a type op was specified; `delete.referencing_nodes` is capped at 10 even when more inbound refs exist. `undo_operations` / `undo_snapshots` row counts unchanged across dry-run (no `createOperation` fired). Live-path regression-passes when `dry_run` omitted.

## Known Asymmetry (Documented, Not Fixed)

`update-node` query mode defaults `dry_run` to `true` — opposite of every other tool's default. This is a deliberate safety choice for the bulk path and remains in place. A future spec can revisit whether to flip it; not in scope here because (a) it's a behavior change for existing callers and (b) the current four-tool addition is independent and lower-risk.

## Out of Scope

- Shared `dry_run` utility / preview-builder abstraction. The four tools' preview shapes diverge enough that the existing per-tool inline pattern (precedent: `create-node`, `update-node`) remains clearer.
- Changes to `executeMutation`'s signature or to a new `dry_run` flag on the pipeline. We reuse the existing `db_only: true` flag for `batch-mutate`'s suppressed-write needs; the per-tool tools short-circuit before reaching the pipeline at all.
- Changes to `executeDeletion`'s signature. Delete-op file-unlink suppression in `batch-mutate` dry-run lives at the caller.

## Open Questions (Implementation-Time Checks)

1. **`db_only: true` side-effects in `executeMutation`.** Confirm during implementation that `db_only: true` only suppresses the file write and does not also alter `edits_log` shape, validation defaulting, or other behavior in ways that would mis-color the dry-run preview. If it does, suppress those entries at the `batch-mutate` caller (the txn rollback handles cleanup either way).
2. **Sentinel propagation.** Verify that throwing `DryRunRollback` inside `db.transaction(() => { ... })` triggers `ROLLBACK` cleanly and the error propagates out so we can catch it. (better-sqlite3 docs say throws abort the transaction; confirm in implementation.)
3. **`add-type-to-node` already-present early return.** The current live path returns `{ already_present: true }` without any DB or file work. Dry-run should match this short-circuit; verify `populateDefaults` isn't called in that case for either path.
