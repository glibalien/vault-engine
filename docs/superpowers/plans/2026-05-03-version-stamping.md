# Version Stamping & STALE_NODE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-node monotonic `version` integer with optional `expected_version` checks on the tool path, returning `STALE_NODE` (with the current node state embedded) when the caller's version is stale. Watcher path always bumps but never checks. Foundation for safe iframe writes.

**Architecture:** New `version INTEGER NOT NULL DEFAULT 1` column on `nodes`. Hooked into `executeMutation` / `executeDeletion` after the existing no-op check (`src/pipeline/execute.ts:267`). Threaded through node mutation tools as an optional zod param. `batch-mutate` uses skip-and-report semantics (per-op `status: "stale"` entry). Read tools (`get-node`, `query-nodes`) include `version` in returned shapes. Existing `content_hash` keeps its no-op-detection job — version is independent.

**Tech Stack:** TypeScript / ESM, better-sqlite3, vitest, zod, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-05-03-version-stamping-design.md`

---

## Pre-flight

- [ ] **Step 0: Verify clean working tree and current branch**

Run: `git status && git rev-parse --abbrev-ref HEAD`
Expected: clean working tree on `main` (or a feature branch dedicated to this work). If dirty, stash or commit first.

- [ ] **Step 0.1: Run baseline test suite**

Run: `npm test`
Expected: all tests pass before starting. If anything fails on `main`, stop and resolve before adding to it.

---

## Task 1: Add `version` column + idempotent migration

**Files:**
- Modify: `src/db/schema.ts:11-22` — add `version` to the `CREATE TABLE nodes` statement.
- Modify: `src/db/migrate.ts` — add `upgradeToVersionStamps`.
- Modify: `src/index.ts:10` (import) and `:52-55` (call site) — wire the migration into bootstrap.
- Create: `tests/db/migrate-version-stamps.test.ts`.

- [ ] **Step 1: Write the failing migration test**

Create `tests/db/migrate-version-stamps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { upgradeToVersionStamps } from '../../src/db/migrate.js';

function createPreVersionDb(): Database.Database {
  const db = new Database(':memory:');
  // Mimic the pre-migration nodes table: same columns minus `version`.
  db.prepare(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT,
      body TEXT,
      content_hash TEXT,
      file_mtime INTEGER,
      indexed_at INTEGER,
      created_at INTEGER
    )
  `).run();
  return db;
}

describe('upgradeToVersionStamps', () => {
  it('adds the version column and backfills existing rows to 1', () => {
    const db = createPreVersionDb();
    db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run('a', 'a.md');
    db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run('b', 'b.md');

    upgradeToVersionStamps(db);

    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('version');

    const rows = db.prepare('SELECT id, version FROM nodes ORDER BY id').all() as { id: string; version: number }[];
    expect(rows).toEqual([
      { id: 'a', version: 1 },
      { id: 'b', version: 1 },
    ]);
  });

  it('is idempotent (safe to run twice)', () => {
    const db = createPreVersionDb();
    upgradeToVersionStamps(db);
    expect(() => upgradeToVersionStamps(db)).not.toThrow();
  });

  it('leaves version values untouched on re-run', () => {
    const db = createPreVersionDb();
    db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)').run('a', 'a.md');
    upgradeToVersionStamps(db);
    db.prepare('UPDATE nodes SET version = 42 WHERE id = ?').run('a');
    upgradeToVersionStamps(db);
    const v = (db.prepare('SELECT version FROM nodes WHERE id = ?').get('a') as { version: number }).version;
    expect(v).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migrate-version-stamps.test.ts`
Expected: FAIL — `upgradeToVersionStamps is not a function`.

- [ ] **Step 3: Add the migration function**

In `src/db/migrate.ts`, append (after `upgradeToPhase2`):

```ts
/**
 * Add monotonic version stamps to nodes for optimistic concurrency.
 * Idempotent — safe to run on a database that already has the column.
 *
 * Spec: docs/superpowers/specs/2026-05-03-version-stamping-design.md
 */
export function upgradeToVersionStamps(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[])
    .map(c => c.name);
  if (!cols.includes('version')) {
    db.prepare('ALTER TABLE nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1').run();
    // No explicit backfill needed — DEFAULT 1 populates existing rows on column add.
  }
}
```

- [ ] **Step 4: Add the column to the fresh-DB schema**

In `src/db/schema.ts`, find the `CREATE TABLE IF NOT EXISTS nodes (...)` block (around line 11). Add `version INTEGER NOT NULL DEFAULT 1` after `file_mtime INTEGER,` (or wherever fits the existing column ordering). Final shape:

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  title TEXT,
  body TEXT,
  content_hash TEXT,
  file_mtime INTEGER,
  indexed_at INTEGER,
  created_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
```

- [ ] **Step 5: Wire the migration into bootstrap**

In `src/index.ts`:

- Update the import on line 10 from:
  ```ts
  upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6,
  ```
  to:
  ```ts
  upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6, upgradeToVersionStamps,
  ```
- After the `upgradeToPhase6(db);` call on line 55, add:
  ```ts
  upgradeToVersionStamps(db);
  ```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/db/migrate-version-stamps.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 7: Run full suite to confirm no regression**

Run: `npm test`
Expected: PASS — no existing tests broken by the additive column.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/index.ts tests/db/migrate-version-stamps.test.ts
git commit -m "feat(db): add version column to nodes with idempotent migration

Foundation for optimistic concurrency. Per-node monotonic integer,
NOT NULL DEFAULT 1 so existing rows backfill automatically on column add.
Migration is idempotent (column-existence check). Wired into bootstrap
after upgradeToPhase6.

Spec: docs/superpowers/specs/2026-05-03-version-stamping-design.md"
```

---

## Task 2: Bump version on every apply in `executeMutation`

**Files:**
- Modify: `src/pipeline/execute.ts` — INSERT includes `version = 1`, UPDATE bumps `version = version + 1`.
- Modify: `tests/pipeline/execute.test.ts` — add version-bump assertions.

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline/execute.test.ts` (use the existing test setup helpers in that file — match the surrounding pattern for DB / pipeline boilerplate):

```ts
describe('version stamping', () => {
  it('starts new nodes at version 1', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const result = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'fresh.md',
      types: ['note'],
      fields: {},
      body: '',
      source: 'tool',
    });
    const v = (db.prepare('SELECT version FROM nodes WHERE id = ?').get(result.node_id) as { version: number }).version;
    expect(v).toBe(1);
  });

  it('bumps version on each non-noop apply', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const created = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'x.md', types: ['note'], fields: {}, body: '', source: 'tool',
    });
    await executeMutation(db, vaultPath, writeLock, {
      node_id: created.node_id,
      file_path: 'x.md', types: ['note'], fields: {}, body: 'changed', source: 'tool',
    });
    await executeMutation(db, vaultPath, writeLock, {
      node_id: created.node_id,
      file_path: 'x.md', types: ['note'], fields: {}, body: 'changed again', source: 'tool',
    });
    const v = (db.prepare('SELECT version FROM nodes WHERE id = ?').get(created.node_id) as { version: number }).version;
    expect(v).toBe(3); // 1 (insert) -> 2 (first update) -> 3 (second update)
  });

  it('does not bump on no-op (rendered output identical to disk + DB)', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const created = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'y.md', types: ['note'], fields: {}, body: 'same', source: 'tool',
    });
    // Identical input -> no-op short-circuit at execute.ts:267
    const result = await executeMutation(db, vaultPath, writeLock, {
      node_id: created.node_id,
      file_path: 'y.md', types: ['note'], fields: {}, body: 'same', source: 'tool',
    });
    expect((result as PipelineResult & { _noop?: boolean })._noop).toBe(true);
    const v = (db.prepare('SELECT version FROM nodes WHERE id = ?').get(created.node_id) as { version: number }).version;
    expect(v).toBe(1); // still 1
  });
});
```

(If `setupPipeline()` doesn't exist in the test file, copy the boilerplate already used by the existing tests in `tests/pipeline/execute.test.ts` — every test there constructs the same DB + vaultPath + writeLock. Don't introduce a new helper if the file's pattern is inline.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "version stamping"`
Expected: FAIL — version is always `1` (or undefined depending on order), since no bump logic exists yet.

- [ ] **Step 3: Modify INSERT in `executeMutation`**

In `src/pipeline/execute.ts`, find the INSERT statement (around line 346-348):

```ts
INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, created_at)
VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @indexed_at, @created_at)
```

Update to include `version`:

```ts
INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at, created_at, version)
VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @indexed_at, @created_at, 1)
```

(`version: 1` is hardcoded for inserts; the DB DEFAULT also covers this, but being explicit avoids relying on column defaults at the SQL layer.)

- [ ] **Step 4: Modify UPDATE in `executeMutation` to bump version**

Still in `src/pipeline/execute.ts`, find the UPDATE statement (around line 350-356) which currently has clauses like `content_hash = @content_hash,`. Add `version = version + 1` to the SET clause:

```ts
UPDATE nodes SET
  file_path = @file_path,
  title = @title,
  body = @body,
  content_hash = @content_hash,
  file_mtime = @file_mtime,
  indexed_at = @indexed_at,
  version = version + 1
WHERE id = @id
```

(Match the exact existing column list — only adding `version = version + 1` to the SET assignments; do not change other clauses.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "version stamping"`
Expected: PASS — all three cases.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS — no regression. Watcher path still bumps (no check yet), no callers send `expectedVersion` so behavior unchanged otherwise.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/execute.ts tests/pipeline/execute.test.ts
git commit -m "feat(pipeline): bump nodes.version on every non-noop apply

INSERT sets version=1; UPDATE increments by 1. No-op short-circuit at
execute.ts:267 still bypasses the write entirely, so no-op writes don't
bump. Watcher path inherits the bump automatically (no check threaded yet)."
```

---

## Task 3: `StaleNodeError` + `expectedVersion` check in pipeline

**Files:**
- Modify: `src/pipeline/execute.ts` — define `StaleNodeError`; add `expectedVersion` check.
- Modify: `src/pipeline/delete.ts` — same `expectedVersion` check.
- Modify: `tests/pipeline/execute.test.ts` — add stale-check tests.

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline/execute.test.ts`:

```ts
import { StaleNodeError } from '../../src/pipeline/execute.js';

describe('expectedVersion check', () => {
  it('throws StaleNodeError when expectedVersion does not match current', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const created = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'z.md', types: ['note'], fields: {}, body: '', source: 'tool',
    });
    // current version = 1
    await expect(
      executeMutation(db, vaultPath, writeLock, {
        node_id: created.node_id,
        file_path: 'z.md', types: ['note'], fields: {}, body: 'new', source: 'tool',
        expectedVersion: 99,
      }),
    ).rejects.toBeInstanceOf(StaleNodeError);
  });

  it('proceeds when expectedVersion matches current', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const created = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'w.md', types: ['note'], fields: {}, body: '', source: 'tool',
    });
    await expect(
      executeMutation(db, vaultPath, writeLock, {
        node_id: created.node_id,
        file_path: 'w.md', types: ['note'], fields: {}, body: 'new', source: 'tool',
        expectedVersion: 1,
      }),
    ).resolves.toBeDefined();
  });

  it('proceeds when expectedVersion omitted (LWW preserved)', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const created = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'v.md', types: ['note'], fields: {}, body: '', source: 'tool',
    });
    await expect(
      executeMutation(db, vaultPath, writeLock, {
        node_id: created.node_id,
        file_path: 'v.md', types: ['note'], fields: {}, body: 'no version param', source: 'tool',
      }),
    ).resolves.toBeDefined();
  });

  it('StaleNodeError exposes nodeId, expected, and current versions', async () => {
    const { db, vaultPath, writeLock } = await setupPipeline();
    const created = await executeMutation(db, vaultPath, writeLock, {
      file_path: 'u.md', types: ['note'], fields: {}, body: '', source: 'tool',
    });
    try {
      await executeMutation(db, vaultPath, writeLock, {
        node_id: created.node_id,
        file_path: 'u.md', types: ['note'], fields: {}, body: 'x', source: 'tool',
        expectedVersion: 99,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(StaleNodeError);
      const err = e as StaleNodeError;
      expect(err.nodeId).toBe(created.node_id);
      expect(err.expectedVersion).toBe(99);
      expect(err.currentVersion).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "expectedVersion"`
Expected: FAIL — `StaleNodeError` not exported, `expectedVersion` not a known input.

- [ ] **Step 3: Define `StaleNodeError` and add the check**

In `src/pipeline/execute.ts`:

a) Add the error class near the top of the file (after imports, before `executeMutation`):

```ts
export class StaleNodeError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(`Node ${nodeId} was modified (v${expectedVersion} -> v${currentVersion}) since you read it`);
    this.name = 'StaleNodeError';
  }
}
```

b) Add `expectedVersion` to the `MutationInput` (or whatever the input type is named in the file — match the existing type's pattern):

```ts
export interface MutationInput {
  // ... existing fields ...
  expectedVersion?: number;
}
```

c) Insert the check inside `executeMutation`. Place it inside the transaction, **after** the no-op check at line 267 (so genuine no-ops don't trigger a stale error needlessly), **before** the INSERT/UPDATE at line 346:

```ts
// Optimistic concurrency check (only when caller supplied expectedVersion
// and the node already exists - new nodes have nothing to check against).
if (mutation.expectedVersion !== undefined && mutation.node_id !== null) {
  const row = db.prepare('SELECT version FROM nodes WHERE id = ?')
    .get(mutation.node_id) as { version: number } | undefined;
  if (row !== undefined && row.version !== mutation.expectedVersion) {
    throw new StaleNodeError(mutation.node_id, mutation.expectedVersion, row.version);
  }
}
```

- [ ] **Step 4: Mirror the check into `executeDeletion`**

In `src/pipeline/delete.ts`, find `executeDeletion` (or whatever the entry function is named). Add `expectedVersion?: number` to its input shape. Before the actual delete SQL, add:

```ts
import { StaleNodeError } from './execute.js';

// ... in executeDeletion body, before the DELETE ...
if (input.expectedVersion !== undefined) {
  const row = db.prepare('SELECT version FROM nodes WHERE id = ?')
    .get(input.node_id) as { version: number } | undefined;
  if (row !== undefined && row.version !== input.expectedVersion) {
    throw new StaleNodeError(input.node_id, input.expectedVersion, row.version);
  }
}
```

(Adjust field names — `input.node_id`, `input.expectedVersion` — to match the actual parameter shape `executeDeletion` uses. Open the file and pattern-match.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "expectedVersion"`
Expected: PASS — all four cases.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS — no callers pass `expectedVersion` yet, so behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/execute.ts src/pipeline/delete.ts tests/pipeline/execute.test.ts
git commit -m "feat(pipeline): StaleNodeError + optional expectedVersion check

executeMutation and executeDeletion accept optional expectedVersion.
Mismatch throws StaleNodeError with nodeId/expected/current. The check
sits after the no-op short-circuit so genuine no-ops never trigger
stale errors. Omitting the param preserves last-write-wins behavior."
```

---

## Task 4: `STALE_NODE` error code + `staleNodeEnvelope` helper

**Files:**
- Modify: `src/mcp/tools/errors.ts` — add `STALE_NODE` to `ErrorCode`.
- Create: `src/mcp/tools/stale-helpers.ts` — `buildStaleNodeEnvelope(db, error)` returns the `fail(...)` envelope with `current_node` populated.
- Create: `tests/mcp/stale-helpers.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/stale-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { StaleNodeError } from '../../src/pipeline/execute.js';
import { buildStaleNodeEnvelope } from '../../src/mcp/tools/stale-helpers.js';

function setupDbWithNode(): { db: Database.Database; nodeId: string } {
  const db = new Database(':memory:');
  db.prepare(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL,
      title TEXT, body TEXT, content_hash TEXT,
      file_mtime INTEGER, indexed_at INTEGER, created_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1
    )
  `).run();
  db.prepare('CREATE TABLE node_types (node_id TEXT, schema_type TEXT)').run();
  db.prepare(`
    CREATE TABLE node_fields (
      node_id TEXT, field_name TEXT, value_text TEXT,
      value_number REAL, value_date TEXT, value_json TEXT, source TEXT
    )
  `).run();
  db.prepare('INSERT INTO nodes (id, file_path, title, body, version) VALUES (?, ?, ?, ?, ?)')
    .run('abc', 'abc.md', 'My Node', 'body text', 8);
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('abc', 'note');
  return { db, nodeId: 'abc' };
}

describe('buildStaleNodeEnvelope', () => {
  it('returns a STALE_NODE error envelope with current_node populated', () => {
    const { db } = setupDbWithNode();
    const err = new StaleNodeError('abc', 7, 8);
    const result = buildStaleNodeEnvelope(db, err);
    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('STALE_NODE');
    expect(parsed.error.details.current_version).toBe(8);
    expect(parsed.error.details.expected_version).toBe(7);
    expect(parsed.error.details.current_node).toMatchObject({
      id: 'abc',
      title: 'My Node',
      version: 8,
      types: ['note'],
    });
  });

  it('omits current_node when the node no longer exists', () => {
    const { db } = setupDbWithNode();
    db.prepare('DELETE FROM nodes WHERE id = ?').run('abc');
    const err = new StaleNodeError('abc', 7, 8);
    const result = buildStaleNodeEnvelope(db, err);
    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(parsed.error.code).toBe('STALE_NODE');
    expect(parsed.error.details.current_node).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/stale-helpers.test.ts`
Expected: FAIL — `buildStaleNodeEnvelope` not found, `STALE_NODE` not a valid `ErrorCode`.

- [ ] **Step 3: Add `STALE_NODE` to the `ErrorCode` union**

In `src/mcp/tools/errors.ts`, change lines 4-16:

```ts
export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'AMBIGUOUS_MATCH'
  | 'INTERNAL_ERROR'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_TYPE'
  | 'EXTRACTOR_UNAVAILABLE'
  | 'AMBIGUOUS_FILENAME'
  | 'CONFLICT'
  | 'BATCH_FAILED'
  | 'OPERATION_NOT_FOUND'
  | 'CONFIRMATION_REQUIRED'
  | 'STALE_NODE';
```

- [ ] **Step 4: Create the helper**

Create `src/mcp/tools/stale-helpers.ts`:

```ts
import type Database from 'better-sqlite3';
import { fail } from './errors.js';
import { StaleNodeError } from '../../pipeline/execute.js';

interface CurrentNodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  version: number;
}

interface FieldRow {
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

/**
 * Builds the `STALE_NODE` error envelope, embedding the node's *current* state
 * so the caller (typically an MCP App iframe) can drop it into local state in
 * one round-trip instead of a follow-up `get-node` call.
 *
 * If the node has been deleted between read and write, `current_node` is
 * omitted from `details` (the absence is the signal).
 */
export function buildStaleNodeEnvelope(db: Database.Database, err: StaleNodeError) {
  const row = db.prepare(
    'SELECT id, file_path, title, body, version FROM nodes WHERE id = ?',
  ).get(err.nodeId) as CurrentNodeRow | undefined;

  const details: Record<string, unknown> = {
    current_version: err.currentVersion,
    expected_version: err.expectedVersion,
  };

  if (row !== undefined) {
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(err.nodeId) as { schema_type: string }[])
      .map(t => t.schema_type);
    const fieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?',
    ).all(err.nodeId) as FieldRow[];
    const fields: Record<string, unknown> = {};
    for (const f of fieldRows) {
      // Resolve the typed value the same way query-nodes/get-node does.
      // Inline minimal version (avoid pulling in the full resolver to keep this helper light):
      if (f.value_text !== null) fields[f.field_name] = f.value_text;
      else if (f.value_number !== null) fields[f.field_name] = f.value_number;
      else if (f.value_date !== null) fields[f.field_name] = f.value_date;
      else if (f.value_json !== null) fields[f.field_name] = JSON.parse(f.value_json);
    }
    details.current_node = {
      id: row.id,
      file_path: row.file_path,
      title: row.title,
      types,
      fields,
      body: row.body,
      version: row.version,
    };
  }

  return fail(
    'STALE_NODE',
    `Node ${err.nodeId} was modified (v${err.expectedVersion} -> v${err.currentVersion})`,
    { details },
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mcp/stale-helpers.test.ts`
Expected: PASS — both cases.

- [ ] **Step 6: Run typecheck (the closed-union typecheck pin)**

Run: `npm run build`
Expected: PASS. The `ErrorCode` is a string-literal union, so adding `STALE_NODE` is purely additive — no exhaustive `switch` failures.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/errors.ts src/mcp/tools/stale-helpers.ts tests/mcp/stale-helpers.test.ts
git commit -m "feat(mcp): STALE_NODE error code + buildStaleNodeEnvelope helper

Tools that catch StaleNodeError from the pipeline use this helper to
return a fail(STALE_NODE, ...) envelope with current_node embedded.
When the node was deleted between read and write, current_node is
omitted (absence signals deletion to the caller)."
```

---

## Task 5: `get-node` and `query-nodes` return `version`

**Files:**
- Modify: `src/mcp/tools/get-node.ts` — add `version` to `NodeRow` interface; SELECT * already picks it up; add to response shape.
- Modify: `src/mcp/tools/query-nodes.ts:91-136` (`enrichRows`) — add `version` to the returned object.
- Modify: `src/mcp/query-builder.ts` — extend the SELECT to include `n.version`.
- Modify or create: tests under `tests/mcp/` for both tools.

- [ ] **Step 1: Write the failing test (get-node)**

Add to (or create) `tests/mcp/get-node.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// Use the existing test harness in tests/mcp - match the pattern of an
// existing test file like tests/mcp/get-node.test.ts if present, otherwise
// follow the style of tests/integration/end-to-end.test.ts for setup.

describe('get-node returns version', () => {
  it('includes version in the response data', async () => {
    // setup: create a node, then call get-node tool
    // ... boilerplate matching existing get-node tests ...
    const result = await callGetNode({ node_id });
    expect(result.data.version).toBe(1);
  });
});
```

(If no existing `tests/mcp/get-node.test.ts` exists, follow the test boilerplate of the closest sibling — e.g. `tests/mcp/query-nodes.test.ts` if present, or extend an integration test in `tests/integration/`.)

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/mcp/get-node.test.ts -t "version"`
Expected: FAIL — `version` is `undefined` in the response.

- [ ] **Step 3: Add `version` to `get-node`'s `NodeRow` and response**

In `src/mcp/tools/get-node.ts`:

a) Update the `NodeRow` interface (lines 25-33):

```ts
interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  content_hash: string | null;
  file_mtime: number | null;
  indexed_at: number | null;
  version: number;  // <- add this
}
```

b) Find where the response object is constructed (search for `ok({` in the file). Add `version: node.version` to the data shape returned to the caller. The exact response-construction site varies; the relevant lines are after the `node = db.prepare('SELECT * FROM nodes WHERE id = ?')...` and the subsequent enrichment (types, fields, body, expand). Add `version` at the same level as `id`, `title`, `types`.

- [ ] **Step 4: Write the failing test (query-nodes)**

Add to (or create) `tests/mcp/query-nodes.test.ts`:

```ts
describe('query-nodes returns version', () => {
  it('includes version on each node row', async () => {
    // create two nodes, call query-nodes
    const result = await callQueryNodes({ types: ['note'] });
    for (const node of result.data.nodes) {
      expect(node.version).toBeTypeOf('number');
      expect(node.version).toBeGreaterThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 5: Run to confirm fail**

Run: `npx vitest run tests/mcp/query-nodes.test.ts -t "version"`
Expected: FAIL — `version` is `undefined` on each row.

- [ ] **Step 6: Add `version` to `enrichRows`**

In `src/mcp/tools/query-nodes.ts`, find `enrichRows` (line 91). Two changes:

a) Update the `NodeRow` interface (line 85-89):

```ts
interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  version: number;  // <- add this
}
```

b) Update the SELECT in `buildNodeQuery` (`src/mcp/query-builder.ts`). The existing query returns `n.id, n.file_path, n.title, n.body` — add `n.version`:

```ts
SELECT DISTINCT n.id, n.file_path, n.title, n.body, n.version
```

(Verify the exact text of the existing SELECT before editing. There is also a regex in `query-nodes.ts:307-310` that strips body for the hybrid-search candidate-ID query — update that regex to match the new SELECT shape if it doesn't already cover the trailing `n.version`.)

c) Update `enrichRows` to include `version` in the returned object (line 109-116):

```ts
const node: Record<string, unknown> = {
  id: row.id,
  file_path: row.file_path,
  title: row.title,
  version: row.version,  // <- add this
  types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
  field_count: (getFieldCount.get(row.id) as { count: number }).count,
};
```

d) The `getNode.get(hit.node_id)` SELECT in the hybrid-search branch (line 325) is `'SELECT id, file_path, title FROM nodes WHERE id = ?'` — extend it to `'SELECT id, file_path, title, version FROM nodes WHERE id = ?'` so version is available in the hybrid path too.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/get-node.test.ts tests/mcp/query-nodes.test.ts`
Expected: PASS for both new "version" cases.

- [ ] **Step 8: Run full suite**

Run: `npm test`
Expected: PASS — additive field doesn't break anything.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools/get-node.ts src/mcp/tools/query-nodes.ts src/mcp/query-builder.ts tests/mcp/get-node.test.ts tests/mcp/query-nodes.test.ts
git commit -m "feat(mcp): get-node and query-nodes return version

Additive field on existing response shapes. Iframes (and any caller
wanting to do optimistic concurrency) get version alongside the node
data they already fetch."
```

---

## Task 6: Wire `expected_version` into single-node mutation tools

**Files:**
- Modify: `src/mcp/tools/update-node.ts` — single-node mode accepts `expected_version`; query mode rejects it.
- Modify: `src/mcp/tools/add-type-to-node.ts`.
- Modify: `src/mcp/tools/remove-type-from-node.ts`.
- Modify: `src/mcp/tools/delete-node.ts`.
- Modify: `src/mcp/tools/rename-node.ts`.
- Modify or create: tests for each.

The pattern is identical for all five tools. Show the full pattern for `update-node`; the others apply the same recipe.

- [ ] **Step 1: Write the failing test (update-node)**

Add to `tests/mcp/update-node.test.ts` (or extend the existing one):

```ts
describe('update-node expected_version', () => {
  it('returns STALE_NODE when expected_version is stale', async () => {
    const node_id = await createNode({ title: 'task', types: ['note'] });
    // Bump the version twice via direct updates
    await callUpdateNode({ node_id, set_body: 'first edit' });
    await callUpdateNode({ node_id, set_body: 'second edit' });
    // Now version is 3. Send expected_version=1 -> stale.
    const result = await callUpdateNode({ node_id, set_body: 'third edit', expected_version: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('STALE_NODE');
    expect(result.error.details.current_version).toBe(3);
    expect(result.error.details.expected_version).toBe(1);
    expect(result.error.details.current_node.id).toBe(node_id);
    expect(result.error.details.current_node.version).toBe(3);
  });

  it('applies when expected_version matches', async () => {
    const node_id = await createNode({ title: 'task', types: ['note'] });
    const result = await callUpdateNode({ node_id, set_body: 'edit', expected_version: 1 });
    expect(result.ok).toBe(true);
  });

  it('rejects expected_version in query mode with INVALID_PARAMS', async () => {
    const result = await callUpdateNode({
      query: { types: ['note'] },
      set_fields: { status: 'done' },
      expected_version: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PARAMS');
    expect(result.error.message).toMatch(/expected_version/);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/mcp/update-node.test.ts -t "expected_version"`
Expected: FAIL — `expected_version` is rejected by zod (unknown param) or silently ignored.

- [ ] **Step 3: Add the param + thread + catch in `update-node`**

In `src/mcp/tools/update-node.ts`:

a) Add `expected_version` to `paramsShape` (after line 99 `dry_run` line, before line 101 `set_directory`):

```ts
expected_version: z.number().int().min(1).optional(),
```

b) Add a query-mode rejection. In the query-mode branch (around line 127, after the `if (hasQuery) {`), add:

```ts
if (params.expected_version !== undefined) {
  return fail('INVALID_PARAMS', 'expected_version is not supported in query mode (caller does not know which nodes will match).');
}
```

c) In the single-node mode branch, thread `expected_version` to the pipeline call. Find the `executeMutation(...)` invocation in the single-node path. Add `expectedVersion: params.expected_version` to the mutation input object.

d) Wrap the `executeMutation` call in a try/catch that handles `StaleNodeError`. Import the helper:

```ts
import { StaleNodeError } from '../../pipeline/execute.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';
```

Then:

```ts
try {
  const result = await executeMutation(db, vaultPath, writeLock, {
    // ... existing input ...
    expectedVersion: params.expected_version,
  });
  // ... existing post-result handling, return ok(...) ...
} catch (e) {
  if (e instanceof StaleNodeError) {
    return buildStaleNodeEnvelope(db, e);
  }
  throw e;  // re-throw anything else
}
```

(Match the actual invocation site exactly — there may be multiple internal calls per top-level invocation if the tool does multi-step mutations like rename-node. Wrap each call site.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/update-node.test.ts -t "expected_version"`
Expected: PASS.

- [ ] **Step 5: Apply the same pattern to the other four single-node tools**

For each of `add-type-to-node.ts`, `remove-type-from-node.ts`, `delete-node.ts`, `rename-node.ts`:

a) Add `expected_version: z.number().int().min(1).optional()` to the tool's `paramsShape`.
b) Pass `expectedVersion: params.expected_version` into the `executeMutation` (or `executeDeletion` for `delete-node`) call.
c) Wrap the call in a `try { ... } catch (e) { if (e instanceof StaleNodeError) return buildStaleNodeEnvelope(db, e); throw e; }`.
d) Add the same imports (`StaleNodeError`, `buildStaleNodeEnvelope`).

For `rename-node.ts` specifically: the tool already wraps its multi-step execution in `fsRollback` machinery. The version check fires inside the `executeMutation` call for the renamed node itself; wikilink rewrites in *referencing* nodes are deliberately not version-checked (caller doesn't know about them). Just wrap the primary `executeMutation` for the node being renamed.

- [ ] **Step 6: Add a focused test for each of the four other tools**

For each tool, add one passing test mirroring the update-node pattern:

```ts
// tests/mcp/add-type-to-node.test.ts
describe('add-type-to-node expected_version', () => {
  it('returns STALE_NODE when stale', async () => {
    const node_id = await createNode({ title: 'x', types: ['note'] });
    await callUpdateNode({ node_id, set_body: 'bump' }); // version -> 2
    const result = await callAddType({ node_id, type: 'task', expected_version: 1 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('STALE_NODE');
  });
});
```

(Same shape for remove-type-from-node, delete-node, rename-node — adjust the call helper and op-specific args.)

- [ ] **Step 7: Run all updated tool tests**

Run: `npx vitest run tests/mcp/`
Expected: PASS for all expected_version cases across the five tools.

- [ ] **Step 8: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools/update-node.ts src/mcp/tools/add-type-to-node.ts src/mcp/tools/remove-type-from-node.ts src/mcp/tools/delete-node.ts src/mcp/tools/rename-node.ts tests/mcp/
git commit -m "feat(mcp): expected_version on single-node mutation tools

Threads optional expected_version through update-node (single-node mode),
add-type-to-node, remove-type-from-node, delete-node, rename-node.
StaleNodeError from the pipeline gets wrapped via buildStaleNodeEnvelope.
update-node query mode rejects expected_version with INVALID_PARAMS."
```

---

## Task 7: `batch-mutate` per-op `expected_version`

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts` — each op accepts `expected_version`; per-op try/catch produces a `stale` status entry.
- Modify or extend: `tests/mcp/batch-mutate.test.ts`.

- [ ] **Step 1: Read the current `batch-mutate.ts` to understand its op-iteration pattern**

Run: `grep -n "for\|results\|status\|push" src/mcp/tools/batch-mutate.ts | head -30`

(Verify the per-op result shape and status enum before writing the test — match what's already there.)

- [ ] **Step 2: Write the failing test**

Add to `tests/mcp/batch-mutate.test.ts`:

```ts
describe('batch-mutate per-op expected_version', () => {
  it('reports per-op stale status, applies non-stale ops', async () => {
    const a = await createNode({ title: 'A', types: ['note'] });
    const b = await createNode({ title: 'B', types: ['note'] });
    const c = await createNode({ title: 'C', types: ['note'] });
    // Bump B out from under us.
    await callUpdateNode({ node_id: b, set_body: 'sneaky edit' }); // B is now version 2

    const result = await callBatchMutate({
      operations: [
        { op: 'update-node', node_id: a, set_body: 'fresh A', expected_version: 1 },
        { op: 'update-node', node_id: b, set_body: 'stale B', expected_version: 1 },
        { op: 'update-node', node_id: c, set_body: 'fresh C', expected_version: 1 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.data.results).toHaveLength(3);

    expect(result.data.results[0].status).toBe('applied');
    expect(result.data.results[1].status).toBe('stale');
    expect(result.data.results[1].details.current_version).toBe(2);
    expect(result.data.results[1].details.current_node.id).toBe(b);
    expect(result.data.results[2].status).toBe('applied');
  });
});
```

(Adjust the `operations` shape and call helper to match the actual batch-mutate API verbs.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/mcp/batch-mutate.test.ts -t "expected_version"`
Expected: FAIL — either zod rejects `expected_version` per op, or all three apply (no version check).

- [ ] **Step 4: Add per-op `expected_version` to the zod schema**

In `src/mcp/tools/batch-mutate.ts`, find the per-op zod object (the schema for entries inside the `operations` array). Add:

```ts
expected_version: z.number().int().min(1).optional(),
```

(Place it inside the per-op shape, not at the top level.)

- [ ] **Step 5: Wrap each per-op execution in stale handling**

Find the per-op execution loop in `batch-mutate.ts`. For each call to `executeMutation` / `executeDeletion`, pass `expectedVersion: op.expected_version`, and wrap in try/catch:

```ts
import { StaleNodeError } from '../../pipeline/execute.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';

// ... inside the per-op loop ...
try {
  const opResult = await executeMutation(db, vaultPath, writeLock, {
    // ... existing input mapping ...
    expectedVersion: op.expected_version,
  });
  const newVersion = (db.prepare('SELECT version FROM nodes WHERE id = ?')
    .get(opResult.node_id) as { version: number } | undefined)?.version;
  results.push({ op_index: i, status: 'applied', node_id: opResult.node_id, new_version: newVersion });
} catch (e) {
  if (e instanceof StaleNodeError) {
    // Build the stale entry inline, mirroring the envelope helper but as a
    // per-op result rather than a top-level fail() envelope.
    const stale = buildStaleNodeEnvelope(db, e);
    const parsed = JSON.parse((stale as { content: { text: string }[] }).content[0].text);
    results.push({
      op_index: i,
      status: 'stale',
      node_id: e.nodeId,
      details: parsed.error.details,
    });
    continue;
  }
  // Non-stale errors: reuse existing per-op error handling pattern.
  throw e;
}
```

(Match the actual variable names — `op`, `i`, `results`, `op_index` — to whatever the file uses. The existing per-op error path is the model; the `stale` branch is one more case alongside `applied` / `error`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/mcp/batch-mutate.test.ts -t "expected_version"`
Expected: PASS — three results, second one `status: "stale"`.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts tests/mcp/batch-mutate.test.ts
git commit -m "feat(mcp): batch-mutate per-op expected_version, skip-and-report

Each op accepts optional expected_version. Stale ops produce a per-op
status: 'stale' entry with current_node embedded; non-stale ops apply
normally. Matches batch-mutate's existing best-effort-not-transactional
contract."
```

---

## Task 8: Integration tests + final verification

**Files:**
- Create: `tests/integration/stale-node.test.ts`.
- Create: `tests/integration/watcher-version-bump.test.ts`.
- Modify (only if needed): existing helpers.

- [ ] **Step 1: End-to-end stale-flow integration test**

Create `tests/integration/stale-node.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
// Use the existing integration test harness - match the setup/teardown
// pattern of tests/integration/end-to-end.test.ts (vault dir, server, etc).

describe('stale-node end-to-end flow', () => {
  it('reads version, sees STALE_NODE on conflicting write, recovers via current_node', async () => {
    // 1. Caller A creates a node via create-node.
    // 2. Caller A reads via get-node - captures version (=1).
    // 3. Caller B updates the node via update-node - version -> 2.
    // 4. Caller A attempts update-node with expected_version=1.
    // 5. Assert: response is { ok: false, error: { code: 'STALE_NODE',
    //    details: { current_version: 2, expected_version: 1, current_node: {...} } } }.
    // 6. Assert: details.current_node.body matches Caller B's update.
    // 7. Caller A retries with expected_version=2 - succeeds.
  });

  it('handles delete-node staleness the same way', async () => {
    // Similar shape for delete-node.
  });

  it('rejects expected_version in update-node query mode', async () => {
    const result = await callUpdateNode({
      query: { types: ['note'] },
      set_fields: { status: 'done' },
      expected_version: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PARAMS');
  });
});
```

(Fill in the `// ...` step bodies using the actual integration-test helpers in `tests/integration/end-to-end.test.ts` for vault/DB/server setup.)

- [ ] **Step 2: Watcher version-bump integration test**

Create `tests/integration/watcher-version-bump.test.ts`:

```ts
describe('watcher path bumps version without checking', () => {
  it('bumps node version when a file is edited on disk', async () => {
    // 1. Create node via tool.
    // 2. Capture version (=1).
    // 3. Modify the .md file on disk directly (different body).
    // 4. Wait for watcher debounce window (~3s).
    // 5. Re-fetch node - version should be > 1.
  });

  it('watcher writes never throw StaleNodeError (no expectedVersion threaded)', async () => {
    // Watcher path uses source: 'watcher' and never sets expectedVersion.
    // This test verifies steady-state - no exceptions, just bump.
  });
});
```

(For the watcher debounce test, follow the pattern in `tests/sync/` or wherever existing watcher integration tests live — `find tests -name "*watch*"` to locate.)

- [ ] **Step 3: Run new integration tests**

Run: `npx vitest run tests/integration/stale-node.test.ts tests/integration/watcher-version-bump.test.ts`
Expected: PASS.

- [ ] **Step 4: Final full-suite verification**

Run: `npm run build && npm test`
Expected:
- `npm run build` — typecheck passes (the closed-union typecheck on `ErrorCode` now includes `STALE_NODE`; all callers of `fail()` are happy because they pass string literals that match).
- `npm test` — entire suite green.

- [ ] **Step 5: Manual smoke against the live MCP server**

Start the engine in dev mode:

```bash
npm run dev
```

In another terminal (or via the MCP inspector / Codex CLI / Claude with the local server connected), exercise the new behavior:

1. Call `query-nodes` with a small filter — confirm `version` appears on each node row.
2. Call `get-node` for one of them — confirm `version` is in the response.
3. Call `update-node` with the wrong `expected_version` — confirm `STALE_NODE` envelope with `current_node`.
4. Call `update-node` with the correct `expected_version` — confirm success and `version` increments.

(Capture command transcripts in the commit message for Task 8 if anything was non-obvious.)

- [ ] **Step 6: Commit**

```bash
git add tests/integration/stale-node.test.ts tests/integration/watcher-version-bump.test.ts
git commit -m "test(integration): end-to-end STALE_NODE + watcher version-bump

Covers the iframe-style write-conflict recovery path (read version,
conflicting write bumps it, original writer sees STALE_NODE with
current_node, retries successfully) and verifies the watcher path
bumps version without ever throwing StaleNodeError."
```

---

## Wrap-up

After Task 8 commits, the implementation is feature-complete against the spec. To validate:

- [ ] **Final step: Verify spec coverage**

Open `docs/superpowers/specs/2026-05-03-version-stamping-design.md` and walk each section:
- Data model — `version INTEGER NOT NULL DEFAULT 1` on nodes ✓ (Task 1)
- Tool surface, single-node — `expected_version` on five tools ✓ (Task 6)
- Tool surface, query-mode rejection — INVALID_PARAMS ✓ (Task 6)
- Tool surface, batch-mutate — per-op skip-and-report ✓ (Task 7)
- Tool surface, read tools — version on get-node + query-nodes ✓ (Task 5)
- Issue code — STALE_NODE in ErrorCode ✓ (Task 4)
- Pipeline — version bump + StaleNodeError check ✓ (Tasks 2, 3)
- Watcher path — no change, bumps automatically ✓ (Task 2 inherits)
- Undo path — no change ✓ (no expectedVersion threaded)
- Error handling table — every row covered ✓ (Tasks 6, 7)
- Race window analysis — single-statement transaction holds ✓ (Task 3 places the check inside the existing transaction)
- Testing — all unit + integration cases ✓ (Tasks 1, 2, 3, 4, 5, 6, 7, 8)
- Migration / backfill — idempotent, no version tracking needed ✓ (Task 1)

If any checkbox is missing, add a follow-up task before declaring done.

- [ ] **Mirror status to the vault note**

Update [[Vault Engine - Version Stamping Design Spec]] in the vault: change "Status" to "Implemented YYYY-MM-DD". Append any noteworthy plan-defects discovered during execution (mirror the convention used in the query-nodes pilot spec's "Two plan-defects discovered during execution" section).
