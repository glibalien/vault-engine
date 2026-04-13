# WriteGate Cancellation & Sync Log Design

Addresses Priority 4 (tool writes cancel pending WriteGate writes) and Priority 8 (per-file event timeline instrumentation) from the Obsidian Clobbering Analysis.

## Problem

### Priority 4: Tool writes don't cancel pending WriteGate writes

When the watcher processes a file change, it updates the DB immediately and schedules a deferred file write via the WriteGate (3-second quiet period). If a tool writes the same file during that window, the pending deferred write is not cancelled.

The stale-file guard in the WriteGate callback usually prevents damage (disk hash won't match DB hash after a tool write). But there's a race window: if the WriteGate fires before chokidar delivers the tool-write event to the watcher (which would cancel the pending write via `scheduleIndex`), the stale-file guard sees matching hashes (tool updated both disk and DB) and proceeds to re-render from DB state, potentially re-canonicalizing formatting.

The same gap exists for propagation writes (`propagate.ts`), which write files directly without cancelling pending WriteGate writes.

A subtler variant: a tool mutation that resolves to a Stage 5 no-op still confirms "DB state is what I want," which means any pending deferred write (scheduled before the tool touched the file) is operating on superseded intent. The stale-file guard won't catch this because nothing changed on disk or in DB.

### Priority 8: No per-file event timeline

The existing `edits_log` table tracks semantic deviations (coercions, rejections, defaults, conflicts) but not the mechanical timeline of file synchronization events. When clobbering occurs, there's no way to reconstruct what happened: which writer acted, in what order, with what hash, and whether guards fired or were bypassed.

### Orthogonality to serializer bugs

P4 and P8 are orthogonal to any YAML serialization bugs (flow-style arrays, stringified-list API responses, etc.). The race condition exists regardless of what WriteGate writes — fixing the serializer would reduce the *visibility* of clobbering (fewer cosmetic diffs) but not its *occurrence*. Both workstreams proceed independently.

## Design

### Priority 4: WriteGate Cancellation

#### Change 1: `executeMutation` gains optional `writeGate` parameter

Add `writeGate?: WriteGate` as a 5th parameter to `executeMutation`. Cancellation happens at two points:

**Stage 5 (no-op path):** Before returning the no-op result, if `source === 'tool'` and `writeGate` is provided, cancel any pending deferred write with reason `tool-write`. A tool no-op confirms DB state matches the intended tool state, superseding any pending watcher-originated deferred write.

**Stage 6 (write path):** Before the file write, if `source === 'tool'` and `writeGate` is provided, cancel any pending deferred write with reason `tool-write`. The cancellation happens inside the write lock, so there's no race between cancellation and the actual write.

```typescript
export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): PipelineResult {
  // ...existing code...

  // Stage 5: No-op check
  if (mutation.node_id !== null && existingContent !== null && ...) {
    // Tool no-ops cancel pending deferred writes
    if (mutation.source === 'tool' && writeGate) {
      writeGate.cancel(mutation.file_path);
      syncLogger?.deferredWriteCancelled(mutation.file_path, 'tool-write');
    }
    syncLogger?.noop(mutation.file_path, mutation.source);
    return { ... _noop: true };
  }

  // Stage 6: Write
  return writeLock.withLockSync(absPath, () => {
    const shouldWriteFile = !mutation.db_only;
    if (shouldWriteFile && mutation.source === 'tool' && writeGate) {
      writeGate.cancel(mutation.file_path);
      syncLogger?.deferredWriteCancelled(mutation.file_path, 'tool-write');
    }
    if (shouldWriteFile) {
      atomicWriteFile(absPath, fileContent, tmpDir);
      syncLogger?.fileWritten(mutation.file_path, mutation.source, renderedHash);
    }
    // ...rest of Stage 6...
  });
}
```

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

`propagateSchemaChange` and `rerenderNodesWithField` gain optional `writeGate` and `syncLogger` parameters. Before each `atomicWriteFile` call, cancel pending writes:

```typescript
if (writeGate) {
  writeGate.cancel(nodeRow.file_path);
  syncLogger?.deferredWriteCancelled(nodeRow.file_path, 'propagation');
}
writeLock.withLockSync(absPath, () => {
  atomicWriteFile(absPath, fileContent, tmpDir);
  syncLogger?.fileWritten(nodeRow.file_path, 'propagation', renderedHash);
  // ...DB updates...
});
```

Callers in schema tools (`create-schema`, `update-schema`, `delete-schema`, `update-global-field`, `rename-global-field`) pass `writeGate` and `syncLogger` through.

#### Change 4: Rename cancels on old path

In `registerRenameNode`, before the unlink of the old path, call `writeGate.cancel(oldPath)` with reason `unlink`. This prevents a stale deferred write from producing a confusing `deferred-write-skipped { reason: "file-gone" }` timeline entry. Minor cleanliness; not a correctness fix.

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
  private insertCount = 0;
  private readonly retentionMs: number;

  constructor(private db: Database.Database) {
    const hours = parseInt(process.env.SYNC_LOG_RETENTION_HOURS ?? '24', 10);
    this.retentionMs = (isNaN(hours) ? 24 : hours) * 3_600_000;
    this.prune();
  }

  watcherEvent(filePath: string, hash: string, size: number): void
  parseRetry(filePath: string, attempt: number, error: string): void
  deferredWriteScheduled(filePath: string): void
  deferredWriteCancelled(filePath: string, reason: string): void
  deferredWriteFired(filePath: string, intendedHash: string): void
  deferredWriteSkipped(filePath: string, reason: string, intendedHash?: string, diskHash?: string): void
  fileWritten(filePath: string, source: string, hash: string): void
  noop(filePath: string, source: string): void

  private log(filePath: string, event: string, source: string, details: Record<string, unknown>): void {
    this.db.prepare(
      'INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)'
    ).run(Date.now(), filePath, event, source, JSON.stringify(details));
    if (++this.insertCount % 1000 === 0) this.prune();
  }

  private prune(): void {
    this.db.prepare('DELETE FROM sync_log WHERE timestamp < ?').run(Date.now() - this.retentionMs);
  }
}
```

Each method inserts one row into `sync_log`. The `details` column holds a JSON object with method-specific data. The `source` column captures `tool`, `watcher`, `propagation`, or `reconciler`.

Auto-pruning runs at startup and every 1000 inserts. Retention is configurable via `SYNC_LOG_RETENTION_HOURS` env var (default 24, extend to 72 or 168 during active debugging).

#### Event definitions

| Event | Logged at | Source | Details |
|-------|-----------|--------|---------|
| `watcher-event` | `watcher.ts` `scheduleIndex` | `watcher` | `{ hash, size }` |
| `parse-retry` | `watcher.ts` retry logic | `watcher` | `{ attempt, error }` |
| `deferred-write-scheduled` | `watcher.ts` WriteGate callback setup | `watcher` | `{}` |
| `deferred-write-cancelled` | Cancel call sites | varies | `{ reason }` — one of: `new-edit`, `tool-write`, `unlink`, `propagation` |
| `deferred-write-fired` | `watcher.ts` WriteGate callback entry | `watcher` | `{ intended_hash }` |
| `deferred-write-skipped` | `watcher.ts` WriteGate callback guards | `watcher` | `{ reason, intended_hash?, disk_hash? }` — reason one of: `node-deleted`, `file-gone`, `stale-file`, `semantic-match`, `parse-failed` |
| `file-written` | `execute.ts` Stage 6, `propagate.ts` | varies | `{ hash }` |
| `noop` | `execute.ts` Stage 5 no-op check | varies | `{}` |

#### Cancellation reason logging

Callers of `writeGate.cancel()` log the cancellation reason themselves. WriteGate remains infrastructure-only (no logger dependency). Reasons by call site:

- `watcher.ts` `scheduleIndex`: reason `new-edit`
- `watcher.ts` `handleUnlink`: reason `unlink`
- `execute.ts` Stage 5/6 (Priority 4 cancellation): reason `tool-write`
- `propagate.ts` before `atomicWriteFile`: reason `propagation`
- `rename-node.ts` before old-path unlink: reason `unlink`

#### New MCP tool: `query-sync-log`

Without a read path, the instrumentation requires SQLite shell access, defeating its purpose. A new MCP tool provides the forensic interface.

**Parameters:**
- `file_path?: string` — filter to a single file (most common use case)
- `since?: string` — ISO timestamp or relative (`"1h"`, `"30m"`)
- `events?: string[]` — filter to specific event types
- `source?: string` — filter by source
- `limit?: number` — default 100, max 1000
- `sort_order?: "asc" | "desc"` — default `asc` (chronological)

Returns rows as structured objects with parsed `details` JSON.

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

## Sample timelines

### Normal tool write (no Obsidian involvement)

```
file-written { source: "update-node", hash: "abc123" }
watcher-event { hash: "abc123", size: 1234 }
noop { source: "watcher" }
```

The watcher observes the tool write, checks hash, finds it matches DB, no-ops.

### Normal Obsidian edit (no tool involvement)

```
watcher-event { hash: "def456", size: 1240 }
deferred-write-scheduled { }
deferred-write-fired { intended_hash: "def456" }
deferred-write-skipped { reason: "semantic-match", intended_hash: "def456", disk_hash: "def456" }
```

Watcher fires, schedules deferred write, callback runs, semantic-match guard skips.

### Race that P4 prevents

```
watcher-event { hash: "def456", size: 1240 }        <- Obsidian edit
deferred-write-scheduled { }
                                                     <- tool write arrives
deferred-write-cancelled { reason: "tool-write" }
file-written { source: "update-node", hash: "ghi789" }
watcher-event { hash: "ghi789", size: 1250 }        <- watcher observes tool write
noop { source: "watcher" }
```

Pre-P4, the deferred write would fire between the Obsidian edit and the tool write, potentially clobbering the tool's intended state.

## Verification

### Regression tests

New file: `tests/sync/writegate-cancellation.test.ts`

**Test: tool write cancels pending deferred write**
1. Set up engine with short WriteGate quiet period (100ms).
2. Simulate watcher event on `foo.md` -> deferred write scheduled at T+100ms.
3. At T+50ms, call `update-node` on `foo.md`.
4. Assert: `deferred-write-cancelled { reason: "tool-write" }` in sync_log.
5. Wait until T+200ms.
6. Assert: no `deferred-write-fired` event for `foo.md`.
7. Assert: exactly one `file-written` event (from tool).

**Test: tool no-op cancels pending deferred write**

**Test: propagation cancels pending deferred write**

**Test: rename cancels pending deferred write on old path**

### Manual verification after deployment

1. Open `foo.md` in Obsidian, make an edit, save.
2. Within 3 seconds, call `update-node` on `foo.md` via tool.
3. Call `query-sync-log { file_path: "foo.md", limit: 20 }`.
4. Confirm timeline: `watcher-event` -> `deferred-write-scheduled` -> `deferred-write-cancelled (tool-write)` -> `file-written (source: update-node)`.
5. Confirm no `deferred-write-fired` event for that file.

## Files changed

### New files
- `src/sync/sync-logger.ts` — SyncLogger class
- `src/mcp/tools/query-sync-log.ts` — query-sync-log MCP tool

### Modified files
- `src/db/schema.ts` — add `sync_log` table and indexes
- `src/sync/watcher.ts` — accept SyncLogger, log events at all key points
- `src/pipeline/execute.ts` — accept writeGate + syncLogger, cancel + log in Stage 5/6
- `src/pipeline/types.ts` — no change needed (writeGate/syncLogger are not on ProposedMutation)
- `src/schema/propagate.ts` — accept writeGate + syncLogger, cancel + log before writes
- `src/mcp/server.ts` — add syncLogger to ServerContext
- `src/mcp/tools/index.ts` — pass writeGate + syncLogger to mutation tools, register query-sync-log
- `src/mcp/tools/create-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/update-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/delete-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/add-type-to-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/remove-type-from-node.ts` — accept + forward writeGate, syncLogger
- `src/mcp/tools/rename-node.ts` — accept + forward writeGate, syncLogger, cancel on old path
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
- New: `tests/mcp/tools/query-sync-log.test.ts` — unit tests for query-sync-log tool
- Modified: existing watcher/pipeline tests may need syncLogger parameter added
