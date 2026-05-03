# Version Stamping & STALE_NODE — Design Spec

**Date:** 2026-05-03
**Status:** Design approved, pending implementation plan
**Motivation:** Foundation #1 in [`Vault Engine - MCP App Visualization Foundations`](../../../../Documents/archbrain/Notes/Vault%20Engine%20-%20MCP%20App%20Visualization%20Foundations.md) (vault note, 2026-05-03)
**Depends on:** Merged — `feat/unified-deletion`, `feat/mcp-response-envelope`, `feat/undo-system`

---

## Problem

The mutation pipeline today uses `nodes.content_hash` only for no-op detection ("is the rendered output identical to disk and DB?"), not for "is this still the version the caller read?" Every mutation is effectively last-write-wins at the whole-file level.

This is tolerable when only the AI mutates serially through MCP tools and Obsidian races are caught by the watcher's write-skip. It will not be tolerable once the MCP App pattern grows into a third surface — an iframe showing 50 task rows the user spent a minute selecting, while Obsidian is open on three of them, while the AI is mid-`batch-mutate`. Without optimistic concurrency, every new visualization surface multiplies the silent-overwrite blast radius.

## Design principles

- **Per-node monotonic version integer**, separate from `content_hash`. Cleaner mental model than hash strings; doesn't conflate "is the rendered output identical?" (current `content_hash` job) with "is this still the version I read?"
- **Optional check, not mandatory.** Existing tool callers and the watcher path keep working unchanged. Iframes opt in by passing `expected_version`; everything else stays last-write-wins.
- **Single pipeline preserved.** Version increment hooks into `executeMutation` / `executeDeletion` after the existing no-op check. No parallel write path.
- **Watcher always wins.** The watcher reflects on-disk reality and bumps the version unconditionally; it never checks. A file edit it observes is, by definition, the new truth.
- **Per-op semantics for batch-mutate.** Stale ops in a batch are reported individually with their current state; non-stale ops apply. Matches existing `batch-mutate` "best-effort, not transactional" contract.
- **Stale errors carry the current node state.** The `STALE_NODE` envelope includes a drop-in `current_node` so callers don't need a second round-trip to refetch.

## Scope

**In scope** — node mutations only:

- `update-node` (single-node mode)
- `add-type-to-node`
- `remove-type-from-node`
- `delete-node`
- `rename-node`
- `batch-mutate` (per-op `expected_version`)

**Out of scope:**

- Schema mutations (`create-schema`, `update-schema`, `delete-schema`). Rare, human-reviewed, low-blast-radius. Future spec if iframe-driven schema editing materializes.
- Global-field mutations (`create-global-field`, `update-global-field`, `rename-global-field`, `delete-global-field`). Same rationale.
- `update-node` query mode (bulk filter). Caller doesn't know in advance which nodes match the filter; per-node version checks don't apply. Existing `dry_run: true` default + preview-then-commit stays as the bulk-op guard. Passing `expected_version` to query mode rejects with `INVALID_PARAMS`.
- `create-node`. No prior version exists; new nodes start at `version = 1` automatically.
- Per-field granularity. False-positive rate during active Obsidian editing is acceptable; iframe recovery is "refetch + retry." Add per-field later only if friction proves real.
- Server-pushed staleness notifications. Iframes are pull-only; staleness surfaces on next write attempt. Subscription model is its own future spec.

---

## Data model

One new column on `nodes`:

```sql
ALTER TABLE nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

- `NOT NULL DEFAULT 1` so existing rows backfill to `1` automatically on column add.
- Idempotent migration in `src/db/migrate.ts` (new `upgradeToVersionStamps(db)`, same shape as `upgradeToPhase3`).
- `src/db/schema.ts` updated so fresh-DB initialization includes the column on `CREATE TABLE`.

Per existing convention, the `ALTER TABLE` lives in the migration (because `CREATE TABLE IF NOT EXISTS` no-ops on existing DBs).

## Tool surface

### Mutation tools (single-node)

`update-node`, `add-type-to-node`, `remove-type-from-node`, `delete-node`, `rename-node` each gain:

```ts
expected_version: z.number().int().min(1).optional()
```

Pass-through to the pipeline. On `StaleNodeError` from the pipeline, the tool catches and returns:

```json
{
  "ok": false,
  "error": {
    "code": "STALE_NODE",
    "message": "Node abc was modified (v7 → v8) since you read it",
    "details": {
      "current_version": 8,
      "expected_version": 7,
      "current_node": { "id": "abc", "title": "...", "types": [...], "fields": {...}, "body": "...", "version": 8, ... }
    }
  },
  "warnings": []
}
```

`current_node` matches the shape `get-node` returns (single-node fetch helper, reused) so the iframe gets a drop-in replacement for its local row.

### `update-node` query mode

If `expected_version` is passed alongside any query-mode parameter, reject with `INVALID_PARAMS`. Documented in the tool description.

### `batch-mutate`

Each op accepts optional `expected_version`. Per-op result already carries a status field; add `stale` as a new outcome:

```json
{
  "results": [
    { "op_index": 0, "status": "applied", "node_id": "...", "new_version": 8 },
    { "op_index": 1, "status": "stale", "node_id": "...",
      "details": { "current_version": 12, "expected_version": 9, "current_node": {...} } },
    { "op_index": 2, "status": "applied", "node_id": "...", "new_version": 4 },
    ...
  ]
}
```

Per-op try/catch around `StaleNodeError`; non-stale ops continue. Existing per-op error handling pattern is reused.

### Read tools

`get-node` and `query-nodes` add `version` to the returned node row shape:

```json
{ "id": "abc", "title": "Task", "version": 8, "types": [...], "fields": {...}, ... }
```

Single SELECT change in `enrichRows()` for `query-nodes`; one column added in `get-node`'s row fetch. No API breakage — additive field on existing shapes.

### Issue code

`STALE_NODE` added to the `ToolIssueCode` closed union in `src/mcp/tools/errors.ts`. The build typecheck (`npm run build` runs the test tsconfig project) will then force every mutation tool handler to handle it.

---

## Pipeline changes

### `executeMutation` (`src/pipeline/execute.ts`)

Mutation input gets an optional `expectedVersion: number`. The check sits after the no-op detection (line 267) and before the INSERT/UPDATE (line 346):

```ts
// After no-op check passes, before write
if (expectedVersion !== undefined && mutation.node_id !== null) {
  const currentVersion = (db.prepare('SELECT version FROM nodes WHERE id = ?')
    .get(mutation.node_id) as { version: number } | undefined)?.version;
  if (currentVersion !== expectedVersion) {
    throw new StaleNodeError(mutation.node_id, expectedVersion, currentVersion ?? -1);
  }
}
```

On apply:

- New node insert: `version = 1` in the INSERT (matches DB default).
- Existing node update: `version = version + 1` in the UPDATE clause.

Genuine no-ops (line 267 short-circuit) don't reach this code path, so they don't bump.

### `executeDeletion` (`src/pipeline/delete.ts`)

Same `expectedVersion` parameter, same check before delete. Same `StaleNodeError` thrown on mismatch.

### `StaleNodeError`

New typed error in `src/pipeline/errors.ts` (or co-located with `executeMutation`):

```ts
export class StaleNodeError extends Error {
  constructor(
    public nodeId: string,
    public expectedVersion: number,
    public currentVersion: number,
  ) {
    super(`Node ${nodeId} was modified (v${expectedVersion} → v${currentVersion})`);
  }
}
```

Tool handlers catch this specific error, fetch `current_node`, and wrap as the `STALE_NODE` envelope.

### Watcher path

No change. Watcher already calls `executeMutation` with `source: 'watcher'` and `db_only: true`, never passes `expectedVersion`. The pipeline bumps version on every apply regardless.

### Undo path

No change. Undo restores via `executeMutation` with `source: 'undo'`, never passes `expectedVersion`. Restoring "back to the v7 state" produces v9, never goes backward — versions are monotonically increasing across all writes including undo.

---

## Error handling

| Situation | Error | Returned |
|-----------|-------|----------|
| `expected_version` matches current | — | Apply, bump, return new version |
| `expected_version` mismatches current | `StaleNodeError` | `STALE_NODE` envelope with `current_node` |
| `expected_version` omitted | — | Apply LWW, bump, return new version |
| `expected_version` passed to `update-node` query mode | — | `INVALID_PARAMS` (rejected by zod / tool handler) |
| `expected_version` passed to `create-node` | — | `INVALID_PARAMS` (no prior version) |
| Node deleted between read and write (`expected_version` passed) | — | Existing `NODE_NOT_FOUND` from the tool's pre-check fires before the version check. No change. |
| `batch-mutate` op stale, others fresh | per-op `StaleNodeError` | per-op `status: "stale"` entry; other ops apply |
| `batch-mutate` op targets deleted node | — | per-op existing `NODE_NOT_FOUND` status; not conflated with stale |

The watcher path's `db_only` writes never throw `StaleNodeError` (no `expectedVersion` passed), so the watcher continues to be exception-free in steady state.

---

## Race window analysis

**Closed by SQLite per-statement consistency:** the SELECT-version + UPDATE happen inside the same `executeMutation` transaction. No third writer can interpose between the version check and the apply.

**Open by design:** between iframe `query-nodes` (read version) and iframe `update-node` (send `expected_version`), the watcher could pick up an Obsidian edit and bump version. This is exactly what version-stamping is built to detect; the iframe receives `STALE_NODE` and refetches.

**Pre-existing (unchanged):** between an Obsidian save and the watcher's debounce window (2.5s), the file on disk differs from the DB. A pipeline write during this window proceeds (DB version stays consistent with what was read), then writes to disk; the watcher subsequently picks up the discrepancy. This is the existing watcher-race story, handled by `content_hash` no-op detection and the watcher's stale-file guard.

---

## Testing

**Unit tests (vitest):**

1. `tests/unit/pipeline/version-stamp.test.ts`
   - Bumps version on apply
   - Doesn't bump on no-op (line 267 short-circuit reached first)
   - Throws `StaleNodeError` on mismatch
   - Accepts on exact match
   - Accepts when `expectedVersion` omitted (LWW preserved)
   - New node insert starts at version 1

2. `tests/unit/db/migrate-version-stamps.test.ts`
   - Migration is idempotent (run twice, no error)
   - Backfill assigns `version = 1` to existing rows
   - Fresh-DB init via `schema.ts` includes the column

3. Existing `update-node`, `add-type-to-node`, `remove-type-from-node`, `delete-node`, `rename-node`, `batch-mutate` test suites — check that the new column doesn't break setup; add focused stale-path cases.

**Integration tests:**

4. `tests/integration/stale-node.test.ts`
   - End-to-end: tool A reads version, tool B mutates and bumps, tool A's update with `expected_version` returns `STALE_NODE` envelope with `current_node` populated
   - `update-node`, `add-type-to-node`, `delete-node`, `rename-node` all checked

5. `tests/integration/batch-mutate-stale.test.ts`
   - Mixed batch (some stale, some fresh) returns per-op statuses correctly
   - Stale entries carry `current_node`
   - Non-stale entries apply normally

6. `tests/integration/watcher-version-bump.test.ts`
   - Watcher-path edit bumps version
   - Watcher path never throws `StaleNodeError`

**Read-tool tests:**

7. `query-nodes` and `get-node` existing test suites — add a single assertion that `version` appears in the response row shape.

---

## Migration / backfill

`upgradeToVersionStamps(db)` runs at startup alongside existing `upgradeToPhaseN` calls in the engine bootstrap. Idempotent:

```ts
export function upgradeToVersionStamps(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes('version')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1').run();
    // No explicit backfill needed — DEFAULT 1 populates existing rows on column add.
  }
}
```

No `meta.version_stamps_version` tracking needed; the column-existence check is sufficient (matches the pattern of `upgradeToPhase3`'s `value_raw_text` check).

---

## Reversibility

If the design proves wrong, removal is one commit:

- Drop the `expected_version` param from each tool's zod shape.
- Drop the version check from `executeMutation` / `executeDeletion`.
- Drop `version` from `get-node` / `query-nodes` returned shapes (callers should ignore unknown fields, but verify).
- Leave the `version` column in place (harmless; can be dropped in a follow-up if desired).

The `STALE_NODE` issue code stays in the closed union (no harm) until a separate cleanup commit removes it.

---

## Open questions

None at design time. All consequential choices were resolved during brainstorming (mechanism = monotonic int, granularity = per-node, batch-mutate = skip-and-report, error shape = include current_node, query-mode = ignored).
