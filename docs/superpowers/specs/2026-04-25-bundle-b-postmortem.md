# Bundle B — Postmortem & Findings (2026-04-25)

**Status:** abandoned attempt; rebuild from scratch using these findings
**Branch:** `chore/bundle-b-tool-surface-symmetry` (deleted)
**Spec at time of attempt:** `2026-04-25-bundle-b-tool-surface-symmetry-design.md` (deleted with the branch)
**Plan at time of attempt:** `2026-04-25-bundle-b-tool-surface-symmetry.md` (deleted with the branch)

## What this is

A first attempt at Bundle B (closed-union `Issue.code`, per-op `op_index` on `batch-mutate` warnings, global-field undo) reached 23 commits and 1201/1201 passing tests, but was abandoned without merging because the underlying spec turned out to be systematically wrong about the codebase. This doc captures what we learned so the second attempt starts from accurate assumptions.

## Why we abandoned

Not because the code didn't work — it did. The reasons:

- **Plan/spec had ~10 wrong assumptions** about file paths, column shapes, API param names, response envelopes, file extensions, and valid type values. Each was discovered mid-build by an implementer subagent and corrected on the fly. That's a smell: the surveying step under-served the design step.
- **The spec asserted atomicity guarantees that don't exist.** It claimed `restoreOperation` runs the global-field pass inside an existing transaction. There is no transaction — the entire undo system (schema undo, node undo, and the new global-field undo) is best-effort, not atomic. The misunderstanding was authored in the spec, not introduced by the build.
- **The final holistic review caught two Important issues** that all 11 per-task reviews missed: file re-rendering after undo (real correctness gap — the watcher would reconcile DB to the stale file content on the next edit, silently undoing the undo) and `global_field_count` set but never surfaced. Per-task review discipline broke down for the C5–C9 batch (5 tool wirings dispatched to one subagent, no per-task spec/quality review).
- **Scope creep in §B.** B3 added missing `sanitizeFilename`/`checkTitleSafety` calls to `batch-mutate.create`. B4 added missing `TYPE_OP_CONFLICT` detection to `update-node` query mode. Both fix latent bugs (good) but bundling them with the `op_index` work means the Bundle B PR would have shipped wire-format changes that the spec didn't document.

## What we got right that's worth carrying forward

- The closed-union `Issue.code` design (single source-of-truth file, mechanical sweep of ~17 sites, identity-mapped string constants so the wire format is invariant). Shape is correct.
- The `tagOpIndex` helper and the `op_index?: number` field on `Issue`. Minimal, additive, correct.
- The two-table snapshot schema for global-field undo (one for field-row, one for value-cascade) and the FK ON DELETE CASCADE so cleanup is implicit.
- The four-case capture/restore pattern (`was_new`, `was_deleted`, `was_renamed_from`, update). The dispatch logic is correct; only the column lists and re-rendering integration were wrong.

## Codebase facts that the original spec got wrong

Reference these directly for v2's spec, instead of re-deriving:

### File paths
- `Issue` interface lives in `src/mcp/tools/errors.ts`, NOT `src/mcp/errors.ts`.

### Column shapes
- `global_fields` does NOT have a single `overrides_allowed` column. It has three separate `INTEGER` columns:
  - `overrides_allowed_required`
  - `overrides_allowed_default_value`
  - `overrides_allowed_enum_values`
  Source: `src/db/migrate.ts:upgradeForOverrides`.
- `schema_field_claims` columns (post all migrations): `schema_name`, `field`, `label`, `description`, `sort_order`, `required_override`, `default_value_override`, `default_value_overridden`, `enum_values_override`. Verify against `src/db/schema.ts` + the migration chain when v2 lands.

### Valid `field_type` values
Per `src/validation/types.ts:FieldType`: `'string' | 'number' | 'date' | 'boolean' | 'reference' | 'enum' | 'list'`. The first attempt's spec used `'text'` (wrong) and `'list<text>'` (wrong) — the canonical forms are `'string'` and `'list'` + `list_item_type: 'string'`.

### MCP tool param names
- `rename-global-field` uses `old_name` / `new_name` (not `from` / `to`).
- `update-global-field` type-change confirm flag is `confirm` (not `confirm_type_change`).

### MCP response shapes
- `list-global-fields` returns `data` as a flat array of fields (not `{ fields: [...] }`).
- `describe-schema` returns `{ fields: [...] }` (not `{ field_claims: [...] }`).
- `undo-operations` defaults `dry_run: true`. All undo round-trip tests must pass `dry_run: false`.

### File extensions
- Schema files in `.schemas/` are `.yaml`, not `.md`. The fields catalog is `.schemas/_fields.yaml` (note the underscore prefix). Tests asserting on file contents must read `.yaml`.

### Render helpers (relevant for global-field undo)
- `renderFieldsFile(db, vaultPath)` — re-renders `.schemas/_fields.yaml`.
- `renderSchemaFile(db, vaultPath, schemaName)` — re-renders one `.schemas/<schema>.yaml`.
- `rerenderNodesWithField(db, writeLock, vaultPath, fieldName, undefined, syncLogger)` — re-renders every `.md` whose YAML has a key matching `fieldName`.
- The schema undo path at `src/undo/schema-snapshot.ts:176` already calls `renderSchemaFile`. Mirror this for global-field undo: undo MUST re-render or the watcher reverses it on the next edit.

## Latent bugs on main worth filing as separate items

These exist on `main` today, predate Bundle B, and were uncovered while building it. None were fixed in a way that survived the abandoned branch. Each deserves its own focused fix.

### 1. `batch-mutate.create` does not sanitize filenames

`src/mcp/tools/batch-mutate.ts` constructs `file_path` as `${title}.md` directly, without calling `sanitizeFilename` or `checkTitleSafety`. A title containing `/` or `\` is passed straight through, causing `safeVaultPath` to resolve as a subdirectory path (e.g. title `"Meeting/Notes"` → `Meeting/Notes.md`, treated as `Meeting/Notes.md` inside the vault, not a single file with a slashed name). Standalone `create-node` does sanitize (`src/mcp/tools/create-node.ts:84-99`). The two paths diverge.

**Fix:** add `sanitizeFilename` and `checkTitleSafety` calls in batch-mutate's create branch, mirroring create-node. Surface the resulting warnings normally. Test with titles containing `/`, `\`, and trailing dots.

### 2. `update-node` query mode silently drops already-present types in `add_types`

`src/mcp/tools/update-node.ts:computeNewTypes` (called from query-mode bulk update) skips types already on a node without warning. Single-mode `update-node` emits `TYPE_OP_CONFLICT` in similar conflict shapes; query mode is silently inconsistent.

**Fix:** in the per-row loop of query mode, detect already-present types in `ops.add_types` and emit `TYPE_OP_CONFLICT` (severity: warning). When `op_index` ships in v2, those warnings should carry it.

### 3. `update-global-field` (type-change confirmed) silently deletes uncoercible values

In `src/global-fields/crud.ts:updateGlobalField` (type-change path), node values that can't coerce to the new type are deleted from `node_fields`. They're logged to `edits_log` but the `node_fields` row is gone. This may violate the CLAUDE.md principle: *"Data is never silently deleted. Orphan fields preserve data."*

**Open question:** does `edits_log` retention satisfy "data is never silently deleted"? Or should the tool refuse and require an explicit acknowledgment (`force: true`-style)?

**Fix options:**
- **A.** Keep current behavior, document `edits_log` as the "preservation" mechanism, ensure operators know to query it.
- **B.** Change behavior: refuse type-change confirmed when there are uncoercible values, require an explicit `discard_uncoercible: true` flag.
- **C.** Change behavior: keep the row but null its typed columns and write the original raw text to `value_raw_text`, similar to the orphan-field pattern.

Worth a deliberate design decision.

## Systemic issue: undo system is not atomic

`restoreOperation` (`src/undo/restore.ts:102-219`) is not wrapped in `db.transaction`. Per-snapshot restore is internally atomic (each `restoreCreate`/`restoreUpdate`/`restoreSchemaSnapshot`/`restoreGlobalFieldSnapshot` call has its own write-lock and DB writes), but the loop across multiple snapshots within one `operation_id` is not. A multi-snapshot undo where snapshot N's restore throws will leave snapshots 1..N-1 restored, with `markUndone` (line 205) never firing — the operation_id stays in `'active'` status with partial-state semantics.

Real-world impact:
- Single-tool undos: fully atomic (one snapshot per op). Dominant case. No exposure.
- Multi-snapshot undos under one op_id (e.g., `batch-mutate` with multiple operations sharing one `operation_id`): best-effort. Partial state on failure.

This affects existing schema undo and node undo equally — Bundle B's global-field undo just inherits the gap.

**Two options for v2 of Bundle B:**

- **Document the gap and live with it.** Bundle B doesn't make atomicity worse; matches existing pattern. Spec must accurately describe non-atomic behavior. File a dedicated atomicity ticket.
- **Fix it as part of Bundle B.** Wrap `restoreOperation`'s body in `db.transaction`. One-line semantic improvement, also fixes the latent gap in schema and node undo. Caveat: FS I/O calls inside (`rerenderNodesWithField`, `renderSchemaFile`, `renderFieldsFile`) would run inside the SQLite transaction. Workable in better-sqlite3 (synchronous, single-process), but the FS work should ideally be hoisted out and run after the tx commits — which is real design work, not a one-liner.

Recommendation for v2: document the gap, file the atomicity ticket as a separate work item, do not bundle.

## Process notes for v2

- **Pre-flight more aggressively.** Before writing the spec, run a focused exploration that opens the actual tool handlers (`src/mcp/tools/{create,delete,rename,update}-global-field.ts`), the actual schema (`src/db/migrate.ts`), the actual `Issue` definition, and a couple of canonical existing tests. Quote real code paths into the spec instead of inferring shapes. Most of the v1 errors would have been caught here.
- **Verify systemic claims, don't restate them.** The atomicity claim was inherited from the existing schema-undo spec. Before asserting it in a new spec, read the implementation. One grep would have found the absence of `db.transaction`.
- **Do not skip per-task review on "mechanical" batches.** The C5–C9 batch dispatched 5 tool wirings to one subagent and skipped per-task spec/quality reviews because the pattern was "the same." That's where the file-rendering gap shipped. Either keep per-task reviews even on mechanical batches, or move the holistic review earlier.
- **Ban scope creep into adjacent latent bugs.** When an implementer finds a latent bug while wiring a feature, the right move is STOP + report + file separately, not silently bundle. The "bundle adjacent fix" pattern produces commits whose messages don't reflect their full impact, and the latent fix doesn't get the design attention a real ticket would. (This was the right call in retrospect for the v1 commits since the user explicitly approved each, but the default should be "STOP and report.")
- **Test file contents, not just DB state, on undo round-trips.** Every undo round-trip test in v1 asserted via `get-node` / `list-global-fields` (DB-backed) and missed the file-rendering gap entirely. v2's tests must read `.md` and `.yaml` after undo and assert on contents.

## Recommendations for Bundle B v2

1. Start a fresh brainstorming session using this doc as input. Most of the design decisions from v1 still hold (closed-union approach, op_index shape, four-case undo capture/restore). Don't re-litigate those.
2. Pre-flight by reading the actual files listed under "Codebase facts" before drafting the spec. Quote the real columns, real param names, real response shapes into the spec.
3. Decide upfront on the three latent bugs (#1, #2, #3 above): in scope for v2, or filed separately. My recommendation: separate. Keep Bundle B focused on the three symmetry items.
4. Decide upfront on undo atomicity: document or fix. My recommendation: document; file separately.
5. Spec must include the file re-rendering integration (the Issue 1 fix from v1). Schema undo's pattern at `src/undo/schema-snapshot.ts:176` is the reference.
6. Capture/restore symmetry on `schema_field_claims`: use an explicit shared column list constant in v2 (not `SELECT *` in capture vs. enumerated INSERT in restore). When a future migration adds a column, both paths break together (loud) instead of silently diverging.
7. `global_field_count` must be wired into `UndoOperationRow` and `list-undo-history`'s SELECT projection from the start. The migration JSDoc already promises it.
