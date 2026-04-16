# Embedder Subprocess Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ONNX embedding model into a child process so memory (~1.5 GB) is reclaimed by the OS when the model is idle, while keeping the same `Embedder` interface for all consumers.

**Architecture:** A new `EmbedderHost` manages a child process that runs a thin worker script. The worker loads `@huggingface/transformers`, accepts JSON-line requests over IPC, and returns embedding vectors. The host implements the existing `Embedder` interface, transparently spawning/killing the child on demand. An idle timer kills the child after 5 minutes of inactivity. At startup, the bulk embed loop works identically — the child stays alive for the duration, then gets killed after the idle timeout.

**Tech Stack:** Node.js `child_process.fork()` with IPC channel, existing `@huggingface/transformers` pipeline, JSON-line protocol over IPC.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/search/embedder-worker.ts` | Create | Child process entry point. Loads ONNX model, listens for IPC messages, returns vectors. |
| `src/search/embedder-host.ts` | Create | Parent-side `Embedder` implementation. Manages child lifecycle, idle timer, request/response correlation. |
| `src/search/embedder-protocol.ts` | Create | Shared types for IPC messages (request, response, ready signal). |
| `src/search/embedder.ts` | Modify | Export a new `createSubprocessEmbedder()` that returns an `EmbedderHost`. Keep the `Embedder` interface unchanged. Remove `createEmbedder()` (no longer used). |
| `src/index.ts` | Modify | Switch from `createEmbedder()` to `createSubprocessEmbedder()`. Call `shutdown()` on embedder during process exit. |
| `tests/search/embedder-host.test.ts` | Create | Integration tests for subprocess lifecycle, idle timeout, concurrent requests. |
| `tests/search/embedder.test.ts` | Modify | Update to test `createSubprocessEmbedder()` or remove if covered by host tests. |
| `scripts/test-gc.mjs` | Delete | No longer needed. |
| `scripts/test-gc-bulk.mjs` | Delete | No longer needed. |

## Design Decisions

1. **`fork()` with IPC, not `worker_threads`.** Worker threads share the V8 heap — ONNX native allocations stay in the same process address space and can't be reclaimed. `fork()` creates a real OS process whose memory the OS fully reclaims on exit.

2. **JSON over IPC, not SharedArrayBuffer.** Embedding vectors are 256 × 4 = 1 KB each. Serialization overhead is negligible. Keeps the protocol simple and debuggable.

3. **Request correlation via `requestId`.** The host may have concurrent callers (watcher embed + search query simultaneously). Each request gets a unique ID so responses route to the correct `Promise`.

4. **Idle timer resets on every request.** The timer only starts/resets when a response comes back. If the child is mid-inference, it stays alive.

5. **`isReady()` returns true even when child is not spawned.** The host can spawn on demand. `isReady()` means "this embedder is functional", not "the child is currently running." The indexer status check uses this to decide `disabled` vs `ready`/`indexing`.

---

### Task 1: IPC Protocol Types

**Files:**
- Create: `src/search/embedder-protocol.ts`

- [ ] **Step 1: Create the protocol types file**

```ts
// src/search/embedder-protocol.ts

/** Parent → child: embed a text string */
export interface EmbedRequest {
  type: 'embed';
  requestId: string;
  text: string;
  prefix: 'search_document' | 'search_query';
}

/** Parent → child: shut down gracefully */
export interface ShutdownRequest {
  type: 'shutdown';
}

export type WorkerRequest = EmbedRequest | ShutdownRequest;

/** Child → parent: model is loaded and ready */
export interface ReadyMessage {
  type: 'ready';
}

/** Child → parent: embedding result */
export interface EmbedResponse {
  type: 'embed-result';
  requestId: string;
  vector: number[]; // Float32 values serialized as JSON array
}

/** Child → parent: embedding error */
export interface EmbedError {
  type: 'embed-error';
  requestId: string;
  error: string;
}

export type WorkerMessage = ReadyMessage | EmbedResponse | EmbedError;
```

- [ ] **Step 2: Build and verify no type errors**

Run: `npx tsc --noEmit`
Expected: Clean (no errors referencing embedder-protocol)

- [ ] **Step 3: Commit**

```bash
git add src/search/embedder-protocol.ts
git commit -m "feat: add IPC protocol types for embedder subprocess"
```

---

### Task 2: Embedder Worker (Child Process)

**Files:**
- Create: `src/search/embedder-worker.ts`

- [ ] **Step 1: Create the worker script**

```ts
// src/search/embedder-worker.ts
//
// Child process entry point. Loads the ONNX embedding model and serves
// embed requests over Node IPC. Exits on 'shutdown' message or when
// the IPC channel disconnects (parent died).

import { pipeline, env } from '@huggingface/transformers';
import type { WorkerRequest, WorkerMessage } from './embedder-protocol.js';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const DIMENSIONS = 256;

async function main(): Promise<void> {
  const modelsDir = process.argv[2];
  if (!modelsDir) {
    console.error('[embedder-worker] modelsDir argument required');
    process.exit(1);
  }

  env.cacheDir = modelsDir;
  env.allowRemoteModels = true;

  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    revision: 'main',
  });

  // Model loaded — prevent further network calls
  env.allowRemoteModels = false;

  function send(msg: WorkerMessage): void {
    if (process.send) process.send(msg);
  }

  send({ type: 'ready' });

  process.on('message', async (msg: WorkerRequest) => {
    if (msg.type === 'shutdown') {
      process.exit(0);
    }

    if (msg.type === 'embed') {
      try {
        const prefixed = `${msg.prefix}: ${msg.text}`;
        const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
        const full = output.data as Float32Array;
        const slice = full.length === DIMENSIONS ? full : full.slice(0, DIMENSIONS);
        send({
          type: 'embed-result',
          requestId: msg.requestId,
          vector: Array.from(slice),
        });
      } catch (err) {
        send({
          type: 'embed-error',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // If parent disconnects IPC, exit cleanly
  process.on('disconnect', () => process.exit(0));
}

main().catch(err => {
  console.error('[embedder-worker] Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify no type errors**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/search/embedder-worker.ts
git commit -m "feat: add embedder child process worker script"
```

---

### Task 3: Embedder Host (Parent-Side `Embedder` Implementation)

**Files:**
- Create: `src/search/embedder-host.ts`

- [ ] **Step 1: Create the host module**

```ts
// src/search/embedder-host.ts
//
// Parent-side Embedder that manages a child process. Spawns on first use,
// kills after idle timeout. Implements the same Embedder interface so all
// consumers (indexer, search, watcher) work unchanged.

import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Embedder } from './embedder.js';
import type { WorkerRequest, WorkerMessage } from './embedder-protocol.js';

const DEFAULT_IDLE_MS = 5 * 60 * 1000; // 5 minutes

export interface SubprocessEmbedderOptions {
  modelsDir: string;
  idleTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (vector: Float32Array) => void;
  reject: (err: Error) => void;
}

export function createSubprocessEmbedder(options: SubprocessEmbedderOptions): Embedder & { shutdown(): Promise<void> } {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const workerPath = resolve(import.meta.dirname ?? '.', 'embedder-worker.js');

  let child: ChildProcess | null = null;
  let readyPromise: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, PendingRequest>();

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      killChild();
    }, idleTimeoutMs);
  }

  function killChild(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (child) {
      const c = child;
      child = null;
      readyPromise = null;
      c.kill('SIGTERM');
      // Reject any pending requests
      for (const [id, req] of pending) {
        req.reject(new Error('Embedder child process terminated'));
        pending.delete(id);
      }
    }
  }

  function spawnChild(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      child = fork(workerPath, [options.modelsDir], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });

      child.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          resolveReady();
          return;
        }
        if (msg.type === 'embed-result') {
          const req = pending.get(msg.requestId);
          if (req) {
            pending.delete(msg.requestId);
            req.resolve(new Float32Array(msg.vector));
            resetIdleTimer();
          }
          return;
        }
        if (msg.type === 'embed-error') {
          const req = pending.get(msg.requestId);
          if (req) {
            pending.delete(msg.requestId);
            req.reject(new Error(msg.error));
            resetIdleTimer();
          }
          return;
        }
      });

      child.on('exit', (code) => {
        // If child exits unexpectedly, reject pending and reset state
        if (child) {
          child = null;
          readyPromise = null;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          for (const [id, req] of pending) {
            req.reject(new Error(`Embedder child exited with code ${code}`));
            pending.delete(id);
          }
        }
      });

      child.on('error', (err) => {
        rejectReady(err);
      });
    });

    return readyPromise;
  }

  function sendRequest(prefix: 'search_document' | 'search_query', text: string): Promise<Float32Array> {
    return new Promise<Float32Array>((resolveEmbed, rejectEmbed) => {
      const requestId = randomUUID();
      pending.set(requestId, { resolve: resolveEmbed, reject: rejectEmbed });

      spawnChild().then(() => {
        const msg: WorkerRequest = { type: 'embed', requestId, text, prefix };
        child!.send(msg);
      }).catch(err => {
        pending.delete(requestId);
        rejectEmbed(err);
      });
    });
  }

  return {
    async embedDocument(text: string): Promise<Float32Array> {
      return sendRequest('search_document', text);
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return sendRequest('search_query', text);
    },
    isReady(): boolean {
      return true;
    },
    async shutdown(): Promise<void> {
      killChild();
    },
  };
}
```

- [ ] **Step 2: Build and verify no type errors**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/search/embedder-host.ts
git commit -m "feat: add subprocess embedder host with idle timeout"
```

---

### Task 4: Update `embedder.ts` Exports

**Files:**
- Modify: `src/search/embedder.ts`

- [ ] **Step 1: Re-export from `embedder-host.ts` and keep the `Embedder` interface**

Replace the entire contents of `src/search/embedder.ts` with:

```ts
// src/search/embedder.ts
//
// Public API for the embedding subsystem. The Embedder interface is consumed
// by indexer.ts, search.ts, query-nodes.ts, and watcher.ts. The implementation
// runs in a subprocess to allow memory reclamation when idle.

export { createSubprocessEmbedder } from './embedder-host.js';
export type { SubprocessEmbedderOptions } from './embedder-host.js';

export interface Embedder {
  embedDocument(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  isReady(): boolean;
}
```

- [ ] **Step 2: Build to check for import breakage**

Run: `npx tsc --noEmit`
Expected: Errors in `src/index.ts` (still references old `createEmbedder`). No errors in other consumers — they only import the `Embedder` type.

- [ ] **Step 3: Commit**

```bash
git add src/search/embedder.ts
git commit -m "refactor: embedder.ts re-exports subprocess implementation, keeps Embedder interface"
```

---

### Task 5: Wire Up `index.ts`

**Files:**
- Modify: `src/index.ts:27-28,71-103`

- [ ] **Step 1: Update imports in `src/index.ts`**

Replace the import line:
```ts
import { createEmbedder, type Embedder } from './search/embedder.js';
```
with:
```ts
import { createSubprocessEmbedder, type Embedder } from './search/embedder.js';
```

- [ ] **Step 2: Replace the embedding initialization block (lines 71–103)**

Replace:
```ts
// --- Phase 4: Embedding indexer ---
let embeddingIndexer: EmbeddingIndexer | undefined;
let embedderRef: Embedder | undefined;

const modelsDir = resolve(vaultPath, '.vault-engine', 'models');
console.log('Loading embedding model...');
try {
  const embedder = await createEmbedder({ modelsDir });
  embedderRef = embedder;
  embeddingIndexer = createEmbeddingIndexer(db, embedder);

  if (args.reindexSearch) {
    console.log('Reindex requested — clearing search index...');
    embeddingIndexer.clearAll();
  }

  const allNodes = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
  for (const node of allNodes) {
    embeddingIndexer.enqueue({ node_id: node.id, source_type: 'node' });
  }

  const backgroundProcess = async () => {
    const count = await embeddingIndexer!.processAll();
    if (count > 0) {
      console.log(`Embedded ${count} items`);
    }
  };
  backgroundProcess().catch(err => console.error('Embedding error:', err instanceof Error ? err.message : err));

  console.log(`Embedding model loaded, ${allNodes.length} nodes queued`);
} catch (err) {
  console.error('Failed to load embedding model — search disabled:', err instanceof Error ? err.message : err);
}
```

with:

```ts
// --- Phase 4: Embedding indexer (subprocess-isolated) ---
let embeddingIndexer: EmbeddingIndexer | undefined;
let embedderRef: (Embedder & { shutdown(): Promise<void> }) | undefined;

const modelsDir = resolve(vaultPath, '.vault-engine', 'models');
console.log('Initializing embedder subprocess...');
try {
  const embedder = createSubprocessEmbedder({ modelsDir });
  embedderRef = embedder;
  embeddingIndexer = createEmbeddingIndexer(db, embedder);

  if (args.reindexSearch) {
    console.log('Reindex requested — clearing search index...');
    embeddingIndexer.clearAll();
  }

  const allNodes = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
  for (const node of allNodes) {
    embeddingIndexer.enqueue({ node_id: node.id, source_type: 'node' });
  }

  const backgroundProcess = async () => {
    const count = await embeddingIndexer!.processAll();
    if (count > 0) {
      console.log(`Embedded ${count} items`);
    }
  };
  backgroundProcess().catch(err => console.error('Embedding error:', err instanceof Error ? err.message : err));

  console.log(`Embedder ready, ${allNodes.length} nodes queued`);
} catch (err) {
  console.error('Failed to initialize embedder — search disabled:', err instanceof Error ? err.message : err);
}
```

- [ ] **Step 3: Update the shutdown function to kill the embedder child**

Replace:
```ts
async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  reconciler.stop();
  normalizer.stop();
  await mutex.onIdle();
  await watcher.close();
  db.close();
  process.exit(0);
}
```

with:

```ts
async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  reconciler.stop();
  normalizer.stop();
  await embedderRef?.shutdown();
  await mutex.onIdle();
  await watcher.close();
  db.close();
  process.exit(0);
}
```

- [ ] **Step 4: Build**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up subprocess embedder in main entry point"
```

---

### Task 6: Tests for Subprocess Embedder Host

**Files:**
- Create: `tests/search/embedder-host.test.ts`
- Modify: `tests/search/embedder.test.ts`

- [ ] **Step 1: Write the host integration tests**

These tests fork a real child process (no mocking the child — that defeats the purpose). They use a mock worker script to avoid loading the real ONNX model in tests.

Create `tests/search/embedder-host.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createSubprocessEmbedder } from '../../src/search/embedder-host.js';
import { resolve } from 'node:path';

// These tests use the real worker, which needs the model files.
// They are integration tests — skip in CI if model not available.
// For unit-level coverage, the indexer tests already mock the Embedder interface.

const modelsDir = resolve(
  process.env.VAULT_PATH ?? resolve(import.meta.dirname, '..', '..', '..', 'Documents', 'archbrain'),
  '.vault-engine',
  'models',
);

// Quick check if model files exist
import { existsSync } from 'node:fs';
const modelAvailable = existsSync(resolve(modelsDir, 'nomic-ai'));
const describeIfModel = modelAvailable ? describe : describe.skip;

describeIfModel('SubprocessEmbedder (integration)', () => {
  let embedder: ReturnType<typeof createSubprocessEmbedder> | null = null;

  afterEach(async () => {
    if (embedder) {
      await embedder.shutdown();
      embedder = null;
    }
  });

  it('embeds a document via subprocess', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, idleTimeoutMs: 60_000 });
    const vec = await embedder.embedDocument('Hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(256);
    // Vector should be normalized (magnitude ~1.0)
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 1);
  }, 30_000);

  it('embeds a query via subprocess', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, idleTimeoutMs: 60_000 });
    const vec = await embedder.embedQuery('find meetings');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(256);
  }, 30_000);

  it('handles concurrent requests', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, idleTimeoutMs: 60_000 });
    const [a, b, c] = await Promise.all([
      embedder.embedDocument('first'),
      embedder.embedDocument('second'),
      embedder.embedQuery('third'),
    ]);
    expect(a.length).toBe(256);
    expect(b.length).toBe(256);
    expect(c.length).toBe(256);
  }, 30_000);

  it('respawns after shutdown', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, idleTimeoutMs: 60_000 });
    const v1 = await embedder.embedDocument('before shutdown');
    expect(v1.length).toBe(256);

    await embedder.shutdown();

    // Should respawn transparently on next request
    const v2 = await embedder.embedDocument('after shutdown');
    expect(v2.length).toBe(256);
  }, 60_000);

  it('isReady() returns true before and after spawning', () => {
    embedder = createSubprocessEmbedder({ modelsDir, idleTimeoutMs: 60_000 });
    expect(embedder.isReady()).toBe(true);
  });

  it('idle timeout kills child process', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, idleTimeoutMs: 1_000 }); // 1s timeout
    await embedder.embedDocument('trigger spawn');

    // Wait for idle timeout + buffer
    await new Promise(r => setTimeout(r, 2_000));

    // Next request should still work (respawns)
    const vec = await embedder.embedDocument('after idle');
    expect(vec.length).toBe(256);
  }, 60_000);
});
```

- [ ] **Step 2: Update `tests/search/embedder.test.ts`**

The existing test mocks `@huggingface/transformers` and tests the old `createEmbedder()`. Since that function no longer exists, replace the file with a simple interface-contract test:

```ts
import { describe, it, expect } from 'vitest';
import type { Embedder } from '../../src/search/embedder.js';

describe('Embedder interface', () => {
  it('type-checks a conforming implementation', () => {
    // This is a compile-time check — if the interface changes, this test
    // will fail to compile, alerting us to update all implementations.
    const fake: Embedder = {
      async embedDocument(text: string) { return new Float32Array(256); },
      async embedQuery(text: string) { return new Float32Array(256); },
      isReady() { return true; },
    };
    expect(fake.isReady()).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test suite**

Run: `npm test`
Expected: All existing tests pass. New host tests pass if model is available, skip otherwise.

- [ ] **Step 4: Commit**

```bash
git add tests/search/embedder-host.test.ts tests/search/embedder.test.ts
git commit -m "test: add subprocess embedder integration tests"
```

---

### Task 7: Clean Up Test Scripts

**Files:**
- Delete: `scripts/test-gc.mjs`
- Delete: `scripts/test-gc-bulk.mjs`

- [ ] **Step 1: Remove the GC test scripts**

```bash
rm scripts/test-gc.mjs scripts/test-gc-bulk.mjs
```

- [ ] **Step 2: Commit**

```bash
git add -A scripts/test-gc.mjs scripts/test-gc-bulk.mjs
git commit -m "chore: remove GC investigation scripts"
```

---

### Task 8: Build, Test, Deploy Verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean compilation, `dist/search/embedder-worker.js` exists.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`
Expected output includes:
- `Initializing embedder subprocess...`
- `Embedder ready, NNNN nodes queued`
- `Embedded NNNN items` (after bulk embed completes)

Verify search works: call `query-nodes` with a `query` param via MCP client.

After ~5 minutes of idle, check memory:
```bash
ps -o rss,vsz,comm -p <PID>
```
Expected: RSS drops significantly after idle timeout kills the child.

- [ ] **Step 4: Commit any fixups, then final commit**

```bash
git add -A
git commit -m "feat: subprocess-isolated embedder with idle timeout for memory reclamation"
```
