# Schema Propagation Through the Pipeline — Design

**Date:** 2026-04-19
**Status:** Spec
**Sequence:** 3 of the architecture-review follow-ups
**Addresses:** [Architecture Review 2026-04-18](2026-04-18-architecture-review.md) finding §2b
**Precedent:** [Unified Deletion Design 2026-04-19](2026-04-19-unified-deletion-design.md) (sequence 2, merged)

## Goal

Route schema propagation through `executeMutation` so the two functions in `src/schema/propagate.ts` stop running their own render → write → DB-insert loops. Close the biggest remaining divergence from the charter's single-pipeline rule, and remove the structural gap that would otherwise let an undo implementation silently miss schema-driven changes.

## Non-goals

- **§2c — orphan raw-text re-coercion.** Orphaned fields continue to preserve raw text as-is; re-adoption reintroduces the pre-existing coercion error. Separate sequence.
- **§3a — MCP response envelope standardization.** Parallel track.
- **§3d — default-population consolidation.** `populateDefaults` stays as-is; this spec's private helper resolves defaults inline. Consolidation is its own sequence.
- **Deleting `rerenderNodesWithField`.** Its signature is meaningful to its three call sites. Stays exported.
- **Undo itself.** This sequence unblocks undo by closing the edits_log gap; the undo implementation is a later sequence.

## Current state

`src/schema/propagate.ts` exports two functions that both bypass `executeMutation`:

| Function | Callers | What it does |
|---|---|---|
| `propagateSchemaChange(schemaName, diff)` | `update-schema.ts` | For each node of the schema type: load fields, compute adoption defaults from diff, render, write file, update `nodes`/`node_fields`, emit ad-hoc `field-defaulted` / `fields-orphaned` rows. Wraps the whole loop in a multi-file backup/restore sleeve. |
| `rerenderNodesWithField(fieldName, extraIds)` | `rename-global-field.ts`, `update-global-field.ts` (type change) | For each node with the field (plus optional extras): load fields, render, write file, update `nodes`. No diff, no adoption/orphan events. |

Gaps vs. `executeMutation`: no `value-coerced` / `merge-conflict` log entries in the pipeline's shape, no relationship rebuild (`deriveRelationships`), no FTS update, no `refreshOnCreate`/`refreshOnRename`, no stricter no-op detection (today's hash-skip checks disk only; pipeline checks disk AND DB hash), ad-hoc lock discipline.

The backup/restore sleeve in `propagateSchemaChange` is already partially broken today: the per-node DB writes commit as they go (no outer transaction), so a mid-loop throw restores earlier files from backup but leaves earlier DB state mutated. Files and DB end up inconsistent across the node set on failure.

## Design

### §1 — New pipeline source: `'propagation'`

Extend `ProposedMutation.source` to `'tool' | 'watcher' | 'normalizer' | 'propagation'`. Branch behavior in `src/pipeline/execute.ts`:

| Aspect | `tool` | `watcher` | `normalizer` | `propagation` (new) |
|---|---|---|---|---|
| Blocking errors | throw | absorb (retain DB) | throw | throw |
| Tolerated codes | `MERGE_CONFLICT` | n/a | `MERGE_CONFLICT`, `REQUIRED_MISSING` | `MERGE_CONFLICT`, `REQUIRED_MISSING` |
| `skipDefaults` passed to validator | `false` | `false` | `true` | `true` |
| Field retention on reject | n/a | DB values | n/a | n/a |

**Implementation delta in `src/pipeline/execute.ts`:**

- The existing `source === 'tool' || source === 'normalizer'` branch extends to include `'propagation'`.
- The `toleratedCodes` ternary keys off `source === 'normalizer' || source === 'propagation'`.
- The `skipDefaults` arg to `validateProposedState` keys off `source === 'normalizer' || source === 'propagation'`.
- No other branches change. The watcher-path retain-from-DB logic does not apply to propagation (propagation throws on real errors).

**Rationale:**

- **`skipDefaults: true`** enforces the "defaults are creation-only" rule from CLAUDE.md: the validator must not retroactively populate defaults for already-claimed-but-missing required fields. New claims are the only legitimate adoption moment, and those defaults are pre-populated by the caller before the mutation enters the pipeline (see §2).
- **Tolerate `REQUIRED_MISSING`:** an `update-schema` call must not fail because some node is already in violation for an unrelated field. Pre-existing violations remain visible via `validate-node`; they do not block propagation.
- **Throw on other errors:** propagation is ultimately tool-initiated. Coercion failures, type mismatches, and other genuine validation errors should surface to the caller rather than silently mutate state.

**Edits log emitted by the pipeline itself** (unchanged, but now carrying `source: "propagation"` in details when triggered via this path): `value-coerced`, `merge-conflict`. The validation-driven `field-defaulted` path does **not** fire because `skipDefaults: true`. Claim-adoption `field-defaulted` rows are emitted post-mutation by the caller in `src/schema/propagate.ts` (see §3).

### §2 — `src/schema/propagate.ts` internals

Both exported functions keep their current signatures. Call sites (`update-schema.ts`, `update-global-field.ts`, `rename-global-field.ts`) do not change.

#### Private helper — shared per-node primitive

```ts
function rerenderNodeThroughPipeline(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  adoptionDefaults: Record<string, unknown>,
  syncLogger?: SyncLogger,
): { node_id: string; file_path: string; file_written: boolean } | null;
```

Responsibilities, in order:

1. Load `nodes` row (`file_path`, `title`, `body`). Return `null` if absent (rare race between node-id query and per-node processing).
2. Load `node_types` for this node.
3. Load `node_fields` → reconstruct `currentFields` and `rawFieldTexts` via `reconstructValue`.
4. Merge `adoptionDefaults` into `currentFields` (only where the field is not already present — re-adoption never overwrites).
5. Call `executeMutation` with:
   - `source: 'propagation'`
   - `node_id`, `file_path`, `title`, `body`, `types`
   - `fields`: the merged result
   - `raw_field_texts`: the DB-sourced raw texts
6. Return `{ node_id, file_path, file_written }` from the pipeline result.

The helper does no log emission of its own; the pipeline emits its own rows (value-coerced, merge-conflict) and the caller emits adoption/orphan rows post-mutation (§3).

#### `propagateSchemaChange(db, writeLock, vaultPath, schemaName, diff, syncLogger?)`

Returns the same `PropagationResult` shape as today.

1. If `diff.added.length + diff.removed.length + diff.changed.length === 0`: return zero-result (fast path).
2. Query affected node IDs: `SELECT node_id FROM node_types WHERE schema_type = ?`.
3. For each `nodeId`:
   - Load `currentFields` and `types` (re-loaded here rather than inside the helper because the caller needs them for diff-aware logic before the helper runs).
   - Compute `effectiveFields` for this node's type set (cache by sorted type-set key, same as today).
   - Build a `FileContext` for token resolution of adoption defaults: `statSync` on the node's absolute path for `mtimeMs`, plus `nodes.created_at` from DB for `createdAtMs`. The caller uses this locally to resolve defaults below — it is not passed into `executeMutation` (the pipeline computes its own `FileContext` internally for any token defaults it might handle).
   - Compute `adoptionDefaults`: for each `field` in `diff.added`:
     - Skip if `field in currentFields` (re-adoption — value already present).
     - Skip if `!ef.resolved_required`.
     - Skip if `ef.resolved_default_value == null` (no default to populate).
     - Otherwise: `adoptionDefaults[field] = resolveDefaultValue(ef.resolved_default_value, fileCtx)`. Also capture `default_source: 'global' | 'claim'` for the post-emission step. Values are pre-resolved (not tokens), so the pipeline sees them as plain provided values and does not emit a spurious `value-coerced` row.
   - Call `rerenderNodeThroughPipeline(..., adoptionDefaults)`.
   - **Post-mutation emission:**
     - For each `(field, resolvedValue, source)` in `adoptionDefaults`: insert one `field-defaulted` row (see §3).
     - For each `field` in `diff.removed` that's in `currentFields`: accumulate into `orphanedInThisNode[]`. If non-empty, insert one `fields-orphaned` row listing them all.
   - Update counters: `nodes_rerendered++` when the helper returned non-null and `file_written === true` (matches today's semantics: the hash-skip case does not increment). `defaults_populated += adoptionDefaults.size`. `fields_orphaned += orphanedInThisNode.length`.
4. Return `PropagationResult`.

**Atomicity:** per-node. Each `executeMutation` call is its own DB transaction + atomic file write. On mid-loop failure, earlier nodes remain fully committed; the error bubbles up. No backup/restore sleeve.

#### `rerenderNodesWithField(db, writeLock, vaultPath, fieldName, additionalNodeIds?, syncLogger?)`

Returns the same `number` (rerendered count) as today.

1. Resolve node IDs: `(SELECT DISTINCT node_id FROM node_fields WHERE field_name = ?) ∪ additionalNodeIds`.
2. For each `nodeId`: call `rerenderNodeThroughPipeline(..., {})`. Increment the counter when the helper returns non-null and `file_written === true`.
3. Return count.

No adoption/orphan events — rename and type-change do not change schema claims.

#### Removed from `src/schema/propagate.ts`

- The `backups[] / restoreFile / cleanupBackups` multi-file rollback sleeve.
- The inline `renderNode` / `atomicWriteFile` / disk-only hash-skip / raw `db.prepare('UPDATE nodes SET content_hash ...')` sequences.
- The ad-hoc `INSERT INTO edits_log ... 'field-defaulted'` call inside the render loop (moved to the post-mutation step with the correct `source: "propagation"`).
- `computePropagationFieldOrdering` — superseded by `executeMutation`'s `computeFieldOrdering`, which already handles claimed + orphan + conflicted fields correctly.

#### Stays in `src/schema/propagate.ts`

- `diffClaims` — unchanged, still exported (used by `update-schema.ts`).
- The two exported function names, signatures, and return types.

### §3 — Edits-log contract

Propagation emits two event types **post-mutation** (after `executeMutation` returns), matching the pattern used by `add-type-to-node.ts` and `remove-type-from-node.ts`.

#### `field-defaulted` (one row per adopted default)

```json
{
  "source": "propagation",
  "field": "status",
  "default_value": "draft",
  "default_source": "global",
  "trigger": "update-schema: Event",
  "node_types": ["Event"]
}
```

Changes from today:

- `source: "propagation"` — today's code writes `"tool"`, which is a mislabel.
- `trigger` included — today's `field-defaulted` path omits it, making it asymmetric with `fields-orphaned`.

Emitted only for fields present in `adoptionDefaults` (caller-known, not inferred from validation). For `rerenderNodesWithField`, this event never fires.

#### `fields-orphaned` (one row per node, listing all newly-orphaned fields)

```json
{
  "source": "propagation",
  "trigger": "update-schema: Event",
  "orphaned_fields": ["legacy_field"],
  "node_types": ["Event"]
}
```

Changes from today:

- `source: "propagation"` — same mislabel fix.
- Everything else unchanged from today.

Emitted only when `diff.removed ∩ currentFields` is non-empty. For `rerenderNodesWithField`, never fires.

#### DB migration

None. `event_type` vocabulary is unchanged (`field-defaulted` and `fields-orphaned` already exist). `details` is TEXT — the `source: "propagation"` value is just a new string in an existing dimension. `query-sync-log`'s zod schema already lists `'propagation'` as a valid source filter, so tooling is already aligned with this terminology.

#### Downstream consumer risk

`field-defaulted` and `fields-orphaned` rows are read only by log-query tools for display; no programmatic matching on the `details` blob. Existing rows (carrying the old `source: "tool"` mislabel for propagation-originated events) remain as-is; new rows are correct. No backfill.

### §4 — Call-site migration

No changes:

| File | Function called | Status |
|---|---|---|
| `src/mcp/tools/update-schema.ts` | `diffClaims`, `propagateSchemaChange` | unchanged |
| `src/mcp/tools/update-global-field.ts` | `rerenderNodesWithField` | unchanged |
| `src/mcp/tools/rename-global-field.ts` | `rerenderNodesWithField` | unchanged |

All behavioral change is localized to `src/schema/propagate.ts` and a minor branch extension in `src/pipeline/execute.ts`.

## Test strategy

### Pipeline-level — new `source: 'propagation'` branch

Direct unit tests for `executeMutation`:

- `source: 'propagation'` with a pre-existing `REQUIRED_MISSING` on the node → no throw, mutation applies, file written.
- `source: 'propagation'` with a `TYPE_MISMATCH` on a field → throws `PipelineError` (error code not tolerated).
- `source: 'propagation'` with `skipDefaults: true` verified: a required-with-default field that is absent from `mutation.fields` remains absent (validator does not default it).
- `source: 'propagation'` no-op case: both disk and DB hash already match the re-render → `file_written: false`, no edits_log rows.

### `propagateSchemaChange`

- **Added required+default claim** → field populated on node, `field-defaulted` row with `source: "propagation"`, `default_source`, `trigger: "update-schema: X"`.
- **Added non-required claim** → no default populated, no `field-defaulted` row.
- **Re-adopted claim** (field already on node) → value preserved, no `field-defaulted` row.
- **Removed claim** → field becomes orphan, `fields-orphaned` row with `source: "propagation"`; value preserved on disk via orphan rendering.
- **Changed claim** (sort_order, label, etc.) → node re-rendered, no adoption/orphan rows.
- **Pre-existing `REQUIRED_MISSING` on unrelated field** → propagation succeeds; issue remains visible via `validate-node`.
- **Empty diff** → fast return, zero-result, no DB writes.
- **Mid-loop failure** (inject a writeLock or pipeline throw into one node) → earlier nodes remain committed, failure propagates, no partial-rollback attempt. Confirms per-node atomicity.

### `rerenderNodesWithField`

- **rename-global-field**: rename `X → Y`, nodes that had `X` re-render with `Y` in frontmatter, no adoption/orphan rows, `rerendered` count matches node count.
- **update-global-field type change (coercible)**: `updateGlobalField` coerces values in the DB; `rerenderNodesWithField` re-renders the nodes with coerced values.
- **update-global-field type change (uncoercible)**: `updateGlobalField` deletes the uncoercible `node_fields` row + emits `value-removed`; `rerenderNodesWithField` receives the node ID via `additionalNodeIds` and re-renders without the field.
- **additionalNodeIds deduplication**: a node appearing in both the field query result and `additionalNodeIds` is re-rendered exactly once.

### Row-ordering integration test

For one `update-schema` call that triggers BOTH an added-with-default AND a removed claim (so two diff kinds are exercised at once): assert row ordering in `edits_log`:

1. Rows emitted by `executeMutation` (value-coerced, merge-conflict if any) appear first.
2. Post-mutation `field-defaulted` rows from the caller appear next.
3. The `fields-orphaned` row from the caller appears last.

Documents the contract and catches accidental reordering regressions.

### Regression preservation

Existing propagate tests in `tests/phase3/tools.test.ts` and related files should pass unchanged — they assert observable behavior (node re-rendered on claim add/remove, defaults populated, orphans preserved, files on disk match). The only visible shift is `source: "tool"` → `source: "propagation"` in emitted edits_log rows. Any test asserting the old string updates; no semantic change.

## Risk notes

- **Per-node atomicity semantics shift (benign, visible).** Today's backup/restore sleeve is already partially broken (DB writes are not rolled back across nodes). The new design leaves earlier nodes fully committed on mid-loop failure — strictly better, but different from the appearance of today's behavior. Error messages from `executeMutation` now propagate up through the three tool handlers to MCP responses.
- **Adoption default `$now` token resolution.** Defaults are explicitly resolved via `resolveDefaultValue(..., fileCtx)` before injection, using the node's `mtime` and `created_at`. Matches `executeMutation`'s tool-path resolution. Worth an explicit test for a schema claim with a `$now`-valued default.
- **`source: "propagation"` in edits_log is a label correction.** Old rows say `source: "tool"`; new rows say `source: "propagation"`. Grep shows no in-repo consumers filter edits_log `details.source` for propagation-originated events, so no cleanup needed — noted here so external readers aren't surprised.
- **`rerenderNodeThroughPipeline` naming overlap.** The helper is private and sits next to the exported `rerenderNodesWithField` in the same file. Acceptable as long as the helper is not exported.
- **Edits-log rows outside the pipeline transaction.** Post-mutation `field-defaulted` / `fields-orphaned` rows are written after `executeMutation` returns, so if the DB throws on the log insert itself (disk full, schema drift, etc.), the pipeline's mutation is already committed. This is the same trade-off in place for `add-type-to-node` / `remove-type-from-node` today. Acceptable.

## Sequencing

One implementation pass, roughly:

1. Extend `ProposedMutation.source` union and branch logic in `src/pipeline/execute.ts` (skipDefaults, toleratedCodes). Add unit tests for the `'propagation'` branch.
2. Rewrite `src/schema/propagate.ts`:
   - Introduce private `rerenderNodeThroughPipeline` helper.
   - Rewrite `propagateSchemaChange` around the helper + post-mutation emission.
   - Rewrite `rerenderNodesWithField` around the helper.
   - Delete `computePropagationFieldOrdering` and the backup/restore sleeve.
3. Update existing propagate tests if any assert the `source: "tool"` mislabel on `field-defaulted` / `fields-orphaned` rows → assert `source: "propagation"`.
4. Add the row-ordering integration test.
5. `npm run build` + `npm test`.

No DB migration. No MCP tool surface change. No call-site changes in `update-schema.ts` / `update-global-field.ts` / `rename-global-field.ts`.
