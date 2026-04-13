# Eliminate Deferred Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove time-based deferred file writes from the watcher path to prevent Obsidian merge collisions that corrupt frontmatter.

**Architecture:** The watcher path becomes DB-only (no file writes). WriteGate is removed entirely. Tool writes and schema propagation continue to write files immediately. The parser gets a guard against non-string types.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, yaml

**Spec:** `docs/superpowers/specs/2026-04-13-eliminate-deferred-writes-design.md`

---

### Task 1: Parser guard — filter non-string types and strip wikilink brackets

**Files:**
- Modify: `src/parser/frontmatter.ts:163-171`
- Modify: `tests/parser/frontmatter.test.ts` (add new test cases)

- [ ] **Step 1: Write failing tests for non-string type filtering**

Add to the existing frontmatter test file:

```typescript
it('filters out non-string elements from types array', () => {
  const raw = '---\ntypes:\n  - meeting\n  - date: 2026-04-13\n  - true\n  - 42\n---\nBody.\n';
  const result = parseFrontmatter(raw);
  expect(result.types).toEqual(['meeting']);
});

it('strips [[wikilink]] brackets from type strings', () => {
  const raw = '---\ntypes:\n  - "[[person]]"\n  - meeting\n---\nBody.\n';
  const result = parseFrontmatter(raw);
  expect(result.types).toEqual(['person', 'meeting']);
});

it('handles types array with only non-string elements', () => {
  const raw = '---\ntypes:\n  - date: 2026-04-13\n  - status: active\n---\nBody.\n';
  const result = parseFrontmatter(raw);
  expect(result.types).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser/frontmatter.test.ts`
Expected: 3 new tests FAIL (non-string elements pass through as `[object Object]`, wikilink brackets preserved)

- [ ] **Step 3: Implement the type filtering**

In `src/parser/frontmatter.ts`, replace lines 166-167:

```typescript
// Before:
if (Array.isArray(rawTypes)) {
    types = rawTypes.map(String);
}
```

```typescript
// After:
if (Array.isArray(rawTypes)) {
    types = rawTypes
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.replace(/^\[\[(.+)\]\]$/, '$1'));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser/frontmatter.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/parser/frontmatter.ts tests/parser/frontmatter.test.ts
git commit -m "fix(parser): filter non-string types, strip wikilink brackets

Prevents [object Object] and [[WikiLink]] from being stored as type
names when Obsidian produces garbled YAML in the types array."
```

---

### Task 2: Remove deferred write block and dead helpers from watcher

**Files:**
- Modify: `src/sync/watcher.ts`

- [ ] **Step 1: Remove the deferred write callback block from `processFileChange`**

In `src/sync/watcher.ts`, replace the entire block from line 296 to line 419 (the `useDbOnly` variable through the end of the deferred write callback) with:

```typescript
  const sourceContentHash = sha256(content);

  try {
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: nodeId,
      file_path: relPath,
      title: parsed.title ?? relPath.replace(/\.md$/, ''),
      types: parsed.types,
      fields: parsedFields,
      body: parsed.body,
      raw_field_texts: rawFieldTexts,
      source_content_hash: sourceContentHash,
      db_only: true,
    });

    embeddingIndexer?.enqueue({ node_id: result.node_id, source_type: 'node' });
    embeddingIndexer?.processOne().catch(() => {});
  } catch {
    // Pipeline errors on watcher path are unexpected but shouldn't crash
  }
```

Key changes: `db_only` is now hard-coded `true`. No `deferred_write` check. No WriteGate callback.

- [ ] **Step 2: Remove `rebuildFieldsFromDb` and `rebuildRawTextsFromDb` helpers**

Delete the two functions `rebuildFieldsFromDb` (lines 422-438) and `rebuildRawTextsFromDb` (lines 440-450). They were only used by the deferred write callback.

- [ ] **Step 3: Remove WriteGate cancel from `scheduleIndex`**

In `scheduleIndex`, remove lines 62-66:

```typescript
// Remove:
    // Cancel any pending deferred write — a new edit just arrived,
    // so the WriteGate's DB snapshot is stale.
    if (writeGate.isPending(relPath)) {
      syncLogger?.deferredWriteCancelled(relPath, 'new-edit');
    }
    writeGate.cancel(relPath);
```

And remove lines 143-146 in `handleUnlink`:

```typescript
// Remove:
    // Cancel any pending deferred write
    if (writeGate.isPending(relPath)) {
      syncLogger?.deferredWriteCancelled(relPath, 'unlink');
    }
    writeGate.cancel(relPath);
```

- [ ] **Step 4: Remove WriteGate parameter from `startWatcher` and `processFileChange`**

Remove `writeGate: WriteGate` from the `startWatcher` parameter list and from the `processFileChange` parameter list. Remove the `WriteGate` type import. Remove the `writeGate` argument from the `processFileChange` call inside `mutex.processEvent` (line 54) and inside `scheduleIndex` (line 124).

Updated `startWatcher` signature:

```typescript
export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  options?: WatcherOptions,
): FSWatcher {
```

Updated `processFileChange` signature:

```typescript
export function processFileChange(
  absPath: string,
  relPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
```

- [ ] **Step 5: Remove unused imports from watcher.ts**

Remove:
- `import type { WriteGate } from './write-gate.js';`
- `import { parseMarkdown } from '../parser/parse.js';` — check if still used in the deferred write removal (it is used at line 216, keep it)
- `import { splitFrontmatter } from '../parser/frontmatter.js';` — only used by `extractRawFieldTexts`, keep it
- `import { reconstructValue } from '../pipeline/classify-value.js';` — only used by `rebuildFieldsFromDb`, remove it
- `import { populateDefaults } from '../pipeline/populate-defaults.js';` — check if still used in processFileChange (yes, line 276), keep it

Remove only: `WriteGate` type import and `reconstructValue` import.

- [ ] **Step 6: Run build to verify no compile errors**

Run: `npx tsc --noEmit`
Expected: Errors in files that still reference `writeGate` (expected — we'll fix those in later tasks). The watcher.ts file itself should have no errors.

- [ ] **Step 7: Commit**

```bash
git add src/sync/watcher.ts
git commit -m "refactor(watcher): remove deferred writes, watcher is now DB-only

The watcher path no longer writes files to disk. It updates the DB
and stops. Files catch up via tool writes and schema propagation.
Eliminates Obsidian merge collisions that corrupted frontmatter."
```

---

### Task 3: Remove WriteGate from pipeline and types

**Files:**
- Modify: `src/pipeline/execute.ts`
- Modify: `src/pipeline/types.ts`

- [ ] **Step 1: Remove `DeferredWrite` type and `deferred_write` from `PipelineResult`**

In `src/pipeline/types.ts`, delete the `DeferredWrite` interface (lines 20-24) and remove the `deferred_write` field from `PipelineResult` (line 33). Update the `db_only` comment on `ProposedMutation` (line 17):

```typescript
db_only?: boolean;  // when true, skip file write (watcher path)
```

- [ ] **Step 2: Remove WriteGate from `executeMutation`**

In `src/pipeline/execute.ts`:

Remove the `writeGate` parameter from the function signature:

```typescript
export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  syncLogger?: SyncLogger,
): PipelineResult {
```

Remove the `WriteGate` import.

Remove the two `writeGate.cancel()` blocks:
- Lines 214-217 (tool no-op path)
- Lines 236-239 (tool write path)

And their associated `syncLogger?.deferredWriteCancelled()` calls.

Remove the `deferred_write` computation at lines 336-338:

```typescript
// Remove:
      const deferredWrite = mutation.db_only
        ? { file_content: fileContent, rendered_hash: renderedHash }
        : undefined;
```

And remove `deferred_write: deferredWrite` from the return statement (replace with nothing — just remove the line).

- [ ] **Step 3: Run build**

Run: `npx tsc --noEmit`
Expected: Errors in callers that pass `writeGate` to `executeMutation` (expected — fixed in Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/execute.ts src/pipeline/types.ts
git commit -m "refactor(pipeline): remove WriteGate and DeferredWrite from pipeline"
```

---

### Task 4: Remove deferred-write methods from SyncLogger

**Files:**
- Modify: `src/sync/sync-logger.ts`
- Modify: `tests/sync/sync-logger.test.ts`

- [ ] **Step 1: Remove deferred-write methods from SyncLogger**

In `src/sync/sync-logger.ts`, delete these four methods:

- `deferredWriteScheduled()` (lines 26-28)
- `deferredWriteCancelled()` (lines 30-36)
- `deferredWriteFired()` (lines 38-40)
- `deferredWriteSkipped()` (lines 42-47)

- [ ] **Step 2: Remove deferred-write tests from sync-logger test**

In `tests/sync/sync-logger.test.ts`, delete the test cases:
- `'deferredWriteScheduled logs event'`
- `'deferredWriteCancelled derives source from reason'`
- `'deferredWriteFired logs intended hash'`
- `'deferredWriteSkipped logs reason with optional hashes'`
- `'deferredWriteSkipped omits hashes when not provided'`

- [ ] **Step 3: Run sync-logger tests**

Run: `npx vitest run tests/sync/sync-logger.test.ts`
Expected: Remaining tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/sync/sync-logger.ts tests/sync/sync-logger.test.ts
git commit -m "refactor(sync-logger): remove deferred-write event methods"
```

---

### Task 5: Remove WriteGate from reconciler, index, and startup

**Files:**
- Modify: `src/sync/reconciler.ts`
- Modify: `src/sync/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Remove WriteGate from reconciler**

In `src/sync/reconciler.ts`:
- Remove `writeGate` parameter from `startReconciler` signature
- Remove `WriteGate` type import
- Update the `processFileChange` call at line 75 to remove `writeGate` argument:

```typescript
processFileChange(absPath, relPath, db, writeLock, vaultPath, syncLogger);
```

Updated signature:

```typescript
export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock?: WriteLockManager,
  syncLogger?: SyncLogger,
  options?: ReconcilerOptions,
): { stop: () => void } {
```

- [ ] **Step 2: Remove WriteGate from sync/index.ts exports**

In `src/sync/index.ts`, delete:

```typescript
export { WriteGate } from './write-gate.js';
export type { WriteGateOptions } from './write-gate.js';
```

- [ ] **Step 3: Remove WriteGate from startup (src/index.ts)**

In `src/index.ts`:
- Remove `import { WriteGate } from './sync/write-gate.js';`
- Remove `const writeGate = new WriteGate({ quietPeriodMs: 3000 });`
- Update `startWatcher` call to remove `writeGate` argument:

```typescript
const watcher = startWatcher(vaultPath, db, mutex, writeLock, syncLogger, embeddingIndexer);
```

- Update `startReconciler` call to remove `writeGate` argument:

```typescript
const reconciler = startReconciler(vaultPath, db, mutex, writeLock, syncLogger);
```

- Update `createServer` call to remove `writeGate` from context:

```typescript
const serverFactory = () => createServer(db, { writeLock, syncLogger, vaultPath, extractorRegistry, extractionCache, embeddingIndexer, embedder: embedderRef });
```

- Remove `writeGate.dispose()` calls from the shutdown handlers.

- [ ] **Step 4: Commit**

```bash
git add src/sync/reconciler.ts src/sync/index.ts src/index.ts
git commit -m "refactor: remove WriteGate from reconciler, exports, and startup"
```

---

### Task 6: Remove WriteGate from MCP server and all tool handlers

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools/index.ts`
- Modify: `src/mcp/tools/create-node.ts`
- Modify: `src/mcp/tools/update-node.ts`
- Modify: `src/mcp/tools/delete-node.ts`
- Modify: `src/mcp/tools/batch-mutate.ts`
- Modify: `src/mcp/tools/add-type-to-node.ts`
- Modify: `src/mcp/tools/remove-type-from-node.ts`
- Modify: `src/mcp/tools/rename-node.ts`
- Modify: `src/mcp/tools/rename-global-field.ts`
- Modify: `src/mcp/tools/update-global-field.ts`
- Modify: `src/mcp/tools/update-schema.ts`

- [ ] **Step 1: Remove WriteGate from server.ts context type**

In `src/mcp/server.ts`, remove `writeGate` from both the `ServerContext` interface and the parameter type. Remove the `WriteGate` import.

- [ ] **Step 2: Remove WriteGate from tools/index.ts**

In `src/mcp/tools/index.ts`, remove `writeGate` from all `register*` calls (lines 59-65). Remove `ctx.writeGate` references.

- [ ] **Step 3: Remove WriteGate from each tool handler**

For each of these files, remove the `writeGate` parameter from the register function signature, remove the `WriteGate` type import, and remove `writeGate` from all `executeMutation()` calls:

- `create-node.ts`: Remove `writeGate` param (line 32), remove from `executeMutation` call (line 125)
- `update-node.ts`: Remove `writeGate` param (line 67), remove from `executeMutation` calls (lines 101, 203, 536), remove from `handleQueryMode` (line 239) and `handleExecution` (line 468) signatures and calls
- `delete-node.ts`: Remove `writeGate` param (line 27), remove the `writeGate.cancel()` block (lines 90-93)
- `batch-mutate.ts`: Remove `writeGate` param (line 33), remove from `executeMutation` calls (lines 86, 138)
- `add-type-to-node.ts`: Remove `writeGate` param (line 31), remove from `executeMutation` call (line 113)
- `remove-type-from-node.ts`: Remove `writeGate` param (line 28), remove from `executeMutation` call (line 104)
- `rename-node.ts`: Remove `writeGate` param (line 38), remove `writeGate.cancel()` block (lines 98-101), remove from `executeMutation` calls (lines 135, 179)
- `rename-global-field.ts`: Remove `writeGate` from ctx type (line 12), remove from `rerenderNodesWithField` call (line 27)
- `update-global-field.ts`: Remove `writeGate` from ctx type (line 14), remove from `rerenderNodesWithField` call (line 47)
- `update-schema.ts`: Remove `writeGate` from ctx type (line 21), remove from `propagateSchemaChange` call (line 65)

- [ ] **Step 4: Run build**

Run: `npx tsc --noEmit`
Expected: Errors in `src/schema/propagate.ts` (still references `writeGate`). All other files clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools/
git commit -m "refactor(tools): remove WriteGate from all MCP tool handlers"
```

---

### Task 7: Remove WriteGate from schema propagation

**Files:**
- Modify: `src/schema/propagate.ts`

- [ ] **Step 1: Remove WriteGate from `propagateSchemaChange` and `rerenderNodesWithField`**

In `src/schema/propagate.ts`:

Remove `writeGate` parameter from `propagateSchemaChange` signature (line 81) and `rerenderNodesWithField` signature (line 307).

Remove the `WriteGate` type import.

Remove the two `writeGate.cancel()` blocks:
- Lines 222-224 in `propagateSchemaChange`
- Lines 384-386 in `rerenderNodesWithField`

And their associated `syncLogger?.deferredWriteCancelled()` calls.

Remove `writeGate` from the `executeMutation` calls within both functions (pass `syncLogger` directly as the last arg now that `writeGate` is gone).

- [ ] **Step 2: Run build — full project should compile clean**

Run: `npx tsc --noEmit`
Expected: PASS — zero errors

- [ ] **Step 3: Commit**

```bash
git add src/schema/propagate.ts
git commit -m "refactor(propagation): remove WriteGate from schema propagation"
```

---

### Task 8: Delete WriteGate files and update tests

**Files:**
- Delete: `src/sync/write-gate.ts`
- Delete: `tests/sync/write-gate.test.ts`
- Delete: `tests/sync/writegate-cancellation.test.ts`
- Modify: `tests/sync/watcher.test.ts`
- Modify: `tests/pipeline/execute.test.ts`
- Modify: `tests/integration/end-to-end.test.ts`
- Modify: `tests/mcp/query-sync-log.test.ts`

- [ ] **Step 1: Delete WriteGate source and test files**

```bash
rm src/sync/write-gate.ts tests/sync/write-gate.test.ts tests/sync/writegate-cancellation.test.ts
```

- [ ] **Step 2: Update watcher.test.ts**

Remove `WriteGate` import and `writeGate` variable from the `beforeEach`/`afterEach` setup.

Update `startWatcher` call (line 60) to remove `writeGate` argument:

```typescript
watcher = startWatcher(vaultPath, db, mutex, writeLock, undefined, undefined, {
  debounceMs: DEBOUNCE_MS,
  maxWaitMs: MAX_WAIT_MS,
});
```

Remove `writeGate.dispose()` from `afterEach`.

Delete the entire `describe('processFileChange — WriteGate deferred writes')` block (lines 170-244). These tests are no longer relevant.

Update the `'rapid edit after create'` test (lines 137-167): remove the WriteGate-specific comments and wait. The test still validates that rapid edits update the DB correctly — just remove the WriteGate quiet period delay and the comment about WriteGate. The file-on-disk assertion should check for the DB having the correct type (which it still will):

```typescript
it('rapid edit after create: DB tracks latest user edit', async () => {
  const filePath = join(vaultPath, 'Person.md');

  // Step 1: create file
  writeFileSync(filePath, '---\ntitle: Person\ntypes:\n---\n', 'utf-8');

  await delay(DEBOUNCE_MS + 100);
  await mutex.onIdle();

  // Step 2: user edits file quickly (adds types: person)
  writeFileSync(filePath, '---\ntitle: Person\ntypes:\n  - person\n---\n', 'utf-8');

  await delay(DEBOUNCE_MS + 100);
  await mutex.onIdle();

  // DB should have the user's types
  const types = db.prepare(
    "SELECT schema_type FROM node_types WHERE node_id = (SELECT id FROM nodes WHERE file_path = 'Person.md')"
  ).all() as { schema_type: string }[];
  expect(types.map(t => t.schema_type)).toContain('person');

  // File on disk is unchanged (engine no longer writes back)
  const content = readFileSync(filePath, 'utf-8');
  expect(content).toContain('person');
});
```

- [ ] **Step 3: Update execute.test.ts**

In the `'watcher db_only returns deferred_write for new nodes'` test: change to verify `deferred_write` is no longer present. Actually, since we removed `deferred_write` from `PipelineResult`, these tests need to stop asserting on it. Update the three affected tests:

Test `'watcher db_only returns deferred_write for new nodes'` → rename to `'watcher db_only updates DB without writing file'`. Remove `deferred_write` assertions:

```typescript
it('watcher db_only updates DB without writing file', () => {
  createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal' });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

  const result = executeMutation(db, writeLock, vaultPath, makeMutation({
    source: 'watcher',
    db_only: true,
    types: ['task'],
    fields: { priority: 'normal' },
  }));

  expect(result.file_written).toBe(false);

  // DB IS populated
  const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
    .get(result.node_id, 'priority') as { value_text: string };
  expect(field.value_text).toBe('normal');
});
```

Test `'watcher db_only coerces values and returns deferred_write'` → rename to `'watcher db_only coerces values'`. Remove `deferred_write` assertion:

```typescript
it('watcher db_only coerces values', () => {
  createGlobalField(db, { name: 'count', field_type: 'number' });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'count', sort_order: 100 }] });

  const created = executeMutation(db, writeLock, vaultPath, makeMutation({
    types: ['task'],
    fields: { count: 5 },
  }));

  const result = executeMutation(db, writeLock, vaultPath, makeMutation({
    source: 'watcher',
    node_id: created.node_id,
    types: ['task'],
    fields: { count: '10' },
    source_content_hash: sha256(readFileSync(join(vaultPath, 'test-node.md'), 'utf-8')),
    db_only: true,
  }));

  expect(result.file_written).toBe(false);
  expect(result.validation.coerced_state.count.changed).toBe(true);
  expect(result.validation.coerced_state.count.value).toBe(10);
});
```

In `describe('executeMutation — db_only mode')`:

Test `'updates DB but does not write file when db_only is true'` — remove `deferred_write` assertions:

```typescript
it('updates DB but does not write file when db_only is true', () => {
  const result = executeMutation(db, writeLock, vaultPath, makeMutation({
    source: 'watcher',
    db_only: true,
    body: 'Some content.',
  }));

  expect(result.file_written).toBe(false);

  // DB IS populated
  const node = db.prepare('SELECT title, body FROM nodes WHERE id = ?')
    .get(result.node_id) as { title: string; body: string };
  expect(node.title).toBe('Test Node');
  expect(node.body).toBe('Some content.');

  // File does NOT exist on disk
  expect(existsSync(join(vaultPath, 'test-node.md'))).toBe(false);
});
```

Test `'returns no deferred_write when rendered matches DB hash (no-op)'` — rename and simplify:

```typescript
it('db_only no-op when rendered matches DB hash', () => {
  const created = executeMutation(db, writeLock, vaultPath, makeMutation());

  const result = executeMutation(db, writeLock, vaultPath, makeMutation({
    source: 'watcher',
    node_id: created.node_id,
    db_only: true,
  }));

  expect(result.file_written).toBe(false);
});
```

- [ ] **Step 4: Update end-to-end.test.ts**

Remove `WriteGate` import. Update `startWatcher` call to remove WriteGate:

```typescript
watcher = startWatcher(vaultPath, db, mutex, new WriteLockManager(), undefined, undefined, {
  debounceMs: 50, maxWaitMs: 200,
});
```

- [ ] **Step 5: Update query-sync-log.test.ts**

In `tests/mcp/query-sync-log.test.ts`, check if the test that inserts a `deferred-write-scheduled` row needs updating. The sync log table still accepts any event string — the test just uses it as fixture data. If the test only checks that the query tool returns rows correctly (not that deferred-write events exist), it can stay. If it asserts on the specific event name, change the fixture to use `'watcher-event'` instead.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: update tests for WriteGate removal

Delete write-gate and writegate-cancellation test files.
Update watcher, pipeline, e2e, and sync-log tests to remove
WriteGate references and deferred_write assertions."
```

---

### Task 9: Final verification

- [ ] **Step 1: Build**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Verify no remaining WriteGate references**

Run: `grep -r "WriteGate\|writeGate\|write-gate\|write_gate\|deferred.write\|deferredWrite\|deferred_write\|DeferredWrite" src/ tests/ --include="*.ts" -l`
Expected: No files found (all references removed)

- [ ] **Step 4: Commit if any cleanup was needed, otherwise done**
