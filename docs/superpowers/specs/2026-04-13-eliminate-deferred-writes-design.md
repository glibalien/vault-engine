# Eliminate Deferred Writes from Watcher Path

**Date:** 2026-04-13
**Status:** Draft
**Problem:** Engine writes files while Obsidian has them open, causing Obsidian's merge/reload logic to corrupt frontmatter.

## Background

The watcher detects file changes, updates the DB (`db_only: true`), then schedules a deferred write via WriteGate (3-second quiet period). The deferred write re-renders the file from DB state and writes it to disk. When the user is actively editing in Obsidian, this creates a race:

1. User edits file in Obsidian
2. Watcher ingests edit, updates DB, schedules deferred write
3. 3 seconds of quiet pass
4. Engine writes file to disk
5. Obsidian detects external change and tries to merge/reload
6. Merge produces corrupted frontmatter

**Observed corruptions:**
- `meeting\ndate:` collapsed into `meetDate:` (text-level merge across line boundaries)
- `priority: 3` lost its key, bare `3` on a line (YAML parse failure)
- Field values absorbed into types array, objects stringified as `[object Object]`

Previous attempts to fix this by adjusting the quiet period (timing-based approaches) have not solved the problem. The fundamental issue is that any engine write while Obsidian has a file open is risky.

## Design

### Principle

The DB is always authoritative. Files on disk may lag behind DB state (missing defaults, un-coerced values, stale formatting) but are never clobbered by the engine while the user is editing. Files catch up via tool writes and the reconciler.

### Change 1: Remove deferred writes from watcher path

**File:** `src/sync/watcher.ts`

In `processFileChange`, after `executeMutation(db_only: true)`, the code currently checks `result.deferred_write` and hands a callback to the WriteGate. Remove this entire block (lines 318-415). The watcher path becomes: parse file, update DB, done. No file writes.

The `db_only` flag in `processFileChange` becomes unconditionally `true` — the `writeGate !== undefined` check at line 296 is replaced with a hard `true`.

Additional dead code to remove from `processFileChange`:
- `rebuildFieldsFromDb()` helper (only used by deferred write callback)
- `rebuildRawTextsFromDb()` helper (only used by deferred write callback)
- WriteGate cancel logic in `scheduleIndex()` (lines 63-66)

In `executeMutation`, the `deferred_write` computation (line 336-337) becomes dead — no caller reads it. Remove the `deferred_write` field from `PipelineResult` type and the computation. The `db_only` field on `ProposedMutation` stays (tools still use it).

### Change 2: Remove WriteGate

**Files to modify:**
- Delete `src/sync/write-gate.ts`
- Delete `tests/sync/write-gate.test.ts`
- Delete `tests/sync/writegate-cancellation.test.ts`
- Remove WriteGate from `src/sync/index.ts` exports
- Remove WriteGate creation and disposal from `src/index.ts`
- Remove `writeGate` parameter from `startWatcher` signature
- Remove `writeGate` parameter from `startReconciler` signature
- Remove `writeGate` parameter from `processFileChange` signature
- Remove `writeGate` parameter from `executeMutation` signature
- Remove `writeGate` parameter from `propagateSchemaChange` and `rerenderNodesWithField` in `src/schema/propagate.ts`
- Remove `writeGate` from `createServer` context in `src/mcp/server.ts`
- Remove `writeGate` parameter from all tool registration functions in `src/mcp/tools/`
- Remove all `writeGate.cancel()` calls from tool handlers (`delete-node.ts`, `rename-node.ts`) and propagation code
- Remove `writeGate.cancel()` and related `syncLogger?.deferredWriteCancelled()` calls from `executeMutation` in `src/pipeline/execute.ts`

### Change 3: Remove deferred-write sync logger methods

**File:** `src/sync/sync-logger.ts`

Remove these methods (they become dead code):
- `deferredWriteScheduled()`
- `deferredWriteCancelled()`
- `deferredWriteFired()`
- `deferredWriteSkipped()`

Keep: `watcherEvent()`, `parseRetry()`, `fileWritten()`, `noop()`

### Change 4: Parser guard against type corruption

**File:** `src/parser/frontmatter.ts`

Replace `rawTypes.map(String)` (line 167) with filtering that:
1. Only accepts string elements (drops objects, arrays, numbers, booleans)
2. Strips `[[...]]` wikilink brackets from type strings (same stripping the parser already does for field values)

```typescript
if (Array.isArray(rawTypes)) {
    types = rawTypes
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.replace(/^\[\[(.+)\]\]$/, '$1'));
}
```

This prevents corruption from propagating into the DB if Obsidian or a filesystem race ever produces garbled YAML in the types array.

### Change 5: Reconciler continues to work as DB-only updater

**File:** `src/sync/reconciler.ts`

The reconciler currently calls `processFileChange` and passes `writeGate`. After WriteGate removal, `processFileChange` always uses `db_only: true`, so the reconciler naturally becomes a DB-only updater. No changes needed to reconciler logic — it just stops passing writeGate.

The reconciler serves as the backstop: if the watcher misses a change (e.g., during startup), the reconciler catches it on its next sweep (2 minutes initial delay, 15-minute interval). It updates the DB but does not write files.

## What stays the same

- **Tool writes** continue to work exactly as before: `executeMutation` with `source: 'tool'` and `db_only: false` renders from DB state and writes the file immediately. This naturally brings the file up to date with any pending defaults/coercions whenever a tool touches the node.
- **Schema propagation** (`propagateSchemaChange`, `rerenderNodesWithField`) continues to write files immediately — these are tool-initiated operations.
- **Write lock** stays — it prevents the watcher from processing a file while a tool is writing it.
- **Stale-file guard** in the watcher (`content_hash` check) stays — it prevents redundant DB updates.
- **Parse retry** logic stays — it handles Obsidian's truncation window.

## Trade-offs

**Accepted:** Files on disk may be "cosmetically stale" after the watcher processes a change. Examples:
- User adds a type with schema defaults. DB has the defaults, file doesn't show them until a tool writes the node.
- User writes a value that gets coerced (e.g., string → date). DB has the coerced value, file keeps the original until a tool writes.

This is acceptable because:
- The DB is authoritative — queries and tools see correct data.
- Tool writes are the natural moment to update files (user is interacting with the engine, not mid-edit in Obsidian).
- The stale formatting is what the user wrote — it's not wrong from their perspective.

**Eliminated:** All risk of engine-initiated file writes racing with Obsidian saves.

## Files changed (summary)

| File | Change |
|------|--------|
| `src/sync/write-gate.ts` | Delete |
| `src/sync/watcher.ts` | Remove deferred write block + 2 dead helpers, remove writeGate param, hard-code db_only, remove WriteGate cancel in scheduleIndex |
| `src/sync/reconciler.ts` | Remove writeGate param |
| `src/sync/sync-logger.ts` | Remove 4 deferred-write methods |
| `src/sync/index.ts` | Remove WriteGate exports |
| `src/pipeline/execute.ts` | Remove writeGate param, remove cancel calls, remove deferred_write from PipelineResult |
| `src/pipeline/types.ts` | Remove deferred_write field from PipelineResult type |
| `src/schema/propagate.ts` | Remove writeGate param from 2 functions, remove cancel calls |
| `src/parser/frontmatter.ts` | Filter non-strings, strip wikilink brackets from types |
| `src/index.ts` | Remove WriteGate creation/disposal, update startWatcher/startReconciler/createServer calls |
| `src/mcp/server.ts` | Remove writeGate from context type |
| `src/mcp/tools/index.ts` | Remove writeGate from tool registration |
| `src/mcp/tools/*.ts` (10 files) | Remove writeGate param from register functions and executeMutation calls |
| `tests/sync/write-gate.test.ts` | Delete |
| `tests/sync/writegate-cancellation.test.ts` | Delete |
| `tests/sync/watcher.test.ts` | Update: remove deferred-write test cases, remove WriteGate from setup |
| `tests/pipeline/execute.test.ts` | Update: remove WriteGate from setup |
| `tests/integration/end-to-end.test.ts` | Update: remove WriteGate from setup |
