# WriteGate Cancellation & Sync Log Design

Addresses Priority 4 (tool writes cancel pending WriteGate writes) and Priority 8 (per-file event timeline instrumentation) from the Obsidian Clobbering Analysis.

## Problem

### Priority 4: Tool writes don't cancel pending WriteGate writes

When the watcher processes a file change, it updates the DB immediately and schedules a deferred file write via the WriteGate (3-second quiet period). If a tool writes the same file during that window, the pending deferred write is not cancelled.

The stale-file guard in the WriteGate callback usually prevents damage (disk hash won't match DB hash after a tool write). But there's a race window: if the WriteGate fires before chokidar delivers the tool-write event to the watcher (which would cancel the pending write via `scheduleIndex`), the stale-file guard sees matching hashes (tool updated both disk and DB) and proceeds to re-render from DB state, potentially re-canonicalizing formatting.

The same gap exists for propagation writes (`propagate.ts`), which write files directly without cancelling pending WriteGate writes.

### Priority 8: No per-file event timeline

The existing `edits_log` table tracks semantic deviations (coercions, rejections, defaults, conflicts) but not the mechanical timeline of file synchronization events. When clobbering occurs, there's no way to reconstruct what happened: which writer acted, in what order, with what hash, and whether guards fired or were bypassed.

## Design

### Priority 4: WriteGate Cancellation

#### Change 1: `executeMutation` gains optional `writeGate` parameter

Add `writeGate?: WriteGate` as a 5th parameter to `executeMutation`. At the top of Stage 6, before the file write, if the mutation will write a file (`!db_only`) and a `writeGate` is provided, cancel any pending deferred write:

```typescript
export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  writeGate?: WriteGate,
): PipelineResult {
  // ...existing code...
  
  // Stage 6: Write
  return writeLock.withLockSync(absPath, () => {
    const shouldWriteFile = !mutation.db_only;
    if (shouldWriteFile && writeGate) {
      writeGate.cancel(mutation.file_path);
    }
    if (shouldWriteFile) {
      atomicWriteFile(absPath, fileContent, tmpDir);
    }
    // ...rest of Stage 6...
  });
}
```

The cancellation happens inside the write lock, so there's no race between cancellation and the actual write.

#### Change 2: Tool registrations pass `writeGate`

All 7 mutation tool registration functions gain an optional `writeGate` parameter and forward it to `executeMutation`:

- `registerCreateNode`
- `registerUpdateNode`
- `registerDeleteNode` (for rename-triggered re-renders)
- `registerAddTypeToNode`
- `registerRemoveTypeFromNode`
- `registerRenameNode`
- `registerBatchMutate`

`tools/index.ts` passes `ctx.writeGate` to each.

#### Change 3: Propagation cancels before writing

`propagateSchemaChange` and `rerenderNodesWithField` gain an optional `writeGate` parameter. Before each `atomicWriteFile` call, cancel pending writes:

```typescript
if (writeGate) writeGate.cancel(nodeRow.file_path);
writeLock.withLockSync(absPath, () => {
  atomicWriteFile(absPath, fileContent, tmpDir);
  // ...DB updates...
});
```

Callers in schema tools (`create-schema`, `update-schema`, `delete-schema`, `update-global-field`, `rename-global-field`) pass `writeGate` through.

### Priority 8: Sync Log

#### New table: `sync_log`

```sql
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  event TEXT NOT NULL,
  source TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_file_path ON sync_log(file_path);
CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
```

#### New module: `src/sync/sync-logger.ts`

```typescript
export class SyncLogger {
  constructor(private db: Database.Database) {
    // Prune entries older than 24 hours on construction
    db.prepare('DELETE FROM sync_log WHERE timestamp < ?').run(Date.now() - 86_400_000);
  }

  watcherEvent(filePath: string, hash: string, size: number): void
  parseRetry(filePath: string, attempt: number, error: string): void
  deferredWriteScheduled(filePath: string): void
  deferredWriteCancelled(filePath: string, reason: string): void
  deferredWriteFired(filePath: string): void
  deferredWriteSkipped(filePath: string, reason: string): void
  fileWritten(filePath: string, source: string, hash: string): void
  noop(filePath: string, source: string): void
}
```

Each method inserts one row into `sync_log`. The `details` column holds a JSON object with method-specific data. The `source` column captures `tool`, `watcher`, `propagation`, or `reconciler`.

#### Event definitions

| Event | Logged at | Source | Details |
|-------|-----------|--------|---------|
| `watcher-event` | `watcher.ts` `scheduleIndex` | `watcher` | `{ hash, size }` |
| `parse-retry` | `watcher.ts` retry logic | `watcher` | `{ attempt, error }` |
| `deferred-write-scheduled` | `watcher.ts` WriteGate callback setup | `watcher` | `{}` |
| `deferred-write-cancelled` | Cancel call sites | varies | `{ reason }` — one of: `new-edit`, `tool-write`, `unlink`, `propagation` |
| `deferred-write-fired` | `watcher.ts` WriteGate callback entry | `watcher` | `{}` |
| `deferred-write-skipped` | `watcher.ts` WriteGate callback guards | `watcher` | `{ reason }` — one of: `node-deleted`, `file-gone`, `stale-file`, `semantic-match`, `parse-failed` |
| `file-written` | `execute.ts` Stage 6, `propagate.ts` | varies | `{ hash }` |
| `noop` | `execute.ts` Stage 5 no-op check | varies | `{}` |

#### Cancellation reason logging

Callers of `writeGate.cancel()` log the cancellation reason themselves. WriteGate remains infrastructure-only (no logger dependency). Reasons by call site:

- `watcher.ts` `scheduleIndex`: reason `new-edit`
- `watcher.ts` `handleUnlink`: reason `unlink`
- `execute.ts` Stage 6 (Priority 4 cancellation): reason `tool-write`
- `propagate.ts` before `atomicWriteFile`: reason `propagation`

#### Plumbing

`SyncLogger` is created in `index.ts` alongside `WriteGate`:

```typescript
const syncLogger = new SyncLogger(db);
```

Passed to:
- `startWatcher(vaultPath, db, mutex, writeLock, writeGate, syncLogger)`
- `startReconciler(vaultPath, db, mutex, writeLock, writeGate, syncLogger)`
- `createServer(db, { writeLock, writeGate, syncLogger, vaultPath, ... })`
- `executeMutation(db, writeLock, vaultPath, mutation, writeGate, syncLogger)`
- `propagateSchemaChange(db, writeLock, vaultPath, schemaName, diff, writeGate, syncLogger)`
- `rerenderNodesWithField(db, writeLock, vaultPath, fieldName, additionalNodeIds, writeGate, syncLogger)`

#### Auto-pruning

Constructor prunes rows older than 24 hours. This runs once per engine startup. No ongoing timer needed — the table stays bounded for typical usage patterns (thousands of events/day, not millions).

## Files changed

### New files
- `src/sync/sync-logger.ts` — SyncLogger class

### Modified files
- `src/db/schema.ts` — add `sync_log` table and indexes
- `src/sync/watcher.ts` — accept SyncLogger, log events at all key points
- `src/pipeline/execute.ts` — accept writeGate + syncLogger, cancel + log in Stage 5/6
- `src/pipeline/types.ts` — no change needed (writeGate/syncLogger are not on ProposedMutation)
- `src/schema/propagate.ts` — accept writeGate + syncLogger, cancel + log before writes
- `src/mcp/server.ts` — add syncLogger to ServerContext
- `src/mcp/tools/index.ts` — pass writeGate + syncLogger to mutation tools
- `src/mcp/tools/create-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/update-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/delete-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/add-type-to-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/remove-type-from-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/rename-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/batch-mutate.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/create-schema.ts` — pass writeGate + syncLogger to propagation
- `src/mcp/tools/update-schema.ts` — pass writeGate + syncLogger to propagation
- `src/mcp/tools/delete-schema.ts` — pass writeGate + syncLogger to propagation
- `src/mcp/tools/update-global-field.ts` — pass writeGate + syncLogger to rerenderNodesWithField
- `src/mcp/tools/rename-global-field.ts` — pass writeGate + syncLogger to rerenderNodesWithField
- `src/sync/reconciler.ts` — accept + forward syncLogger
- `src/index.ts` — create SyncLogger, pass to all consumers

### Test files
- New: `tests/sync/sync-logger.test.ts` — unit tests for SyncLogger
- New: `tests/sync/writegate-cancellation.test.ts` — integration tests for Priority 4 cancellation
- Modified: existing watcher/pipeline tests may need syncLogger parameter added
