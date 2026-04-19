# Undo System — Design Spec

**Date:** 2026-04-19
**Status:** Design approved, pending implementation plan
**Supersedes:** `~/Documents/archbrain/Notes/Vault Engine - Undo System Design.md` (vault note, 2026-04-15 early-thinking draft)
**Depends on:** Merged — `feat/unified-deletion`, `feat/schema-propagation-pipeline`, `feat/mcp-response-envelope`, `fix/arch-review-bugs`

---

## Problem

An agent can make catastrophic bulk changes — updating 5,000 files with wrong metadata, bulk-deleting 1,000 files. Obsidian retains per-file version history and the trash covers deletions, but neither gives a clean "undo that entire operation" capability at the engine level.

## Design Principles

- **DB is the source of truth.** Undo restores DB state; files are re-rendered from that. No need to snapshot file content.
- **Operation-level granularity.** Each tool call — including a `batch-mutate` with thousands of sub-operations, or a `rename-node` that rewrites wikilinks in N referencing nodes — is one undoable unit.
- **Conflict-aware, not conflict-hiding.** When a node has been modified after the operation being undone, surface the conflict rather than silently overwriting or skipping.
- **Confirmation-gated.** Dry-run defaults to true. Undo is a two-step preview-then-confirm flow, consistent with `batch-mutate` and `update-node` query mode.
- **Single pipeline preserved.** Undo executes through `executeMutation` / `executeDeletion` with a new `source: 'undo'`, not a parallel write path.

## Scope

**In scope** — tools whose writes flow through `executeMutation` / `executeDeletion` as user-intent mutations:
- `create-node`
- `update-node` (single-node and query mode)
- `add-type-to-node`
- `remove-type-from-node`
- `rename-node`
- `delete-node`
- `batch-mutate`

**Out of scope**:
- Schema and global-field tools (`create-schema`, `update-schema`, `delete-schema`, `create-global-field`, `update-global-field`, `rename-global-field`, `delete-global-field`). Rationale: schema changes are rare, human-reviewed, and their blast radius is already visible in the preview/response. A bad schema change is reversible by re-editing the schema.
- Watcher-detected edits (external, not a tool mutation).
- Normalizer re-renders (no user intent, re-renders DB state).
- Propagation sweeps (downstream of an out-of-scope schema change).

---

## Data Model

Two new tables. Snapshots serialize full node state as JSON rather than mirroring the normalized DB tables — keeps undo storage self-contained and decoupled from main schema evolution.

```sql
CREATE TABLE undo_operations (
  operation_id  TEXT PRIMARY KEY,          -- nanoid
  timestamp     INTEGER NOT NULL,          -- epoch ms
  source_tool   TEXT NOT NULL,             -- 'create-node', 'update-node', 'batch-mutate', etc.
  description   TEXT NOT NULL,             -- human-readable summary, synthesized by tool handler
  node_count    INTEGER NOT NULL,          -- number of snapshots under this operation
  status        TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'undone' | 'expired'
);
CREATE INDEX idx_undo_operations_timestamp ON undo_operations(timestamp);
CREATE INDEX idx_undo_operations_status    ON undo_operations(status);

CREATE TABLE undo_snapshots (
  operation_id        TEXT NOT NULL REFERENCES undo_operations(operation_id) ON DELETE CASCADE,
  node_id             TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  title               TEXT,
  body                TEXT,
  types               TEXT,                -- JSON array of type names; null if was_deleted = 1
  fields              TEXT,                -- JSON object field_name -> {value, value_raw_text, source}; null if was_deleted = 1
  relationships       TEXT,                -- JSON array of {target, rel_type, context}; null if was_deleted = 1
  was_deleted         INTEGER NOT NULL,    -- 1 = node did not exist pre-op (undo action = delete the created node)
  post_mutation_hash  TEXT,                -- file content_hash after the op committed; null if was_deleted or file absent post-op
  PRIMARY KEY (operation_id, node_id)
);
CREATE INDEX idx_undo_snapshots_node ON undo_snapshots(node_id);
```

**Why `post_mutation_hash` is per-snapshot, not per-operation:** a single operation (rename-node, batch-mutate) produces N distinct hashes, one per mutated file. Stored on `undo_snapshots`.

---

## Snapshot Capture

### Operation ID generation

The MCP tool handler generates one `operation_id` (nanoid) before any pipeline call and reuses it across every `executeMutation` / `executeDeletion` call it issues. Multi-call tools (`rename-node` fires 1+N calls; `batch-mutate` fires K; `update-node` query mode fires K) produce a single undo operation containing all their snapshots.

### Pipeline signature extension

```ts
executeMutation(db, writeLock, vaultPath, mutation, syncLogger, undoContext?)
executeDeletion(db, writeLock, vaultPath, deletion, undoContext?)

interface UndoContext {
  operation_id: string;  // caller-generated, reused across multi-call tools
}
```

Absence of `undoContext` skips snapshot capture. This keeps the non-user-intent paths (watcher, normalizer, propagation, and undo itself) untouched — they never receive a context.

### Snapshot write location

- **`executeMutation`** — inside the existing Stage-1–6 DB transaction. Snapshot row is written after Stage 1 (schema context load) and before Stage 2 (validate). Captures **current** DB state of `node_id` (pre-mutation). If `node_id` is null (create), write a row with `was_deleted = 1` and all other JSON columns null. The `post_mutation_hash` is filled in at end-of-txn from the rendered file.
- **`executeDeletion`** — inside its existing DB transaction, before `DELETE FROM nodes`. Captures full state, `was_deleted = 0`, `post_mutation_hash = null` (file will be gone).

### Operation row write

The tool handler inserts the `undo_operations` row **once** at the start of the tool invocation, in its own small transaction, so subsequent snapshot FKs resolve. `node_count` is initially `0` and updated after pipeline calls complete.

**If the tool throws before any snapshot lands**, an orphan `undo_operations` row with `node_count = 0` remains. The cleanup sweep (see Retention) deletes orphans older than one minute.

### Description synthesis

The tool handler builds `description`. Examples:

- `"create-node: 'Weekly review'"`
- `"update-node: 3 fields on 'Projects/Alpha'"`
- `"add-type-to-node: added 'project' to 'Alpha'"`
- `"remove-type-from-node: removed 'draft' from 'Alpha'"`
- `"rename-node: 'Alpha' → 'Alpha v2' (24 references rewritten)"`
- `"delete-node: 'Old meeting notes'"`
- `"batch-mutate: 5 ops (3 update, 2 create)"`
- `"update-node query: updated 127 nodes (added type 'project')"`

---

## Undo Execution

### Restore path routes through the pipeline

Undo uses `source: 'undo'` on `executeMutation` / `executeDeletion` calls. The source gate:

- Skips snapshot capture (non-recursive — undoing an undo is not a feature).
- Treats the mutation like `normalizer` for default-population: no backfill.
- Tolerates `REQUIRED_MISSING` the way the normalizer path does — we are restoring DB state, not applying fresh defaults.

`source` union expands to:

- `executeMutation`: `'tool' | 'watcher' | 'normalizer' | 'propagation' | 'undo'`
- `executeDeletion`: `'tool' | 'watcher' | 'reconciler' | 'fullIndex' | 'batch' | 'undo'`

### Per-snapshot restore logic

| Snapshot state       | Current node state | Action                                                                                                    |
|----------------------|--------------------|-----------------------------------------------------------------------------------------------------------|
| `was_deleted = 1`    | exists             | `executeDeletion({ source: 'undo', node_id, unlink_file: true })`                                         |
| `was_deleted = 1`    | absent             | no-op (already gone)                                                                                      |
| `was_deleted = 0`    | exists             | `executeMutation({ source: 'undo', node_id, title/types/fields/body from snapshot })`                      |
| `was_deleted = 0`    | absent (was deleted) | `executeMutation({ source: 'undo', node_id: <snapshot.node_id>, file_path, title/types/fields/body })` — pipeline re-creates with the original `node_id` |

### Node-ID preservation on delete-undo

`executeMutation` currently always assigns a fresh `node_id` when none is passed. The Stage 4 insert is extended: if `node_id` is provided and the row is absent, `INSERT` uses the provided id. Referential continuity is preserved — other nodes' wikilinks by title still resolve, and the resolver's `refreshOnCreate` runs naturally as part of the pipeline.

### Ordering

Operations are processed in **reverse chronological order**. If op A set field X to "foo" and op B later set it to "bar", undoing B then A restores pre-A state.

Within a single operation, snapshots are restored in the order: **creates first, then updates, then deletes**. This avoids a delete-undo referencing a node whose restore-as-create would run later in the same batch.

### Post-undo bookkeeping

On completion, `undo_operations.status` flips to `'undone'` regardless of whether all snapshots restored cleanly — conflicts are documented in the response and resolved via follow-up `resolve_conflicts` calls, which do not re-flip status.

---

## Conflict Detection

Run per snapshot before attempting restore. Conflicted snapshots are excluded from the initial restore pass and returned to the caller.

| Reason                     | Trigger                                                                                                         |
|----------------------------|-----------------------------------------------------------------------------------------------------------------|
| `path_occupied`            | `was_deleted = 0`, current node absent, and a different node currently occupies `snapshot.file_path`.           |
| `modified_after_operation` | Node exists and current `content_hash` ≠ `snapshot.post_mutation_hash` — the file was edited after the op.      |
| `superseded_by_later_op`   | A later `active` `undo_operations` row **not included in the current undo call** has a snapshot for this `node_id` — undoing out of order would skip intermediate history. If the later op is part of the same undo call, it is processed first (reverse-chronological ordering) and no conflict is raised. |

### Conflict response format

```json
{
  "ok": true,
  "data": {
    "total_undone": 4988,
    "total_conflicts": 12,
    "total_skipped": 0,
    "operations": [
      { "operation_id": "op_abc", "node_count": 5000, "status": "undone" }
    ],
    "conflicts": [
      {
        "operation_id": "op_abc",
        "node_id": "n_42",
        "file_path": "Projects/Alpha.md",
        "reason": "modified_after_operation",
        "modified_by": ["update-node at 2026-04-19T14:30:00Z"],
        "current_summary":       { "status": "active" },
        "would_restore_summary": { "status": "draft" }
      }
    ]
  }
}
```

The agent presents conflicts to the user and calls `undo-operations` again with `resolve_conflicts: [{ node_id, action: 'revert' | 'skip' }]`.

---

## MCP Tool Surface

Two tools. Both return the standard response envelope `{ ok, data, warnings, error }`.

### `list-undo-history`

```
Params:
  since?:       string (ISO 8601)
  until?:       string (ISO 8601)
  source_tool?: string  (exact match: 'update-node', 'batch-mutate', etc.)
  status?:      'active' | 'undone' | 'expired' | 'all'  (default: 'active')
  limit?:       number (default 20, max 100)

Returns (data):
  operations: [
    { operation_id, timestamp, source_tool, description, node_count, status }
  ]
  truncated: boolean  (true if result was capped at limit)
```

Pure read. No per-node filter in v1 — the `edits_log` already supports "what happened to this file?" queries via `query-sync-log`.

### `undo-operations`

```
Params (provide exactly one of the two target groups):
  operation_ids?: string[]
  since?:         string
  until?:         string   (defaults to now if since is set)

  dry_run?:            boolean (default: true)
  resolve_conflicts?:  [{ node_id: string, action: 'revert' | 'skip' }]

Returns (data):
  dry_run:           boolean (echoes the input)
  operations:        [{ operation_id, node_count, status: 'would_undo' | 'undone' }]
  conflicts:         [{ operation_id, node_id, file_path, reason, modified_by?, current_summary, would_restore_summary }]
  total_undone:      number   (number of snapshots restored; 0 when dry_run = true)
  total_conflicts:   number
  total_skipped:     number   (resolve_conflicts action='skip' + already-gone nodes)

When dry_run = true, total_undone is always 0; conflicts are still computed and returned so the caller can preview them.
```

**Validation errors** (returned as `error: { code, message }`, no partial execution):

- `INVALID_PARAMS` — neither `operation_ids` nor `since/until` provided; or both provided; or `resolve_conflicts` references a `node_id` not in the pending-conflict set.
- `OPERATION_NOT_FOUND` — a referenced `operation_id` is missing or already `expired` / `undone`.

### `vault-stats` extension

Add `undo: { active_operations: number, total_snapshot_bytes: number }`. Cheap aggregate, informative for agents and users.

---

## Retention & Cleanup

- **Default window:** 24 hours from `timestamp`. Configurable via `UNDO_RETENTION_HOURS` env var.
- **Trigger:** cleanup runs at engine startup and once per hour via `setInterval`, same pattern as `reconciler`.
- **Two-step expiry** for `active` operations: pass 1 flips `status: 'active'` → `'expired'` for rows past retention; pass 2 (next hour) deletes rows already `'expired'`. Prevents an operation from vanishing between `list-undo-history` and `undo-operations`. `undo_snapshots` cascade via FK.
- **Single-step deletion** for `undone` operations: once past retention + one hour, deleted outright. No two-step needed — undo is already done.
- **Orphan sweep:** on every hourly pass, delete `undo_operations` rows where `node_count = 0 AND timestamp < now - 60000` (ms). Covers tool-handler failure cases.
- **No read-path overhead:** `undo_operations` / `undo_snapshots` are never read outside the two MCP tools. No triggers, no impact on main write tables.

**Storage estimate:** ~1–5 KB per node per operation (full body + fields + types JSON). A 5,000-node bulk update with moderate body sizes ≈ 10–25 MB. With 24-hour retention and typical usage, expect 50–200 MB peak. Well under a gigabyte even under aggressive usage.

---

## Edge Cases

- **Tool throws mid-batch:** `batch-mutate`'s outer DB txn rolls back all snapshot writes. The `undo_operations` row, inserted in its own prior txn, survives with `node_count = 0` and is deleted by the orphan sweep.
- **Watcher edit during undo:** `write-lock` already serializes file-level writes. Undo takes the lock per file via the pipeline's normal path.
- **Undo of an undo:** not supported. `source: 'undo'` skips snapshot capture, so undone operations aren't re-recorded. Users re-run the original operation manually if they need the mutation back.
- **Delete-undo into occupied path:** returned as `path_occupied` conflict. User decides via `resolve_conflicts`.
- **`list-undo-history` → `undo-operations` gap:** two-step expiry ensures a row visible in `list` is still actionable for at least one hour.

---

## Observability

Every undo execution writes an `edits_log` entry per restored node via the pipeline's `source: 'undo'` path:

```
event_type: 'undo-restore'
details:    { operation_id, action: 'create' | 'update' | 'delete' }
```

Conflicts produce no `edits_log` entry (no state change) but are returned in the `undo-operations` response.

---

## Non-Goals

- No redo stack.
- No per-field granularity — whole-node snapshot and restore.
- No undo of schema or global-field changes.
- No undo of watcher, normalizer, or propagation-driven changes.
- No cross-session durability guarantees beyond the 24-hour retention window.
- No per-node filter on `list-undo-history` in v1.

---

## Open Questions from Prior Design — Resolved

| # | Prior question                                                                                                  | Resolution                                                                                                                           |
|---|------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| 1 | Should undo history be visible in `vault-stats`?                                                                 | Yes. Adds `undo.active_operations` and `undo.total_snapshot_bytes`.                                                                  |
| 2 | Should `list-undo-history` support filtering by affected node?                                                   | Deferred. `query-sync-log` already covers per-file history via `edits_log`; add only if a concrete need surfaces.                    |
| 3 | Content hash for conflict detection — on `undo_operations` or `undo_snapshots`?                                  | `undo_snapshots.post_mutation_hash`. One operation produces N distinct hashes (one per mutated file); per-snapshot is the only shape that works. |

---

## Implementation Touchpoints

For the implementation plan that follows, the write path changes concentrate in a small number of files:

- `src/db/schema.ts` — new tables + indexes.
- `src/db/migrations/*` — additive migration adding the two tables.
- `src/pipeline/execute.ts` — add `undoContext` param, snapshot write inside Stage-1–6 txn, `source: 'undo'` gate on defaults + REQUIRED_MISSING, accept caller-provided `node_id` on create.
- `src/pipeline/delete.ts` — add `undoContext` param, snapshot write inside deletion txn, `'undo'` source.
- `src/undo/` — new module: `operation.ts` (create/list/expire), `restore.ts` (conflict detection + per-snapshot restore orchestration), `cleanup.ts` (retention sweep).
- `src/mcp/tools/list-undo-history.ts` — new tool.
- `src/mcp/tools/undo-operations.ts` — new tool.
- `src/mcp/tools/vault-stats.ts` — add `undo` aggregate.
- Per-tool handler sites (`create-node`, `update-node`, `add-type-to-node`, `remove-type-from-node`, `rename-node`, `delete-node`, `batch-mutate`) — generate `operation_id` and thread `undoContext` into their pipeline calls; synthesize `description`.
- `src/index.ts` — kick off hourly cleanup interval alongside the reconciler.
- Tests: one integration test per scope tool + conflict scenarios + retention expiry.
