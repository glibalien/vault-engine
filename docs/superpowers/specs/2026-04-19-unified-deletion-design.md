# Unified Deletion — Design

**Date:** 2026-04-19
**Status:** Spec
**Sequence:** 2 of the architecture-review follow-ups
**Addresses:** [Architecture Review 2026-04-18](2026-04-18-architecture-review.md) findings §1a, §1b, §2a, §3b

## Goal

Replace six scattered delete code paths with a single `executeDeletion` sibling to `executeMutation`, sharing the `edits_log` contract so the upcoming undo work has one event shape to reason about.

Closes the structural cause of §1a (`fullIndex` leaks embedding rows), §1b (reconciler drops embedding cleanup), and §2a (`delete-node` bypasses the pipeline). The tactical fixes landed in sequence 1 (`fix/arch-review-bugs`) patched the surface; this sequence removes the drift.

## Non-goals

- MCP response envelope (arch-review §3a) — separate sequence.
- Uniform dry-run across delete tools (§3c) — separate sequence.
- Schema propagation through the pipeline (§2b) — sequence 3.
- Orphan raw-text re-coercion (§2c) — opportunistic, later.
- Removing the `IndexerOptions.onNodeDeleted` callback — becomes vestigial but harmless; revisit during undo work.

## Current state

Six delete sites with drifted cleanup:

| Site | File | `refreshOnDelete` | `removeNode` timing | File unlink |
|---|---|---|---|---|
| `deleteNodeByPath` | `src/indexer/indexer.ts:376` | ✓ | immediate | no |
| `delete-node` tool | `src/mcp/tools/delete-node.ts:92` | ✓ | immediate | yes |
| `batch-mutate` delete | `src/mcp/tools/batch-mutate.ts:200` | no | deferred post-commit | yes, inside outer txn |
| Watcher unlink | `src/sync/watcher.ts:49,148` | via `deleteNodeByPath` | via `deleteNodeByPath` | no |
| Reconciler sweep | `src/sync/reconciler.ts:43` | via `deleteNodeByPath` | via `deleteNodeByPath` | no |
| `fullIndex` bulk delete | `src/indexer/indexer.ts:279-295` | **no** | via `onNodeDeleted` callback | no |

Watcher and reconciler already share `deleteNodeByPath`. `delete-node`, `batch-mutate`, and `fullIndex` each maintain their own cleanup sequence.

## Design

### §1 — Function shape

New file `src/pipeline/delete.ts`, exporting:

```ts
export interface ProposedDeletion {
  source: 'tool' | 'watcher' | 'reconciler' | 'fullIndex' | 'batch';
  node_id: string;              // caller has already resolved identity
  file_path: string;            // vault-relative, for edits_log + unlink
  unlink_file: boolean;         // true = tool/batch; false = watcher/reconciler/fullIndex
  reason?: string;              // optional free-form context stored in details JSON
}

export interface DeletionResult {
  node_id: string;
  file_path: string;
  file_unlinked: boolean;       // true if file is absent after the call (success or ENOENT); false if unlink_file was false or unlink failed
}

export function executeDeletion(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  deletion: ProposedDeletion,
  syncLogger?: SyncLogger,
): DeletionResult;
```

**Responsibilities, in order:**

1. Open a DB transaction.
2. Delete FTS entry (`nodes_fts` by rowid).
3. Insert `edits_log` row:
   - `event_type = 'file-deleted'`
   - `node_id`, `timestamp = Date.now()`
   - `details = JSON.stringify({ file_path, source, reason? })`
4. `DELETE FROM nodes WHERE id = ?` (CASCADE handles `node_types`, `node_fields`, `relationships`).
5. Commit txn.
6. `refreshOnDelete(db, node_id)`.
7. If `unlink_file`: acquire `writeLock.withLockSync(absPath, ...)`, call `unlinkSync(absPath)` inside lock, wrapped in `try/catch` (swallowed — matches current behavior across all call sites today). `DeletionResult.file_unlinked` = `true` on success OR ENOENT (desired end state achieved in both cases); `false` on any other error. Improving unlink error handling beyond silent swallow is the arch review's §4 minor debt and is explicitly out of scope here.
8. Return `DeletionResult`.

**Not the function's job:** embedding cleanup. Callers are responsible for `embeddingIndexer?.removeNode(result.node_id)`, documented on the function. This preserves `batch-mutate`'s existing rollback discipline (its post-commit `deletedNodeIds` loop continues to work) and avoids special-casing the nested-transaction caller inside `executeDeletion`.

### §2 — Call-site migration

| Site | Before | After |
|---|---|---|
| `delete-node` tool | raw txn + `refreshOnDelete` + `removeNode` + `unlinkSync` inline | `executeDeletion({source:'tool', unlink_file:true})` → `embeddingIndexer?.removeNode()` |
| `batch-mutate` delete op | raw SQL inside outer txn; `unlinkSync` inside; `deletedNodeIds` accumulated for post-commit `removeNode` | `executeDeletion({source:'batch', unlink_file:true})` inside outer txn; `deletedNodeIds` loop unchanged post-commit |
| Watcher unlink | `deleteNodeByPath(relPath, db, embeddingIndexer)` | `executeDeletion({source:'watcher', unlink_file:false})` → `embeddingIndexer?.removeNode()` |
| Reconciler sweep | `deleteNodeByPath(node.file_path, db, embeddingIndexer)` | `executeDeletion({source:'reconciler', unlink_file:false})` → `embeddingIndexer?.removeNode()` |
| `fullIndex` bulk-delete | inline FTS + `edits_log` + `deleteNode` + `onNodeDeleted` callback | `executeDeletion({source:'fullIndex', unlink_file:false})` inside existing transaction; `onNodeDeleted` callback stays (forwards to caller) |
| `deleteNodeByPath` | helper in `src/indexer/indexer.ts` | **deleted** — consumers migrate to `executeDeletion` |

**Consequences:**

- `fullIndex` gains `refreshOnDelete` (currently missing). No behavioral impact today because `refreshOnDelete` is a v1 no-op, but prevents drift when it gains behavior.
- `batch-mutate`'s rollback semantics unchanged: DB-level deletions happen inside the outer transaction (so they roll back); embedding cleanup happens after commit (so rolled-back deletions don't leak rows).
- `delete-node` tool's `confirm: false` preview-mode response shape is unchanged. Only the confirmed-delete arm changes.
- Watcher and reconciler behavior is identical from the user's POV — same final DB state, same `edits_log` entries (now with structured `details`).
- `deleteNodeByPath` export removed from `src/indexer/index.ts`. Grep confirms the only external consumers are watcher + reconciler, both migrating in this sequence.

### §3 — `edits_log` contract for deletions

**Before:** `INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, 'file-deleted', ?)` — `details` = plain `file_path` string. Shape varies slightly across the 6 sites (same columns, same event_type, but not centrally owned).

**After:** same columns and event_type; `details` becomes JSON:

```json
{ "file_path": "Notes/foo.md", "source": "tool", "reason": "confirmed by user" }
```

`reason` is optional; omitted when caller doesn't supply. No schema migration required — `details` is already `TEXT`.

**Consumer risk:** `details` is read only by `query-sync-log` for display. No programmatic parsing in the codebase. Existing `'file-deleted'` rows remain as plain strings; new rows are JSON. Display tools that print `details` verbatim continue to work.

**Undo relevance:** `source` tells future undo logic what kind of delete it was — `'tool'` and `'batch'` are user-initiated (candidate for undo); `'watcher'`/`'reconciler'`/`'fullIndex'` are sync-driven (the user already removed the file, so "undo" means restoring from backup or declining).

## Test strategy

**New unit tests for `executeDeletion`:**

- Emits exactly one `edits_log` row with correct JSON `details`.
- `refreshOnDelete` is called.
- CASCADE removes `node_fields`, `node_types`, `relationships`.
- Embedding cleanup is NOT invoked internally (verify `embeddingIndexer` is not imported / not referenced in the module).
- `unlink_file: true` with present file → `file_unlinked = true`.
- `unlink_file: true` with ENOENT → `file_unlinked = true` (end state achieved, swallowed).
- `unlink_file: true` with permission error → `file_unlinked = false` (swallowed, no throw).
- `unlink_file: false` → `file_unlinked = false`, filesystem untouched.

**Per call-site routing tests:**

- `delete-node` → assert `edits_log.details` contains `"source":"tool"`.
- `batch-mutate` delete → assert `"source":"batch"` and that `deletedNodeIds` are passed to post-commit `removeNode`.
- Watcher unlink path → `"source":"watcher"`.
- Reconciler sweep → `"source":"reconciler"`.
- `fullIndex` bulk delete → `"source":"fullIndex"` + `refreshOnDelete` now called.

**Regression guard** (the gap the code reviewer flagged at the end of sequence 1): one integration test where a reconciler sweep both detects deletions and encounters a per-file error in the same pass — confirms the deletion branch continues to function when a sibling file errors.

**Existing coverage preserved:** each of the 4 bug-fix tests from sequence 1 (`embedding-cleanup-fullindex.test.ts`, `embedding-cleanup-reconciler.test.ts`, `reconciler-error-logging.test.ts`) should pass unchanged — they assert observable behavior, which `executeDeletion` preserves.

## Risk notes

- **`embedding_vec` rollback semantics** — the reason `batch-mutate` defers `removeNode` to post-commit. The design preserves this by putting embedding cleanup in caller hands. If we ever move embedding cleanup inside `executeDeletion`, revisit under that lens.
- **`deleteNodeByPath` removal** — pure rename/restructure; no external callers outside `src/sync/`.
- **Edits-log shape shift for deletion rows** — deliberate. Non-deletion rows unchanged. Verify no `details LIKE '...'` style matching exists on `'file-deleted'` rows.

## Sequencing

One implementation pass, roughly:

1. Write `src/pipeline/delete.ts` + unit tests for `executeDeletion`.
2. Migrate `delete-node` tool; update its tests.
3. Migrate `batch-mutate` delete op; update its tests.
4. Migrate watcher + reconciler; update their tests.
5. Migrate `fullIndex` bulk-delete; update its test (the sequence-1 `embedding-cleanup-fullindex.test.ts` should still pass).
6. Delete `deleteNodeByPath` + update `src/indexer/index.ts` exports.
7. Add the regression guard test.
8. Full `npm run build` + `npm test`.

No DB migration. No behavioral change visible from MCP tool surface.
