# WriteGate Cancellation & Sync Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancel pending WriteGate deferred writes when tool/propagation writes occur, and add per-file sync event timeline instrumentation via a `sync_log` table and `query-sync-log` MCP tool.

**Architecture:** SyncLogger class writes to a new `sync_log` table at key watcher/pipeline/propagation points. WriteGate cancellation is added to `executeMutation` (for tool writes) and `propagate.ts` (for schema propagation). A new `query-sync-log` MCP tool provides the forensic read interface.

**Tech Stack:** TypeScript, better-sqlite3, vitest, zod

---

### Task 1: Create `sync_log` table

**Files:**
- Modify: `src/db/schema.ts:89-95` (after `edits_log` table)

- [ ] **Step 1: Write the failing test**

Add a test to `tests/db/schema.test.ts` that verifies the `sync_log` table exists after schema creation:

```typescript
it('creates sync_log table with expected columns', () => {
  const info = db.prepare("PRAGMA table_info('sync_log')").all() as Array<{ name: string }>;
  const cols = info.map(c => c.name);
  expect(cols).toContain('id');
  expect(cols).toContain('timestamp');
  expect(cols).toContain('file_path');
  expect(cols).toContain('event');
  expect(cols).toContain('source');
  expect(cols).toContain('details');
});

it('has indexes on sync_log file_path and timestamp', () => {
  const indexes = db.prepare("PRAGMA index_list('sync_log')").all() as Array<{ name: string }>;
  const names = indexes.map(i => i.name);
  expect(names).toContain('idx_sync_log_file_path');
  expect(names).toContain('idx_sync_log_timestamp');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts`
Expected: FAIL — `sync_log` table does not exist.

- [ ] **Step 3: Add sync_log table to schema**

In `src/db/schema.ts`, after the `edits_log` CREATE TABLE block (around line 95), add:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "feat: add sync_log table for per-file event timeline"
```

---

### Task 2: Create SyncLogger class

**Files:**
- Create: `src/sync/sync-logger.ts`
- Create: `tests/sync/sync-logger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sync/sync-logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';

let db: Database.Database;
let logger: SyncLogger;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  logger = new SyncLogger(db);
});

afterEach(() => {
  db.close();
});

function getRows(): Array<{ file_path: string; event: string; source: string; details: string }> {
  return db.prepare('SELECT file_path, event, source, details FROM sync_log ORDER BY id').all() as Array<{
    file_path: string; event: string; source: string; details: string;
  }>;
}

describe('SyncLogger', () => {
  it('watcherEvent logs with hash and size', () => {
    logger.watcherEvent('note.md', 'abc123', 1024);
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe('note.md');
    expect(rows[0].event).toBe('watcher-event');
    expect(rows[0].source).toBe('watcher');
    expect(JSON.parse(rows[0].details)).toEqual({ hash: 'abc123', size: 1024 });
  });

  it('parseRetry logs attempt and error', () => {
    logger.parseRetry('note.md', 2, 'bad YAML');
    const rows = getRows();
    expect(rows[0].event).toBe('parse-retry');
    expect(JSON.parse(rows[0].details)).toEqual({ attempt: 2, error: 'bad YAML' });
  });

  it('deferredWriteScheduled logs event', () => {
    logger.deferredWriteScheduled('note.md');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-scheduled');
    expect(rows[0].source).toBe('watcher');
  });

  it('deferredWriteCancelled logs reason', () => {
    logger.deferredWriteCancelled('note.md', 'tool-write');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-cancelled');
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'tool-write' });
  });

  it('deferredWriteFired logs intended hash', () => {
    logger.deferredWriteFired('note.md', 'hash123');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-fired');
    expect(JSON.parse(rows[0].details)).toEqual({ intended_hash: 'hash123' });
  });

  it('deferredWriteSkipped logs reason with optional hashes', () => {
    logger.deferredWriteSkipped('note.md', 'stale-file', 'aaa', 'bbb');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-skipped');
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'stale-file', intended_hash: 'aaa', disk_hash: 'bbb' });
  });

  it('deferredWriteSkipped omits hashes when not provided', () => {
    logger.deferredWriteSkipped('note.md', 'node-deleted');
    const rows = getRows();
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'node-deleted' });
  });

  it('fileWritten logs source and hash', () => {
    logger.fileWritten('note.md', 'tool', 'xyz789');
    const rows = getRows();
    expect(rows[0].event).toBe('file-written');
    expect(rows[0].source).toBe('tool');
    expect(JSON.parse(rows[0].details)).toEqual({ hash: 'xyz789' });
  });

  it('noop logs source', () => {
    logger.noop('note.md', 'watcher');
    const rows = getRows();
    expect(rows[0].event).toBe('noop');
    expect(rows[0].source).toBe('watcher');
  });

  it('prunes old entries on construction', () => {
    // Insert a row with old timestamp directly
    db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now() - 100_000_000, 'old.md', 'watcher-event', 'watcher', '{}');

    // Creating a new logger triggers pruning
    const logger2 = new SyncLogger(db);
    const rows = db.prepare('SELECT * FROM sync_log WHERE file_path = ?').all('old.md');
    expect(rows).toHaveLength(0);
  });

  it('prunes every 1000 inserts', () => {
    // Insert an old row
    db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now() - 100_000_000, 'old.md', 'watcher-event', 'watcher', '{}');

    // Insert 1000 rows to trigger prune
    for (let i = 0; i < 1000; i++) {
      logger.noop(`file-${i}.md`, 'watcher');
    }

    const oldRows = db.prepare('SELECT * FROM sync_log WHERE file_path = ?').all('old.md');
    expect(oldRows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/sync/sync-logger.test.ts`
Expected: FAIL — module `../../src/sync/sync-logger.js` does not exist.

- [ ] **Step 3: Implement SyncLogger**

Create `src/sync/sync-logger.ts`:

```typescript
import type Database from 'better-sqlite3';

export class SyncLogger {
  private insertCount = 0;
  private readonly retentionMs: number;
  private readonly stmt: ReturnType<Database.Database['prepare']>;

  constructor(private db: Database.Database) {
    const hours = parseInt(process.env.SYNC_LOG_RETENTION_HOURS ?? '24', 10);
    this.retentionMs = (isNaN(hours) ? 24 : hours) * 3_600_000;
    this.stmt = db.prepare(
      'INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)',
    );
    this.prune();
  }

  watcherEvent(filePath: string, hash: string, size: number): void {
    this.log(filePath, 'watcher-event', 'watcher', { hash, size });
  }

  parseRetry(filePath: string, attempt: number, error: string): void {
    this.log(filePath, 'parse-retry', 'watcher', { attempt, error });
  }

  deferredWriteScheduled(filePath: string): void {
    this.log(filePath, 'deferred-write-scheduled', 'watcher', {});
  }

  deferredWriteCancelled(filePath: string, reason: string): void {
    this.log(filePath, 'deferred-write-cancelled', 'watcher', { reason });
  }

  deferredWriteFired(filePath: string, intendedHash: string): void {
    this.log(filePath, 'deferred-write-fired', 'watcher', { intended_hash: intendedHash });
  }

  deferredWriteSkipped(filePath: string, reason: string, intendedHash?: string, diskHash?: string): void {
    const details: Record<string, string> = { reason };
    if (intendedHash !== undefined) details.intended_hash = intendedHash;
    if (diskHash !== undefined) details.disk_hash = diskHash;
    this.log(filePath, 'deferred-write-skipped', 'watcher', details);
  }

  fileWritten(filePath: string, source: string, hash: string): void {
    this.log(filePath, 'file-written', source, { hash });
  }

  noop(filePath: string, source: string): void {
    this.log(filePath, 'noop', source, {});
  }

  private log(filePath: string, event: string, source: string, details: Record<string, unknown>): void {
    this.stmt.run(Date.now(), filePath, event, source, JSON.stringify(details));
    if (++this.insertCount % 1000 === 0) this.prune();
  }

  private prune(): void {
    this.db.prepare('DELETE FROM sync_log WHERE timestamp < ?').run(Date.now() - this.retentionMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/sync/sync-logger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/sync-logger.ts tests/sync/sync-logger.test.ts
git commit -m "feat: add SyncLogger class for per-file event timeline"
```

---

### Task 3: Add WriteGate cancellation to `executeMutation`

**Files:**
- Modify: `src/pipeline/execute.ts:34-39` (function signature) and Stage 5/6
- Create: `tests/sync/writegate-cancellation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sync/writegate-cancellation.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { WriteGate } from '../../src/sync/write-gate.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { createTempVault } from '../helpers/vault.js';
import { sha256 } from '../../src/indexer/hash.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let writeGate: WriteGate;
let syncLogger: SyncLogger;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  writeGate = new WriteGate({ quietPeriodMs: 3000 });
  syncLogger = new SyncLogger(db);
});

afterEach(() => {
  writeGate.dispose();
  db.close();
  cleanup();
});

function makeMutation(overrides: Partial<ProposedMutation> = {}): ProposedMutation {
  return {
    source: 'tool',
    node_id: null,
    file_path: 'test-node.md',
    title: 'Test Node',
    types: [],
    fields: {},
    body: '',
    ...overrides,
  };
}

function getSyncLogEvents(filePath: string): Array<{ event: string; details: string }> {
  return db.prepare('SELECT event, details FROM sync_log WHERE file_path = ? ORDER BY id')
    .all(filePath) as Array<{ event: string; details: string }>;
}

describe('WriteGate cancellation in executeMutation', () => {
  it('tool write cancels pending deferred write', () => {
    // Schedule a deferred write
    writeGate.fileChanged('test-node.md', () => {});
    expect(writeGate.isPending('test-node.md')).toBe(true);

    // Tool write through pipeline
    executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    // Deferred write should be cancelled
    expect(writeGate.isPending('test-node.md')).toBe(false);

    // Sync log should show cancellation
    const events = getSyncLogEvents('test-node.md');
    const cancelEvent = events.find(e => e.event === 'deferred-write-cancelled');
    expect(cancelEvent).toBeDefined();
    expect(JSON.parse(cancelEvent!.details).reason).toBe('tool-write');
  });

  it('tool no-op cancels pending deferred write', () => {
    // Create a node first
    const result = executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    // Schedule a deferred write
    writeGate.fileChanged('test-node.md', () => {});
    expect(writeGate.isPending('test-node.md')).toBe(true);

    // Tool mutation that results in no-op (same data)
    executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: result.node_id,
    }), writeGate, syncLogger);

    // Deferred write should be cancelled even on no-op
    expect(writeGate.isPending('test-node.md')).toBe(false);
  });

  it('watcher write (db_only) does NOT cancel pending deferred write', () => {
    // Schedule a deferred write
    writeGate.fileChanged('test-node.md', () => {});

    // Watcher write (db_only)
    executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      db_only: true,
      source_content_hash: 'abc',
    }), writeGate, syncLogger);

    // Deferred write should still be pending
    expect(writeGate.isPending('test-node.md')).toBe(true);
  });

  it('logs file-written event on tool write', () => {
    executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    const events = getSyncLogEvents('test-node.md');
    const writeEvent = events.find(e => e.event === 'file-written');
    expect(writeEvent).toBeDefined();
  });

  it('logs noop event on Stage 5 no-op', () => {
    // Create node
    const result = executeMutation(db, writeLock, vaultPath, makeMutation(), writeGate, syncLogger);

    // Clear sync log for clarity
    db.prepare('DELETE FROM sync_log').run();

    // Same data again = no-op
    executeMutation(db, writeLock, vaultPath, makeMutation({
      node_id: result.node_id,
    }), writeGate, syncLogger);

    const events = getSyncLogEvents('test-node.md');
    const noopEvent = events.find(e => e.event === 'noop');
    expect(noopEvent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/sync/writegate-cancellation.test.ts`
Expected: FAIL — `executeMutation` doesn't accept 5th/6th parameters yet (TypeScript errors).

- [ ] **Step 3: Modify `executeMutation` to accept `writeGate` and `syncLogger`**

In `src/pipeline/execute.ts`, update the function signature (line 34):

```typescript
import type { WriteGate } from '../sync/write-gate.js';
import type { SyncLogger } from '../sync/sync-logger.js';

export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): PipelineResult {
```

In the Stage 5 no-op check (around line 207), before returning the no-op result, add cancellation:

```typescript
    if (mutation.node_id !== null && existingContent !== null && sha256(existingContent) === renderedHash && dbHash === renderedHash) {
      // Tool no-ops cancel pending deferred writes — the tool confirmed
      // DB state is correct, superseding any pending watcher write.
      if (mutation.source === 'tool' && writeGate) {
        writeGate.cancel(mutation.file_path);
        syncLogger?.deferredWriteCancelled(mutation.file_path, 'tool-write');
      }
      syncLogger?.noop(mutation.file_path, mutation.source);
      return {
        node_id: mutation.node_id ?? '',
        file_path: mutation.file_path,
        validation,
        rendered_hash: renderedHash,
        edits_logged: 0,
        file_written: false,
        _noop: true,
      } as PipelineResult & { _noop: boolean };
    }
```

In Stage 6 (inside `writeLock.withLockSync`), before the file write (around line 224), add:

```typescript
      const shouldWriteFile = !mutation.db_only;
      if (shouldWriteFile && mutation.source === 'tool' && writeGate) {
        writeGate.cancel(mutation.file_path);
        syncLogger?.deferredWriteCancelled(mutation.file_path, 'tool-write');
      }
      if (shouldWriteFile) {
        atomicWriteFile(absPath, fileContent, tmpDir);
        syncLogger?.fileWritten(mutation.file_path, mutation.source, renderedHash);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/sync/writegate-cancellation.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: All existing tests pass. The new optional parameters don't break existing callers.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/execute.ts tests/sync/writegate-cancellation.test.ts
git commit -m "feat: add WriteGate cancellation and sync logging to executeMutation"
```

---

### Task 4: Plumb `writeGate` and `syncLogger` through tool handlers

**Files:**
- Modify: `src/mcp/server.ts:9-16` (ServerContext)
- Modify: `src/mcp/tools/index.ts:30,56-64` (registration calls)
- Modify: `src/mcp/tools/create-node.ts:25-29` (signature)
- Modify: `src/mcp/tools/update-node.ts` (signature + executeMutation calls)
- Modify: `src/mcp/tools/delete-node.ts:20-24` (signature — delete doesn't call executeMutation but needs writeGate for cancel)
- Modify: `src/mcp/tools/add-type-to-node.ts:24-28` (signature)
- Modify: `src/mcp/tools/remove-type-from-node.ts:21-25` (signature)
- Modify: `src/mcp/tools/rename-node.ts:31-35` (signature)
- Modify: `src/mcp/tools/batch-mutate.ts:26-30` (signature)

- [ ] **Step 1: Update `ServerContext` in `server.ts`**

In `src/mcp/server.ts`, add `SyncLogger` to the context type:

```typescript
import type { SyncLogger } from '../sync/sync-logger.js';

export interface ServerContext {
  db: Database.Database;
  writeLock?: WriteLockManager;
  writeGate?: WriteGate;
  syncLogger?: SyncLogger;
  vaultPath?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
}
```

Update `createServer` parameter type to include `syncLogger?: SyncLogger`.

- [ ] **Step 2: Update `registerAllTools` in `tools/index.ts`**

Update the `ctx` parameter type to include `syncLogger`:

```typescript
export function registerAllTools(server: McpServer, db: Database.Database, ctx?: {
  writeLock?: import('../../sync/write-lock.js').WriteLockManager;
  writeGate?: import('../../sync/write-gate.js').WriteGate;
  syncLogger?: import('../../sync/sync-logger.js').SyncLogger;
  vaultPath?: string;
  extractionCache?: import('../../extraction/cache.js').ExtractionCache;
  extractorRegistry?: import('../../extraction/registry.js').ExtractorRegistry;
}): void {
```

Update mutation tool registrations to pass `writeGate` and `syncLogger`:

```typescript
  if (ctx?.writeLock && ctx?.vaultPath) {
    registerCreateNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerUpdateNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerDeleteNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerAddTypeToNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerRemoveTypeFromNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerRenameNode(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
    registerBatchMutate(server, db, ctx.writeLock, ctx.vaultPath, ctx.writeGate, ctx.syncLogger);
  }
```

- [ ] **Step 3: Update each tool handler signature and forward to `executeMutation`**

For each of the 7 mutation tools, add `writeGate?` and `syncLogger?` parameters and forward them to `executeMutation` calls.

**`create-node.ts`** — update signature and the one `executeMutation` call:

```typescript
import type { WriteGate } from '../../sync/write-gate.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

export function registerCreateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): void {
```

Change `executeMutation(db, writeLock, vaultPath, { ... })` to `executeMutation(db, writeLock, vaultPath, { ... }, writeGate, syncLogger)`.

**`update-node.ts`** — same pattern, two `executeMutation` calls (single-node at line ~191, query-mode at line ~520).

**`add-type-to-node.ts`** — same pattern, one `executeMutation` call.

**`remove-type-from-node.ts`** — same pattern, one `executeMutation` call.

**`batch-mutate.ts`** — same pattern, three `executeMutation` calls (create at line ~74, update at line ~126, and the delete path doesn't use executeMutation).

**`delete-node.ts`** — add `writeGate?` and `syncLogger?` to signature. Before the unlink, cancel pending writes:

```typescript
import type { WriteGate } from '../../sync/write-gate.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

export function registerDeleteNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): void {
```

Inside the confirmed deletion block, before `writeLock.withLockSync`:

```typescript
      // Cancel any pending deferred write — node is being deleted
      if (writeGate) {
        writeGate.cancel(node.file_path);
        syncLogger?.deferredWriteCancelled(node.file_path, 'tool-write');
      }
```

**`rename-node.ts`** — add `writeGate?` and `syncLogger?` to signature. Forward to `executeMutation` calls. Additionally, before the file rename (around line 94), cancel pending writes on the old path:

```typescript
      const txn = db.transaction(() => {
        // Cancel pending deferred write on old path before rename
        if (writeGate) {
          writeGate.cancel(oldFilePath);
          syncLogger?.deferredWriteCancelled(oldFilePath, 'unlink');
        }

        // 1. Rename file on disk
        if (newFilePath !== oldFilePath) {
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All tests pass. Existing tests don't pass `writeGate`/`syncLogger`, which is fine since the params are optional.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools/index.ts src/mcp/tools/create-node.ts src/mcp/tools/update-node.ts src/mcp/tools/delete-node.ts src/mcp/tools/add-type-to-node.ts src/mcp/tools/remove-type-from-node.ts src/mcp/tools/rename-node.ts src/mcp/tools/batch-mutate.ts
git commit -m "feat: plumb writeGate and syncLogger through tool handlers"
```

---

### Task 5: Add WriteGate cancellation to propagation

**Files:**
- Modify: `src/schema/propagate.ts:73-79,291-296` (function signatures + cancel calls)
- Modify: `src/mcp/tools/update-schema.ts:63` (pass writeGate + syncLogger)
- Modify: `src/mcp/tools/update-global-field.ts:45` (pass writeGate + syncLogger)
- Modify: `src/mcp/tools/rename-global-field.ts:25` (pass writeGate + syncLogger)

- [ ] **Step 1: Write the failing test**

Add to `tests/sync/writegate-cancellation.test.ts`:

```typescript
import { propagateSchemaChange, diffClaims } from '../../src/schema/propagate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

describe('WriteGate cancellation in propagation', () => {
  it('propagateSchemaChange cancels pending deferred write', () => {
    // Set up a schema with a node
    createGlobalField(db, { name: 'priority', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // Create a node of type 'task'
    const nodeResult = executeMutation(db, writeLock, vaultPath, makeMutation({
      file_path: 'Tasks/test-task.md',
      title: 'Test Task',
      types: ['task'],
      fields: { priority: 'high' },
    }), writeGate, syncLogger);

    // Schedule a deferred write for this file
    writeGate.fileChanged('Tasks/test-task.md', () => {});
    expect(writeGate.isPending('Tasks/test-task.md')).toBe(true);

    // Propagate a schema change (add a new claim with default)
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
    const diff = diffClaims(
      [{ field: 'priority' }],
      [{ field: 'priority' }, { field: 'status', default_value: 'open' }],
    );
    propagateSchemaChange(db, writeLock, vaultPath, 'task', diff, writeGate, syncLogger);

    // Deferred write should be cancelled
    expect(writeGate.isPending('Tasks/test-task.md')).toBe(false);

    // Sync log should show propagation cancellation
    const events = getSyncLogEvents('Tasks/test-task.md');
    const cancelEvent = events.find(e => e.event === 'deferred-write-cancelled');
    expect(cancelEvent).toBeDefined();
    expect(JSON.parse(cancelEvent!.details).reason).toBe('propagation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/sync/writegate-cancellation.test.ts`
Expected: FAIL — `propagateSchemaChange` doesn't accept `writeGate`/`syncLogger` parameters.

- [ ] **Step 3: Update `propagateSchemaChange` and `rerenderNodesWithField`**

In `src/schema/propagate.ts`, update `propagateSchemaChange` signature (line 73):

```typescript
import type { WriteGate } from '../sync/write-gate.js';
import type { SyncLogger } from '../sync/sync-logger.js';

export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): PropagationResult {
```

Before each `writeLock.withLockSync` + `atomicWriteFile` block (around line 218), add cancellation:

```typescript
      if (writeGate) {
        writeGate.cancel(nodeRow.file_path);
        syncLogger?.deferredWriteCancelled(nodeRow.file_path, 'propagation');
      }

      writeLock.withLockSync(absPath, () => {
        atomicWriteFile(absPath, fileContent, tmpDir);
        syncLogger?.fileWritten(nodeRow.file_path, 'propagation', renderedHash);
```

Update `rerenderNodesWithField` signature (line 291):

```typescript
export function rerenderNodesWithField(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  fieldName: string,
  additionalNodeIds?: string[],
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): number {
```

Before its `writeLock.withLockSync` + `atomicWriteFile` block (around line 372), add:

```typescript
    if (writeGate) {
      writeGate.cancel(nodeRow.file_path);
      syncLogger?.deferredWriteCancelled(nodeRow.file_path, 'propagation');
    }

    writeLock.withLockSync(absPath, () => {
      atomicWriteFile(absPath, fileContent, tmpDir);
      syncLogger?.fileWritten(nodeRow.file_path, 'propagation', renderedHash);
```

- [ ] **Step 4: Update propagation callers in tool handlers**

**`update-schema.ts`** (line 63): Pass `writeGate` and `syncLogger`:

```typescript
          propagation = propagateSchemaChange(db, ctx.writeLock, ctx.vaultPath, name, diff, ctx.writeGate, ctx.syncLogger);
```

The `ctx` parameter already has the right type from Task 4. Add `writeGate` and `syncLogger` to the `ctx` type in the function signature if not already included:

```typescript
export function registerUpdateSchema(server: McpServer, db: Database.Database, ctx?: {
  writeLock?: WriteLockManager;
  writeGate?: import('../../sync/write-gate.js').WriteGate;
  syncLogger?: import('../../sync/sync-logger.js').SyncLogger;
  vaultPath?: string;
}): void {
```

**`update-global-field.ts`** (line 45): Same pattern:

```typescript
            const nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, name, uncoercibleIds, ctx.writeGate, ctx.syncLogger);
```

Update its `ctx` type similarly.

**`rename-global-field.ts`** (line 25): Same pattern:

```typescript
          nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, new_name, undefined, ctx.writeGate, ctx.syncLogger);
```

Update its `ctx` type similarly.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/schema/propagate.ts src/mcp/tools/update-schema.ts src/mcp/tools/update-global-field.ts src/mcp/tools/rename-global-field.ts tests/sync/writegate-cancellation.test.ts
git commit -m "feat: add WriteGate cancellation to schema propagation"
```

---

### Task 6: Instrument the watcher with SyncLogger

**Files:**
- Modify: `src/sync/watcher.ts:30-36` (startWatcher signature), plus ~8 logging call sites
- Modify: `src/sync/reconciler.ts:17-24` (startReconciler signature)

- [ ] **Step 1: Update `startWatcher` to accept `syncLogger`**

In `src/sync/watcher.ts`, update the signature (line 30):

```typescript
import type { SyncLogger } from './sync-logger.js';

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  writeGate: WriteGate,
  syncLogger?: SyncLogger,
  options?: WatcherOptions,
): FSWatcher {
```

- [ ] **Step 2: Add sync logging to `scheduleIndex`**

In `scheduleIndex` (line 54), after the `writeGate.cancel(relPath)` call (line 59), log the cancellation (only if a write was actually pending):

```typescript
    // Cancel any pending deferred write — a new edit just arrived
    if (writeGate.isPending(relPath)) {
      syncLogger?.deferredWriteCancelled(relPath, 'new-edit');
    }
    writeGate.cancel(relPath);
```

In `fire()`, after the content read succeeds (around line 82), log the watcher event:

```typescript
      syncLogger?.watcherEvent(relPath, hash, content.length);
```

In the parse retry logic (around line 100), log the retry:

```typescript
        if (retries <= 3) {
          retryCount.set(retryKey, retries);
          syncLogger?.parseRetry(relPath, retries, parseCheck.parseError ?? 'unknown');
```

- [ ] **Step 3: Add sync logging to `handleUnlink`**

In `handleUnlink` (line 131), before the existing `writeGate.cancel(relPath)` call (line 135):

```typescript
    if (writeGate.isPending(relPath)) {
      syncLogger?.deferredWriteCancelled(relPath, 'unlink');
    }
    writeGate.cancel(relPath);
```

- [ ] **Step 4: Update `processFileChange` to accept and use `syncLogger`**

Update `processFileChange` signature (line 187):

```typescript
export function processFileChange(
  absPath: string,
  relPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
): void {
```

In the WriteGate callback (line 300), add logging at key points:

After `writeGate.fileChanged(relPath, () => {`:
```typescript
      syncLogger?.deferredWriteScheduled(relPath);
```

At the top of the callback, before the DB read:
```typescript
    writeGate.fileChanged(relPath, () => {
        try {
          const currentNode = db.prepare(...)...;
          if (!currentNode) {
            syncLogger?.deferredWriteSkipped(relPath, 'node-deleted');
            return;
          }

          let diskContent: string;
          try {
            diskContent = readFileSync(join(vaultPath, relPath), 'utf-8');
          } catch {
            syncLogger?.deferredWriteSkipped(relPath, 'file-gone');
            return;
          }
```

After the stale-file guard (line 317):
```typescript
          if (sha256(diskContent) !== currentNode.content_hash) {
            syncLogger?.deferredWriteSkipped(relPath, 'stale-file');
            return;
          }
```

For the `deferredWriteFired` event — we need the intended hash. Compute the rendered hash at the start of the callback body, after stale-file guard passes. The actual render happens inside `executeMutation`, so log the fired event before calling it:

After the semantic-diff check passes and before calling `executeMutation` (around line 348):
```typescript
            syncLogger?.deferredWriteFired(relPath, sha256(diskContent));
```

After the semantic-match guard (line 341-342):
```typescript
            if (diskTitle === currentNode.title && ...) {
              syncLogger?.deferredWriteSkipped(relPath, 'semantic-match');
              return;
            }
```

After the parse-failed fallthrough (before line 368):
```typescript
          // Parse failed — log and fall through to write from DB state
          syncLogger?.deferredWriteFired(relPath, currentNode.content_hash);
```

- [ ] **Step 5: Update `processFileChange` callers**

The callers pass `syncLogger` through:

In `startWatcher` — `mutex.processEvent` callback (line 50):
```typescript
        processFileChange(absPath, relative(vaultPath, absPath), db, writeLock, vaultPath, writeGate, syncLogger);
```

In `mutex.run` inside `fire()` (line 115):
```typescript
        processFileChange(absPath, relPath, db, writeLock, vaultPath, writeGate, syncLogger);
```

- [ ] **Step 6: Update `startReconciler` to accept and forward `syncLogger`**

In `src/sync/reconciler.ts`, update the signature (line 17):

```typescript
import type { SyncLogger } from './sync-logger.js';

export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock?: WriteLockManager,
  writeGate?: WriteGate,
  syncLogger?: SyncLogger,
  options?: ReconcilerOptions,
): { stop: () => void } {
```

Forward `syncLogger` to `processFileChange` (line 73):

```typescript
            processFileChange(absPath, relPath, db, writeLock, vaultPath, writeGate, syncLogger);
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: All tests pass. Existing watcher tests don't pass `syncLogger`, which is fine.

- [ ] **Step 8: Commit**

```bash
git add src/sync/watcher.ts src/sync/reconciler.ts
git commit -m "feat: instrument watcher and reconciler with SyncLogger"
```

---

### Task 7: Wire everything up in `index.ts`

**Files:**
- Modify: `src/index.ts:46-56` (create SyncLogger, pass to consumers)

- [ ] **Step 1: Update `index.ts`**

In `src/index.ts`, after `writeGate` creation (line 46), create the SyncLogger:

```typescript
import { SyncLogger } from './sync/sync-logger.js';

const syncLogger = new SyncLogger(db);
const writeGate = new WriteGate({ quietPeriodMs: 3000 });
const watcher = startWatcher(vaultPath, db, mutex, writeLock, writeGate, syncLogger);
const reconciler = startReconciler(vaultPath, db, mutex, writeLock, writeGate, syncLogger);
```

Update the server factory (line 56):

```typescript
const serverFactory = () => createServer(db, { writeLock, writeGate, syncLogger, vaultPath, extractorRegistry, extractionCache });
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && npm test`
Expected: Build succeeds, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire SyncLogger into application startup"
```

---

### Task 8: Create `query-sync-log` MCP tool

**Files:**
- Create: `src/mcp/tools/query-sync-log.ts`
- Modify: `src/mcp/tools/index.ts` (register new tool)
- Create: `tests/mcp/query-sync-log.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/query-sync-log.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { registerQuerySyncLog } from '../../src/mcp/tools/query-sync-log.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
});

function insertRow(filePath: string, event: string, source: string, details: Record<string, unknown>, timestamp?: number): void {
  db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
    .run(timestamp ?? Date.now(), filePath, event, source, JSON.stringify(details));
}

// Helper to call the tool handler directly
async function callTool(params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerQuerySyncLog(server, db);

  // Access registered tool handler via server internals
  const tools = (server as any)._registeredTools;
  const tool = tools?.['query-sync-log'];
  if (!tool) throw new Error('Tool not registered');
  return tool.callback(params);
}

describe('query-sync-log tool', () => {
  it('returns all events for a file', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', { hash: 'abc', size: 100 });
    insertRow('note.md', 'deferred-write-scheduled', 'watcher', {});
    insertRow('other.md', 'watcher-event', 'watcher', { hash: 'xyz', size: 200 });

    const result = await callTool({ file_path: 'note.md' });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].event).toBe('watcher-event');
    expect(data.rows[1].event).toBe('deferred-write-scheduled');
  });

  it('filters by event type', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {});
    insertRow('note.md', 'file-written', 'tool', { hash: 'abc' });

    const result = await callTool({ file_path: 'note.md', events: ['file-written'] });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].event).toBe('file-written');
  });

  it('filters by source', async () => {
    insertRow('note.md', 'file-written', 'tool', {});
    insertRow('note.md', 'watcher-event', 'watcher', {});

    const result = await callTool({ file_path: 'note.md', source: 'tool' });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].source).toBe('tool');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      insertRow('note.md', 'watcher-event', 'watcher', {});
    }

    const result = await callTool({ file_path: 'note.md', limit: 3 });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toHaveLength(3);
  });

  it('supports desc sort order', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {}, 1000);
    insertRow('note.md', 'file-written', 'tool', {}, 2000);

    const result = await callTool({ file_path: 'note.md', sort_order: 'desc' });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows[0].event).toBe('file-written');
    expect(data.rows[1].event).toBe('watcher-event');
  });

  it('filters by since with relative time', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {}, Date.now() - 7200_000); // 2h ago
    insertRow('note.md', 'file-written', 'tool', {}, Date.now() - 1800_000); // 30m ago

    const result = await callTool({ file_path: 'note.md', since: '1h' });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].event).toBe('file-written');
  });

  it('returns all files when no file_path specified', async () => {
    insertRow('a.md', 'watcher-event', 'watcher', {});
    insertRow('b.md', 'file-written', 'tool', {});

    const result = await callTool({});
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toHaveLength(2);
  });

  it('parses details JSON in results', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', { hash: 'abc123', size: 1024 });

    const result = await callTool({ file_path: 'note.md' });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows[0].details).toEqual({ hash: 'abc123', size: 1024 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp/query-sync-log.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `query-sync-log` tool**

Create `src/mcp/tools/query-sync-log.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';

const paramsShape = {
  file_path: z.string().optional().describe('Filter to a single file path'),
  since: z.string().optional().describe('ISO timestamp or relative duration (e.g. "1h", "30m")'),
  events: z.array(z.string()).optional().describe('Filter to specific event types'),
  source: z.string().optional().describe('Filter by source (watcher, tool, propagation, reconciler)'),
  limit: z.number().default(100).describe('Max rows to return (max 1000)'),
  sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort by timestamp'),
};

function parseRelativeTime(since: string): number | null {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
  return Date.now() - ms;
}

export function registerQuerySyncLog(server: McpServer, db: Database.Database): void {
  server.tool(
    'query-sync-log',
    'Query the sync event timeline for debugging file synchronization issues. Returns per-file events showing watcher triggers, deferred writes, cancellations, and file writes.',
    paramsShape,
    async (params) => {
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (params.file_path) {
        conditions.push('file_path = ?');
        bindings.push(params.file_path);
      }

      if (params.since) {
        // Try relative time first, then ISO timestamp
        let sinceMs = parseRelativeTime(params.since);
        if (sinceMs === null) {
          const parsed = Date.parse(params.since);
          if (!isNaN(parsed)) sinceMs = parsed;
        }
        if (sinceMs !== null) {
          conditions.push('timestamp >= ?');
          bindings.push(sinceMs);
        }
      }

      if (params.events && params.events.length > 0) {
        const placeholders = params.events.map(() => '?').join(',');
        conditions.push(`event IN (${placeholders})`);
        bindings.push(...params.events);
      }

      if (params.source) {
        conditions.push('source = ?');
        bindings.push(params.source);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const order = params.sort_order === 'desc' ? 'DESC' : 'ASC';
      const limit = Math.min(params.limit, 1000);

      const sql = `SELECT timestamp, file_path, event, source, details FROM sync_log ${where} ORDER BY timestamp ${order}, id ${order} LIMIT ?`;
      bindings.push(limit);

      const rows = db.prepare(sql).all(...bindings) as Array<{
        timestamp: number;
        file_path: string;
        event: string;
        source: string;
        details: string | null;
      }>;

      const parsed = rows.map(row => ({
        timestamp: row.timestamp,
        time: new Date(row.timestamp).toISOString(),
        file_path: row.file_path,
        event: row.event,
        source: row.source,
        details: row.details ? JSON.parse(row.details) : {},
      }));

      return toolResult({
        rows: parsed,
        count: parsed.length,
        truncated: parsed.length === limit,
      });
    },
  );
}
```

- [ ] **Step 4: Register the tool in `tools/index.ts`**

Add import and registration call:

```typescript
import { registerQuerySyncLog } from './query-sync-log.js';
```

In `registerAllTools`, add (after the read-only tools, before the mutation tools block):

```typescript
  registerQuerySyncLog(server, db);
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/mcp/query-sync-log.test.ts`
Expected: PASS

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/query-sync-log.ts tests/mcp/query-sync-log.test.ts src/mcp/tools/index.ts
git commit -m "feat: add query-sync-log MCP tool for forensic debugging"
```

---

### Task 9: Build and verify end-to-end

**Files:**
- No new files

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Verify sync_log schema in built output**

Run: `node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); require('./dist/db/schema.js').createSchema(db); console.log(db.prepare(\"PRAGMA table_info('sync_log')\").all())"`

Or simply check the build output has the right imports:

Run: `grep -l 'sync-logger' dist/sync/ dist/mcp/tools/ dist/pipeline/ dist/schema/`
Expected: Files present in all directories where SyncLogger was added.

- [ ] **Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address build issues from sync-log integration"
```
