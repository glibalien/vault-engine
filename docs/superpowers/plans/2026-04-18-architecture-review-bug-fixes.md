# Architecture Review Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four high-severity correctness bugs identified in `docs/superpowers/specs/2026-04-18-architecture-review.md` §1 before the larger structural refactors (unified deletion, schema-propagation-through-pipeline, response envelope).

**Architecture:** Four independent localized fixes, each with a regression test. The bugs span the indexer, reconciler, and MCP tool layers but don't share code paths, so tasks can be committed independently. Two fixes (1a, 1b) both relate to embedding cleanup on delete and share a callback design; they are sequenced so Task 1 establishes the `onNodeDeleted` callback contract that Task 2 reuses.

**Tech Stack:** TypeScript (ESM, `.js` imports), `better-sqlite3`, Vitest. Design spec: `docs/superpowers/specs/2026-04-18-architecture-review.md`.

---

## File Structure

**New files:**
- `tests/integration/embedding-cleanup-fullindex.test.ts` — regression test for 1a
- `tests/integration/embedding-cleanup-reconciler.test.ts` — regression test for 1b
- `tests/integration/reconciler-error-logging.test.ts` — regression test for 1d
- `tests/mcp/update-node-type-conflict.test.ts` — regression test for 1c

**Modified files:**
- `src/indexer/indexer.ts` — extend `IndexerOptions` with `onNodeDeleted`; invoke in `fullIndex` delete loop (Task 1)
- `src/index.ts` — thread `embeddingIndexer` into the `fullIndex` call and into `startReconciler` (Tasks 1, 2)
- `src/sync/reconciler.ts` — accept `embeddingIndexer` parameter, pass to `deleteNodeByPath`; replace silent catch with `edits_log` error entry (Tasks 2, 4)
- `src/mcp/tools/update-node.ts` — emit `TYPE_OP_CONFLICT` issue when `set_types` is combined with `add_types` / `remove_types` (Task 3)

**Dependency order:** Tasks are independent but grouped: 1 → 2 (shared callback design), 3, 4 (reconciler, same file as 2).

---

## Task 1: Wire embedding cleanup into `fullIndex`

**Bug:** `src/indexer/indexer.ts:279-295` deletes nodes during bulk re-index without calling `embeddingIndexer.removeNode()`. Orphan `embedding_vec` rows accumulate.

**Files:**
- Create: `tests/integration/embedding-cleanup-fullindex.test.ts`
- Modify: `src/indexer/indexer.ts:261-263` (extend `IndexerOptions`)
- Modify: `src/indexer/indexer.ts:279-295` (invoke callback in delete loop)
- Modify: `src/index.ts:64` (pass callback)

---

- [ ] **Step 1: Write the failing test**

Create `tests/integration/embedding-cleanup-fullindex.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { createTempVault } from '../helpers/vault.js';
import { fullIndex } from '../../src/indexer/indexer.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('fullIndex embedding cleanup', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = openDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('invokes onNodeDeleted callback for every bulk-deleted node', () => {
    // Seed: add two markdown files, index them, capture their node IDs.
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n---\n# A\n', 'utf-8');
    writeFileSync(join(vaultPath, 'b.md'), '---\ntypes:\n---\n# B\n', 'utf-8');
    fullIndex(vaultPath, db);
    const before = db.prepare('SELECT id, file_path FROM nodes').all() as Array<{ id: string; file_path: string }>;
    expect(before.length).toBe(2);
    const idByPath = new Map(before.map(r => [r.file_path, r.id]));

    // Delete a.md from disk, re-index — should trigger onNodeDeleted for A.
    rmSync(join(vaultPath, 'a.md'));
    const deletedIds: string[] = [];
    fullIndex(vaultPath, db, { onNodeDeleted: (nodeId) => deletedIds.push(nodeId) });

    expect(deletedIds).toEqual([idByPath.get('a.md')]);
    const after = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
    expect(after.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/embedding-cleanup-fullindex.test.ts`
Expected: FAIL — the test will either (a) fail a TypeScript compile on `onNodeDeleted` not existing on `IndexerOptions`, or (b) fail on `deletedIds` being empty because the callback is never invoked.

- [ ] **Step 3: Extend `IndexerOptions` and invoke callback in delete loop**

Modify `src/indexer/indexer.ts:261-263` — add the callback field:

```ts
export interface IndexerOptions {
  onNodeIndexed?: (nodeId: string) => void;
  onNodeDeleted?: (nodeId: string) => void;
}
```

Modify `src/indexer/indexer.ts:279-295` — invoke the callback inside the delete transaction after `stmts.deleteNode.run`:

```ts
  const deleteTransaction = db.transaction(() => {
    for (const node of dbNodes) {
      if (!diskFiles.has(node.file_path)) {
        // Delete FTS entry
        const rowInfo = stmts.getNodeRowid.get(node.id) as { rowid: number } | undefined;
        if (rowInfo) {
          stmts.deleteFts.run(rowInfo.rowid);
        }
        // Log before deletion
        stmts.insertEditLog.run(node.id, Date.now(), 'file-deleted', node.file_path);
        // Delete node (cascade handles types, fields, relationships)
        stmts.deleteNode.run(node.id);
        options?.onNodeDeleted?.(node.id);
        stats.deleted++;
      }
    }
  });
  deleteTransaction();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/embedding-cleanup-fullindex.test.ts`
Expected: PASS — both assertions satisfied.

- [ ] **Step 5: Wire into startup call in `src/index.ts`**

Modify `src/index.ts:64` — the current call is `await fullIndex(vaultPath, db);`. Replace with a version that forwards to the embedding indexer when it's available. Since the embedder initialization happens AFTER fullIndex at line 101, we need to restructure: move the `embeddingIndexer` initialization block (lines 100-144) to execute BEFORE `fullIndex`, so the callback can reference it.

Alternatively, capture pending deletions and replay after indexer is ready. The move-before approach is simpler. Apply:

```ts
// --- Phase 4: Embedding indexer (subprocess-isolated) ---
// MUST initialize before fullIndex so bulk-delete cleanup is wired.
let embeddingIndexer: EmbeddingIndexer | undefined;
let embedderRef: (Embedder & { shutdown(): Promise<void> }) | undefined;

const modelsDir = resolve(vaultPath, '.vault-engine', 'models');
console.log('Initializing embedder subprocess...');
try {
  const embedder = createSubprocessEmbedder({ modelsDir });
  embedderRef = embedder;
  embeddingIndexer = createEmbeddingIndexer(db, embedder, {
    extractionCache,
    vaultPath,
  });
  // (search-version check moved below so it runs AFTER fullIndex)
} catch (err) {
  console.error('Failed to initialize embedder — search disabled:', err instanceof Error ? err.message : err);
}

console.log(`Indexing vault at ${vaultPath}...`);
const indexStart = Date.now();
await fullIndex(vaultPath, db, {
  onNodeDeleted: (nodeId) => embeddingIndexer?.removeNode(nodeId),
});
console.log(`Indexing complete in ${Date.now() - indexStart}ms`);
```

**Important:** this move requires `extractionCache` (built at lines 92-98) to also be moved BEFORE the embedder init. Read the current structure of `src/index.ts:85-145` in context and apply the minimum reorder: `extractionCache` → `embeddingIndexer` creation → `fullIndex` → `backfillResolvedTargets` → `startupSchemaRender` → (the rest: search-version check, re-enqueue, `backgroundProcess`). The `clearAll()` / version-bump / initial enqueue / `backgroundProcess` block needs to stay AFTER `fullIndex` so the re-enqueued node IDs reflect the post-index state.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS — existing tests unaffected; new test passes.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/embedding-cleanup-fullindex.test.ts src/indexer/indexer.ts src/index.ts
git commit -m "fix(indexer): wire embedding cleanup into fullIndex bulk delete

fullIndex's delete loop (indexer.ts:279-295) removed nodes from the DB
but never cleaned their embedding_vec rows, since the vec0 virtual table
has no FK cascade. Add onNodeDeleted callback to IndexerOptions and
invoke it inside the delete transaction; wire it at startup to call
embeddingIndexer.removeNode."
```

---

## Task 2: Thread `embeddingIndexer` through the reconciler

**Bug:** `src/sync/reconciler.ts:41` calls `deleteNodeByPath(node.file_path, db)` — third arg (`embeddingIndexer?`) omitted because `startReconciler` doesn't accept it. Sweep-detected deletions leak embedding rows.

**Files:**
- Create: `tests/integration/embedding-cleanup-reconciler.test.ts`
- Modify: `src/sync/reconciler.ts:17-24` (extend signature)
- Modify: `src/sync/reconciler.ts:41` (pass through)
- Modify: `src/index.ts:150` (pass at call site)

---

- [ ] **Step 1: Write the failing test**

Create `tests/integration/embedding-cleanup-reconciler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { createTempVault } from '../helpers/vault.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startReconciler } from '../../src/sync/reconciler.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

function createMockEmbeddingIndexer(): Pick<EmbeddingIndexer, 'removeNode'> & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    removeNode(nodeId: string) { removed.push(nodeId); },
  };
}

describe('reconciler embedding cleanup', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = openDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('passes embeddingIndexer to deleteNodeByPath on sweep-detected deletions', async () => {
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n---\n# A\n', 'utf-8');
    fullIndex(vaultPath, db);
    const nodeId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('a.md') as { id: string }).id;

    const mock = createMockEmbeddingIndexer();
    const mutex = new IndexMutex();
    const writeLock = new WriteLockManager();
    const reconciler = startReconciler(
      vaultPath,
      db,
      mutex,
      writeLock,
      undefined,
      mock as unknown as EmbeddingIndexer,
      { initialDelayMs: 10, intervalMs: 60_000 },
    );

    // Delete file, wait for initial sweep to fire.
    rmSync(join(vaultPath, 'a.md'));
    await new Promise(resolve => setTimeout(resolve, 100));
    reconciler.stop();

    expect(mock.removed).toContain(nodeId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/embedding-cleanup-reconciler.test.ts`
Expected: FAIL — `startReconciler` signature doesn't accept the mock argument; TypeScript compile error or the mock's `removed` array is empty.

- [ ] **Step 3: Extend `startReconciler` signature**

Modify `src/sync/reconciler.ts:1-10` — add import:

```ts
import type { EmbeddingIndexer } from '../search/indexer.js';
```

Modify `src/sync/reconciler.ts:17-24` — add parameter:

```ts
export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock?: WriteLockManager,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  options?: ReconcilerOptions,
): { stop: () => void } {
```

Modify `src/sync/reconciler.ts:41` — pass the indexer through:

```ts
      for (const node of dbNodes) {
        if (!diskFiles.has(node.file_path)) {
          deleteNodeByPath(node.file_path, db, embeddingIndexer);
          stats.deleted++;
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/embedding-cleanup-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire at the production call site**

Modify `src/index.ts:150` — add `embeddingIndexer` argument:

```ts
const reconciler = startReconciler(vaultPath, db, mutex, writeLock, syncLogger, embeddingIndexer);
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/embedding-cleanup-reconciler.test.ts src/sync/reconciler.ts src/index.ts
git commit -m "fix(reconciler): clean embedding rows on sweep-detected deletions

startReconciler didn't accept the embedding indexer, so its call to
deleteNodeByPath omitted the third arg and left stale embedding_vec
rows whenever a file was deleted outside the watcher's window. Add
embeddingIndexer parameter to startReconciler, pass through to
deleteNodeByPath, wire at the startup call site."
```

---

## Task 3: Warn when `set_types` conflicts with `add_types` / `remove_types`

**Bug:** `src/mcp/tools/update-node.ts:197-204` — if caller provides all three, only `set_types` is honored and `add_types` / `remove_types` are silently ignored.

**Files:**
- Create: `tests/mcp/update-node-type-conflict.test.ts`
- Modify: `src/mcp/tools/update-node.ts` (near the existing `hasTypeOp` block)

---

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/update-node-type-conflict.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { createTempVault } from '../helpers/vault.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  // Seed two schemas so type ops have valid targets.
  db.prepare("INSERT INTO schemas (name, display_name) VALUES ('note', 'Note'), ('task', 'Task')").run();
  return db;
}

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return tool.callback(args);
}

describe('update-node type-op conflict', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = openDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('emits TYPE_OP_CONFLICT issue when set_types combined with add_types', async () => {
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n  - note\n---\n# A\n', 'utf-8');
    fullIndex(vaultPath, db);

    const server = new McpServer({ name: 'test', version: '0' });
    const writeLock = new WriteLockManager();
    registerUpdateNode(server, db, writeLock, vaultPath);

    const result = await callTool(server, 'update-node', {
      file_path: 'a.md',
      set_types: ['task'],
      add_types: ['note'],
      dry_run: true,
    });

    const payload = JSON.parse(result.content[0].text);
    const issues = payload.preview?.issues ?? payload.issues ?? [];
    const conflict = issues.find((i: { code: string }) => i.code === 'TYPE_OP_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict.message).toMatch(/set_types/);
  });

  it('does not emit TYPE_OP_CONFLICT when only set_types is provided', async () => {
    writeFileSync(join(vaultPath, 'b.md'), '---\ntypes:\n  - note\n---\n# B\n', 'utf-8');
    fullIndex(vaultPath, db);

    const server = new McpServer({ name: 'test', version: '0' });
    const writeLock = new WriteLockManager();
    registerUpdateNode(server, db, writeLock, vaultPath);

    const result = await callTool(server, 'update-node', {
      file_path: 'b.md',
      set_types: ['task'],
      dry_run: true,
    });

    const payload = JSON.parse(result.content[0].text);
    const issues = payload.preview?.issues ?? payload.issues ?? [];
    expect(issues.find((i: { code: string }) => i.code === 'TYPE_OP_CONFLICT')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/update-node-type-conflict.test.ts`
Expected: FAIL — first test fails because no `TYPE_OP_CONFLICT` issue is produced; second test passes.

- [ ] **Step 3: Emit the warning**

Modify `src/mcp/tools/update-node.ts:194-204` — add conflict detection immediately after the existing `hasTypeOp` computation:

```ts
      // Compute final types: set_types wins outright, otherwise apply add/remove
      let finalTypes: string[];
      const hasTypeOp = set_types !== undefined || params.add_types !== undefined || params.remove_types !== undefined;
      const typeOpConflict: ToolIssue[] =
        set_types !== undefined && (params.add_types !== undefined || params.remove_types !== undefined)
          ? [{
              code: 'TYPE_OP_CONFLICT',
              message: 'set_types was provided — add_types and remove_types were ignored. Send only set_types for a full replacement, or only add_types/remove_types for incremental changes.',
            }]
          : [];
      if (set_types !== undefined) {
        finalTypes = set_types;
      } else {
        finalTypes = computeNewTypes(currentTypes, {
          add_types: params.add_types,
          remove_types: params.remove_types,
        });
      }
```

Then thread `typeOpConflict` into each of the three response sites that build `issues[]`:

(a) Dry-run preview response (around line 247):

```ts
            issues: [...validation.issues, ...titleIssues, ...typeOpConflict],
```

(b) Title-changed success response (around line 284):

```ts
            issues: [...mutResult.validation.issues, ...titleIssues, ...typeOpConflict],
```

(c) Standard success response (after the standard mutation call — find the equivalent `issues: [...]` line in the non-title-change return and extend with `...typeOpConflict`).

Read `src/mcp/tools/update-node.ts:290-350` in context and locate each return site that builds `issues`; extend each. If a return site doesn't currently build an `issues` array (some error paths may not), skip it — only non-error returns need the warning.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/update-node-type-conflict.test.ts`
Expected: PASS — both assertions satisfied.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/mcp/update-node-type-conflict.test.ts src/mcp/tools/update-node.ts
git commit -m "fix(update-node): warn when set_types conflicts with add/remove_types

set_types silently overrode add_types/remove_types when all three were
provided (update-node.ts:197-204), a silent no-op of the kind flagged
in the feedback memory. Emit TYPE_OP_CONFLICT in the issues array so
callers see that the incremental ops were dropped."
```

---

## Task 4: Replace reconciler silent-catch with `edits_log` error entries

**Bug:** `src/sync/reconciler.ts:76-78` — `catch { stats.errors++; }` swallows per-file errors without logging. The summary entry shows `errors: N` but the actual errors are unrecoverable from the record.

**Files:**
- Create: `tests/integration/reconciler-error-logging.test.ts`
- Modify: `src/sync/reconciler.ts:76-78`

---

- [ ] **Step 1: Write the failing test**

Create `tests/integration/reconciler-error-logging.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { createTempVault } from '../helpers/vault.js';
import { startReconciler } from '../../src/sync/reconciler.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('reconciler error logging', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = openDb();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('writes a reconciler-error edits_log entry when a file sweep throws', async () => {
    // Write a file but then remove read permission so statSync / readFileSync throws.
    const bad = join(vaultPath, 'unreadable.md');
    writeFileSync(bad, '---\ntypes:\n---\n# X\n', 'utf-8');
    chmodSync(bad, 0o000);

    try {
      const mutex = new IndexMutex();
      const writeLock = new WriteLockManager();
      const reconciler = startReconciler(
        vaultPath,
        db,
        mutex,
        writeLock,
        undefined,
        undefined,
        { initialDelayMs: 10, intervalMs: 60_000 },
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      reconciler.stop();

      const entries = db.prepare(
        "SELECT details FROM edits_log WHERE event_type = 'reconciler-error'"
      ).all() as Array<{ details: string }>;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some(e => e.details.includes('unreadable.md'))).toBe(true);
    } finally {
      chmodSync(bad, 0o644);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/reconciler-error-logging.test.ts`
Expected: FAIL — no `reconciler-error` entries exist; the silent catch swallows the error.

- [ ] **Step 3: Replace silent catch with edits_log write**

Modify `src/sync/reconciler.ts:47-79` — change the inner catch to record to `edits_log`:

```ts
      // Process changed files
      for (const relPath of diskFiles) {
        try {
          const absPath = join(vaultPath, relPath);
          const st = statSync(absPath);
          const mtime = Math.floor(st.mtimeMs);

          const existing = db.prepare('SELECT content_hash, file_mtime FROM nodes WHERE file_path = ?')
            .get(relPath) as { content_hash: string; file_mtime: number } | undefined;

          // Skip unchanged files
          if (existing && existing.file_mtime === mtime) {
            stats.skipped++;
            continue;
          }

          // Hash check
          const content = readFileSync(absPath, 'utf-8');
          const hash = sha256(content);
          if (existing && existing.content_hash === hash) {
            db.prepare('UPDATE nodes SET file_mtime = ? WHERE file_path = ?').run(mtime, relPath);
            stats.skipped++;
            continue;
          }

          // Process through pipeline if writeLock available, else skip
          if (writeLock) {
            processFileChange(absPath, relPath, db, writeLock, vaultPath, syncLogger);
          }
          stats.indexed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          db.prepare(
            'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
          ).run(null, Date.now(), 'reconciler-error', `${relPath}: ${msg}`);
          stats.errors++;
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/reconciler-error-logging.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/reconciler-error-logging.test.ts src/sync/reconciler.ts
git commit -m "fix(reconciler): log per-file errors to edits_log instead of swallowing

The reconciler sweep's inner catch incremented stats.errors but
discarded the actual error message and path, leaving the summary
edits_log entry with a count but no diagnostic detail. Write a
reconciler-error entry for each failure, preserving the file path
and error message."
```

---

## Self-review checklist

After completing all four tasks:

- [ ] **Spec coverage:** §1a → Task 1; §1b → Task 2; §1c → Task 3; §1d → Task 4. All four high-severity bugs covered.
- [ ] **Placeholder scan:** No TBD / TODO / "handle edge cases" / "similar to" references in the plan above.
- [ ] **Type consistency:** `onNodeDeleted?: (nodeId: string) => void` is the same shape as the existing `onNodeIndexed` callback. `TYPE_OP_CONFLICT` follows the `{code, message}` pattern of existing `ToolIssue`. `reconciler-error` event_type is a new addition to the `edits_log` vocabulary — consistent with the existing `reconciler-sweep` entry.
- [ ] **Build + full suite green:** `npm run build && npm test` before finishing.
