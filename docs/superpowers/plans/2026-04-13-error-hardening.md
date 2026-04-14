# Error Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four concrete error handling gaps: shutdown draining, embedding queue error recovery, watcher embedding error logging, and batch-mutate rollback logging.

**Architecture:** Targeted fixes to existing modules. No new files. Each fix is isolated — they can be implemented in any order.

**Tech Stack:** TypeScript, vitest, better-sqlite3

---

### Task 1: Shutdown drains watcher mutex before closing DB

The SIGTERM/SIGINT handlers in `src/index.ts` call `watcher.close()` and then `db.close()`, but don't wait for the `IndexMutex` to finish any in-flight `processFileChange` call. If a mutation is mid-flight when the signal arrives, the DB closes underneath it.

**Files:**
- Modify: `src/index.ts:116-132`
- Test: `tests/sync/mutex.test.ts` (create)

- [ ] **Step 1: Write failing test — mutex.onIdle() resolves after run completes**

Create `tests/sync/mutex.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { IndexMutex } from '../../src/sync/mutex.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('IndexMutex', () => {
  it('onIdle resolves immediately when not running', async () => {
    const mutex = new IndexMutex();
    await mutex.onIdle(); // should not hang
  });

  it('onIdle waits for in-flight run to complete', async () => {
    const mutex = new IndexMutex();
    const order: string[] = [];

    // Start a slow operation
    mutex.run(async () => {
      await delay(100);
      order.push('run-done');
    });

    // onIdle should wait for it
    await mutex.onIdle();
    order.push('idle-resolved');

    expect(order).toEqual(['run-done', 'idle-resolved']);
  });

  it('onIdle waits for queued events to drain', async () => {
    const mutex = new IndexMutex();
    const processed: string[] = [];

    mutex.processEvent = async (event) => {
      processed.push(event.path);
    };

    // Start a run and enqueue during it
    mutex.run(async () => {
      await delay(50);
      mutex.enqueue({ type: 'change', path: 'a.md' });
    });

    await mutex.onIdle();
    expect(processed).toEqual(['a.md']);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/sync/mutex.test.ts`
Expected: All 3 tests PASS (the mutex already has `onIdle()` — we're confirming the behavior we depend on).

- [ ] **Step 3: Update shutdown handlers to drain mutex**

In `src/index.ts`, the shutdown handlers need to await `mutex.onIdle()` before closing the watcher and DB. Replace lines 116-132:

```typescript
async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  reconciler.stop();
  normalizer.stop();
  await mutex.onIdle();
  await watcher.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/sync/mutex.test.ts
git commit -m "fix: drain watcher mutex on shutdown before closing DB"
```

---

### Task 2: Embedding queue requeues items on failure

`processOne()` in `src/search/indexer.ts` shifts items off the queue before attempting to embed. If `embedder.embedDocument()` throws, the item is lost forever. Fix: catch errors, log them, and requeue with a retry counter. Items that fail 3 times are dropped with a log message.

**Files:**
- Modify: `src/search/indexer.ts:141-181`
- Modify: `src/search/types.ts` (add `retries` to `EmbeddingQueueItem`)
- Test: `tests/search/indexer.test.ts` (add tests)

- [ ] **Step 1: Write failing test — processOne requeues on embedding failure**

Add to `tests/search/indexer.test.ts`:

```typescript
function createFailingEmbedder(failCount: number): Embedder & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async embedDocument(text: string): Promise<Float32Array> {
      callCount++;
      if (callCount <= failCount) {
        throw new Error('embedding model unavailable');
      }
      const arr = new Float32Array(256);
      for (let i = 0; i < 256; i++) arr[i] = 0.5;
      return arr;
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return new Float32Array(256).fill(0.5);
    },
    isReady(): boolean { return true; },
  };
}

describe('embedding error recovery', () => {
  it('requeues item on embedding failure', async () => {
    const embedder = createFailingEmbedder(1);
    const indexer = createEmbeddingIndexer(db, embedder);

    insertNode(db, 'n1', 'Test Node', 'body');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });

    // First attempt fails — item should be requeued
    const result1 = await indexer.processOne();
    expect(result1).toBe(false); // failure
    expect(indexer.queueSize()).toBe(1); // requeued

    // Second attempt succeeds
    const result2 = await indexer.processOne();
    expect(result2).toBe(true);
    expect(indexer.queueSize()).toBe(0);
  });

  it('drops item after 3 failures', async () => {
    const embedder = createFailingEmbedder(100); // always fails
    const indexer = createEmbeddingIndexer(db, embedder);

    insertNode(db, 'n1', 'Test Node', 'body');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });

    // Fail 3 times
    await indexer.processOne();
    await indexer.processOne();
    await indexer.processOne();

    // Item should be dropped after 3 failures
    expect(indexer.queueSize()).toBe(0);
    expect(embedder.callCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/indexer.test.ts -t "embedding error recovery"`
Expected: FAIL — current code doesn't requeue on failure.

- [ ] **Step 3: Add retries field to EmbeddingQueueItem**

In `src/search/types.ts`, add optional `retries` field:

```typescript
export interface EmbeddingQueueItem {
  node_id: string;
  source_type: 'node' | 'extraction';
  extraction_ref?: string;
  retries?: number;
}
```

- [ ] **Step 4: Implement retry logic in processOne**

Replace the `processOne` function in `src/search/indexer.ts`:

```typescript
  const MAX_RETRIES = 3;

  async function processOne(): Promise<boolean> {
    const item = queue.shift();
    if (!item) return false;

    processing = true;
    try {
      if (item.source_type === 'node') {
        const hash = contentHash(item.node_id);
        const extractionRef = item.extraction_ref ?? null;

        const existing = stmtGetExistingMeta.get(item.node_id, item.source_type, extractionRef);

        if (existing && existing.source_hash === hash) {
          // Content unchanged — skip embedding
          return true;
        }

        // Embed the content
        const content = assembleContent(item.node_id);
        const vector = await embedder.embedDocument(content);
        const vectorBytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        const now = new Date().toISOString();

        if (existing) {
          stmtUpdateMeta.run(hash, now, existing.id);
          stmtUpdateVec.run(vectorBytes, existing.id);
        } else {
          const insertResult = stmtInsertMeta.run(item.node_id, item.source_type, hash, 0, extractionRef, now);
          const metaId = BigInt(insertResult.lastInsertRowid);
          stmtInsertVec.run(metaId, vectorBytes);
        }
      }

      return true;
    } catch (err) {
      const retries = (item.retries ?? 0) + 1;
      if (retries < MAX_RETRIES) {
        queue.push({ ...item, retries });
        console.error(`[embedding] Failed to embed ${item.node_id} (attempt ${retries}/${MAX_RETRIES}):`, err instanceof Error ? err.message : err);
      } else {
        console.error(`[embedding] Dropping ${item.node_id} after ${MAX_RETRIES} failures:`, err instanceof Error ? err.message : err);
      }
      return false;
    } finally {
      processing = false;
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: All tests pass (existing + new).

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/search/indexer.ts src/search/types.ts tests/search/indexer.test.ts
git commit -m "fix: requeue embedding items on failure, drop after 3 retries"
```

---

### Task 3: Log embedding errors in watcher instead of swallowing

The watcher calls `embeddingIndexer?.processOne().catch(() => {})` in two places (lines 223 and 296). These silently swallow all errors. Now that `processOne` handles its own retry logic (Task 2), we still want to log if the outer call fails for an unexpected reason.

**Files:**
- Modify: `src/sync/watcher.ts:223,296`

- [ ] **Step 1: Replace silent catch with logging**

In `src/sync/watcher.ts`, find both occurrences of:
```typescript
embeddingIndexer?.processOne().catch(() => {});
```

Replace each with:
```typescript
embeddingIndexer?.processOne().catch(err => {
  console.error('[watcher] Embedding error:', err instanceof Error ? err.message : err);
});
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/sync/watcher.ts
git commit -m "fix: log embedding errors in watcher instead of swallowing"
```

---

### Task 4: Log batch-mutate file rollback failures

When `batch-mutate` rolls back a failed transaction, file restoration is best-effort with silent `catch {}` blocks. If a restore fails, the caller gets `applied: false` but no indication that files may be inconsistent. Fix: collect restore failures and include them in the response.

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts:183-206`
- Test: `tests/phase3/rename-batch.test.ts` (check existing batch-mutate tests to find the right file)

- [ ] **Step 1: Check which test file covers batch-mutate**

The batch-mutate tool tests may be in `tests/phase3/tools.test.ts` or `tests/phase3/rename-batch.test.ts`. Read them to understand the test patterns before writing new tests.

- [ ] **Step 2: Update rollback error handling**

In `src/mcp/tools/batch-mutate.ts`, replace the rollback section (inside the outer `catch`):

```typescript
      } catch {
        // DB transaction rolled back. Now revert file writes.
        const rollbackFailures: string[] = [];

        // 1. Restore backed-up files (updates and deletes)
        for (const { filePath, backupPath } of backups) {
          try {
            restoreFile(backupPath, filePath);
          } catch (err) {
            const msg = `Failed to restore ${filePath}: ${err instanceof Error ? err.message : err}`;
            console.error(`[batch-mutate] ${msg}`);
            rollbackFailures.push(msg);
          }
        }
        // 2. Delete newly created files
        for (const absPath of createdFiles) {
          try {
            unlinkSync(absPath);
          } catch (err) {
            const msg = `Failed to delete ${absPath}: ${err instanceof Error ? err.message : err}`;
            console.error(`[batch-mutate] ${msg}`);
            rollbackFailures.push(msg);
          }
        }

        if (batchError) {
          const result: Record<string, unknown> = {
            applied: false,
            failed_at: batchError.failed_at,
            error: batchError.error,
          };
          if (rollbackFailures.length > 0) {
            result.rollback_failures = rollbackFailures;
          }
          return toolResult(result);
        }
        return toolErrorResult('INTERNAL_ERROR', 'Batch operation failed');
      }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts
git commit -m "fix: log and report file rollback failures in batch-mutate"
```
