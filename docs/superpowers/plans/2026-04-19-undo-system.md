# Undo System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add operation-level undo for the seven node-mutation tools (`create-node`, `update-node`, `add-type-to-node`, `remove-type-from-node`, `rename-node`, `delete-node`, `batch-mutate`), backed by pre-state snapshots captured inside the write pipeline's existing DB transactions. Two new MCP tools (`list-undo-history`, `undo-operations`) surface history and execution. Restore routes back through the pipeline with a new `source: 'undo'`.

**Architecture:** Snapshot rows are written inside `executeMutation` / `executeDeletion` transactions so they commit atomically with the mutation. The MCP tool handler owns the `operation_id` (one per user-intent tool call) and threads it through every pipeline call it makes via a new optional `UndoContext` parameter. Undo execution reads snapshots, detects conflicts (path-occupied, post-op drift, superseded by later op), and replays the pre-state through the same pipeline with `source: 'undo'`. Retention is 24h with a two-step expiry. Design spec: `docs/superpowers/specs/2026-04-19-undo-system-design.md`.

**Tech Stack:** TypeScript (ESM, `.js` imports), `better-sqlite3`, `nanoid`, Vitest. All tables are new; no migration of existing data.

---

## File Structure

**New files:**
- `src/undo/operation.ts` — `createOperation`, `finalizeOperation`, `listOperations`, `getOperation`, `getSnapshots`, `markUndone`
- `src/undo/restore.ts` — `detectConflicts`, `restoreOperation`, `restoreMany`
- `src/undo/cleanup.ts` — `runUndoCleanup` (retention + orphan sweeps), `startUndoCleanup` (interval)
- `src/undo/types.ts` — shared types (`UndoOperationRow`, `UndoSnapshotRow`, `Conflict`, `RestoreResult`)
- `src/mcp/tools/list-undo-history.ts`
- `src/mcp/tools/undo-operations.ts`
- `tests/undo/operation.test.ts`
- `tests/undo/restore.test.ts`
- `tests/undo/cleanup.test.ts`
- `tests/undo/capture-pipeline.test.ts`
- `tests/undo/integration.test.ts` — end-to-end per tool
- `tests/mcp/list-undo-history.test.ts`
- `tests/mcp/undo-operations.test.ts`

**Modified files:**
- `src/db/migrate.ts` — add `addUndoTables(db)`
- `src/index.ts` — call `addUndoTables(db)`; start `startUndoCleanup`
- `src/pipeline/types.ts` — add `UndoContext` interface, extend `ProposedMutation.source` with `'undo'`
- `src/pipeline/delete.ts` — add `undoContext?` param, extend `source` with `'undo'`, snapshot capture, allow pipeline-driven create via caller-provided id (n/a for delete — only for mutation)
- `src/pipeline/execute.ts` — add `undoContext?` param, `source: 'undo'` gate (skip default population, tolerate `REQUIRED_MISSING`), accept caller-provided `node_id` on create, snapshot capture
- `src/mcp/tools/create-node.ts` — wire undo
- `src/mcp/tools/update-node.ts` — wire undo (both single and query mode)
- `src/mcp/tools/add-type-to-node.ts` — wire undo
- `src/mcp/tools/remove-type-from-node.ts` — wire undo
- `src/mcp/tools/rename-node.ts` — wire undo (shared id across N+1 pipeline calls)
- `src/mcp/tools/delete-node.ts` — wire undo
- `src/mcp/tools/batch-mutate.ts` — wire undo (shared id across K sub-ops)
- `src/mcp/tools/vault-stats.ts` — add `undo` aggregate
- `src/mcp/server.ts` — register `list-undo-history`, `undo-operations`

**Dependency order:** 1 (schema) → 2 (types) → 3,4 (pipeline capture; parallelizable) → 5 (source gate) → 6 (operation) → 7 (restore) → 8 (cleanup) → 9–14 (tool wiring; parallelizable) → 15,16 (MCP tools) → 17 (vault-stats) → 18 (startup) → 19 (end-to-end tests).

---

## Task 1: Schema — undo_operations and undo_snapshots tables

**Files:**
- Modify: `src/db/migrate.ts` — append `addUndoTables`
- Create: `tests/db/undo-tables-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/undo-tables-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';

describe('addUndoTables', () => {
  it('creates undo_operations and undo_snapshots with expected columns and indexes', () => {
    const db = createTestDb();
    addUndoTables(db);

    const opCols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>);
    expect(opCols.map(c => c.name).sort()).toEqual(
      ['description', 'node_count', 'operation_id', 'source_tool', 'status', 'timestamp'],
    );
    expect(opCols.find(c => c.name === 'operation_id')?.pk).toBe(1);

    const snapCols = (db.prepare('PRAGMA table_info(undo_snapshots)').all() as Array<{ name: string; pk: number }>);
    expect(snapCols.map(c => c.name).sort()).toEqual(
      ['body', 'fields', 'file_path', 'node_id', 'operation_id', 'post_mutation_hash', 'relationships', 'title', 'types', 'was_deleted'],
    );

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('undo_operations','undo_snapshots')").all() as Array<{ name: string }>).map(r => r.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_undo_operations_timestamp',
      'idx_undo_operations_status',
      'idx_undo_snapshots_node',
    ]));
  });

  it('is idempotent — safe to run twice', () => {
    const db = createTestDb();
    addUndoTables(db);
    expect(() => addUndoTables(db)).not.toThrow();
  });

  it('cascades snapshot deletion when operation is deleted', () => {
    const db = createTestDb();
    addUndoTables(db);
    db.prepare('INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('op1', 1, 'create-node', 'desc', 1, 'active');
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, ?)')
      .run('op1', 'n1', 'a.md', 1);

    db.prepare('DELETE FROM undo_operations WHERE operation_id = ?').run('op1');
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/undo-tables-migration.test.ts`
Expected: FAIL — `addUndoTables` does not exist.

- [ ] **Step 3: Add `addUndoTables` to `src/db/migrate.ts`**

Append at the end of `src/db/migrate.ts`:

```ts
/**
 * Migration: add undo_operations and undo_snapshots tables (2026-04-19).
 *
 * Snapshot-based operation-level undo. See
 * docs/superpowers/specs/2026-04-19-undo-system-design.md.
 *
 * Idempotent — safe to run on a database that already has the tables.
 */
export function addUndoTables(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_operations (
        operation_id TEXT PRIMARY KEY,
        timestamp    INTEGER NOT NULL,
        source_tool  TEXT NOT NULL,
        description  TEXT NOT NULL,
        node_count   INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'active'
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_snapshots (
        operation_id       TEXT NOT NULL REFERENCES undo_operations(operation_id) ON DELETE CASCADE,
        node_id            TEXT NOT NULL,
        file_path          TEXT NOT NULL,
        title              TEXT,
        body               TEXT,
        types              TEXT,
        fields             TEXT,
        relationships      TEXT,
        was_deleted        INTEGER NOT NULL,
        post_mutation_hash TEXT,
        PRIMARY KEY (operation_id, node_id)
      )
    `).run();

    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_operations_timestamp ON undo_operations(timestamp)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_operations_status    ON undo_operations(status)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_snapshots_node       ON undo_snapshots(node_id)').run();
  });
  run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/undo-tables-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into startup**

Modify `src/index.ts` at the migration block (around line 54):

```ts
import { upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6, addCreatedAt, upgradeForOverrides, ensureMetaTable, upgradeForResolvedTargetId, addUndoTables } from './db/migrate.js';
```

Then in the migration sequence:

```ts
ensureMetaTable(db);
upgradeForResolvedTargetId(db);
addUndoTables(db);
```

- [ ] **Step 6: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrate.ts src/index.ts tests/db/undo-tables-migration.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add undo_operations and undo_snapshots tables

Additive, idempotent migration. Supports operation-level undo per
docs/superpowers/specs/2026-04-19-undo-system-design.md. No data
changes to existing tables.
EOF
)"
```

---

## Task 2: Pipeline types — `UndoContext` + `'undo'` source

**Files:**
- Modify: `src/pipeline/types.ts`
- Create: `src/undo/types.ts`

- [ ] **Step 1: Create `src/undo/types.ts`**

```ts
// src/undo/types.ts
//
// Types shared between the undo module, pipeline integration, and MCP tools.

export interface UndoOperationRow {
  operation_id: string;
  timestamp: number;
  source_tool: string;
  description: string;
  node_count: number;
  status: 'active' | 'undone' | 'expired';
}

export interface UndoSnapshotRow {
  operation_id: string;
  node_id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  types: string | null;                 // JSON array
  fields: string | null;                // JSON object
  relationships: string | null;         // JSON array
  was_deleted: 0 | 1;
  post_mutation_hash: string | null;
}

export type ConflictReason =
  | 'path_occupied'
  | 'modified_after_operation'
  | 'superseded_by_later_op';

export interface Conflict {
  operation_id: string;
  node_id: string;
  file_path: string;
  reason: ConflictReason;
  modified_by?: string[];             // e.g., ["update-node at 2026-04-19T14:30:00Z"]
  current_summary: Record<string, unknown>;
  would_restore_summary: Record<string, unknown>;
}

export interface RestoreResult {
  operations: Array<{
    operation_id: string;
    node_count: number;
    status: 'would_undo' | 'undone';
  }>;
  conflicts: Conflict[];
  total_undone: number;
  total_conflicts: number;
  total_skipped: number;
}
```

- [ ] **Step 2: Extend `src/pipeline/types.ts`**

Modify the `ProposedMutation.source` union and add `UndoContext`:

```ts
export interface ProposedMutation {
  source: 'tool' | 'watcher' | 'normalizer' | 'propagation' | 'undo';
  node_id: string | null;
  file_path: string;
  title: string;
  types: string[];
  fields: Record<string, unknown>;
  body: string;
  raw_field_texts?: Record<string, string>;
  source_content_hash?: string;
  db_only?: boolean;
}

/**
 * Caller-generated context signalling undo-snapshot capture.
 * Absent undoContext on an executeMutation/executeDeletion call
 * means no snapshot is written. Re-used across every pipeline call
 * a single user-intent tool issues.
 */
export interface UndoContext {
  operation_id: string;
}
```

- [ ] **Step 3: Extend `ProposedDeletion.source` in `src/pipeline/delete.ts`**

Modify `ProposedDeletion`:

```ts
export interface ProposedDeletion {
  source: 'tool' | 'watcher' | 'reconciler' | 'fullIndex' | 'batch' | 'undo';
  node_id: string;
  file_path: string;
  unlink_file: boolean;
  reason?: string;
}
```

(No callers break because we're only widening the union.)

- [ ] **Step 4: Verify compile**

Run: `npm run build`
Expected: PASS — adding to union types is backward compatible.

- [ ] **Step 5: Commit**

```bash
git add src/undo/types.ts src/pipeline/types.ts src/pipeline/delete.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): add UndoContext and 'undo' source variants

Introduces src/undo/types.ts with shared undo row/result types. Widens
ProposedMutation.source and ProposedDeletion.source to include 'undo'
in preparation for undo-driven pipeline calls.
EOF
)"
```

---

## Task 3: Pipeline — snapshot capture in `executeMutation`

**Bug-free goal:** `executeMutation` writes an `undo_snapshots` row when `undoContext` is provided, inside the same transaction as the mutation, pre-state of the node captured before validation runs. Post-mutation hash is filled in at end-of-txn from the rendered hash. Rollback on mutation failure rolls back the snapshot too.

**Files:**
- Modify: `src/pipeline/execute.ts` — accept `undoContext?: UndoContext`, capture snapshot in txn
- Create: `tests/undo/capture-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/undo/capture-pipeline.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type Database from 'better-sqlite3';

describe('executeMutation — undo snapshot capture', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    // Seed the undo operation
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op1', Date.now(), 'create-node', 'test');
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('writes a was_deleted=1 snapshot for a create (node_id null)', () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'foo.md',
      title: 'Foo',
      types: ['note'],
      fields: {},
      body: 'hello',
    }, undefined, { operation_id: 'op1' });

    const snaps = db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?').all('op1') as Array<{ was_deleted: number; post_mutation_hash: string | null; file_path: string }>;
    expect(snaps.length).toBe(1);
    expect(snaps[0].was_deleted).toBe(1);
    expect(snaps[0].file_path).toBe('foo.md');
    expect(snaps[0].post_mutation_hash).not.toBeNull();
  });

  it('writes a was_deleted=0 snapshot capturing pre-state for an update', () => {
    // First create
    const createRes = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'bar.md',
      title: 'Bar', types: ['note'], fields: {}, body: 'first',
    });
    const nodeId = createRes.node_id;

    // Seed a second operation
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op2', Date.now(), 'update-node', 'update');

    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: nodeId, file_path: 'bar.md',
      title: 'Bar', types: ['note'], fields: {}, body: 'second',
    }, undefined, { operation_id: 'op2' });

    const snap = db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?').get('op2') as { was_deleted: number; body: string; post_mutation_hash: string | null };
    expect(snap.was_deleted).toBe(0);
    expect(snap.body).toBe('first');  // pre-state, not post
    expect(snap.post_mutation_hash).not.toBeNull();
  });

  it('does not write a snapshot when undoContext is absent', () => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'baz.md',
      title: 'Baz', types: ['note'], fields: {}, body: '',
    });
    const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/capture-pipeline.test.ts`
Expected: FAIL — `executeMutation` doesn't accept the extra argument; if it does silently, no rows are written.

- [ ] **Step 3: Add `undoContext` parameter and snapshot capture**

Modify `src/pipeline/execute.ts`.

Import:

```ts
import type { UndoContext } from './types.js';
```

Extend the function signature:

```ts
export function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
  syncLogger?: SyncLogger,
  undoContext?: UndoContext,
): PipelineResult {
```

Inside the `db.transaction(() => { ... })` block, immediately after Stage 1 (`loadSchemaContext`) and before Stage 2 (`validateProposedState`), insert the snapshot:

```ts
    // ── Undo snapshot capture (pre-mutation state) ──────────────────
    if (undoContext) {
      if (mutation.node_id === null) {
        // Create: snapshot row with was_deleted = 1, other JSON columns null
        db.prepare(`
          INSERT INTO undo_snapshots (
            operation_id, node_id, file_path, title, body, types, fields, relationships,
            was_deleted, post_mutation_hash
          ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, NULL)
        `).run(undoContext.operation_id, `pending:${mutation.file_path}`, mutation.file_path);
      } else {
        // Update: snapshot current DB state
        const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
          .get(mutation.node_id) as { file_path: string; title: string | null; body: string | null } | undefined;
        if (nodeRow) {
          const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
            .all(mutation.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);
          const fieldsRows = db.prepare(
            'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
          ).all(mutation.node_id);
          const relRows = db.prepare(
            'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
          ).all(mutation.node_id);

          db.prepare(`
            INSERT INTO undo_snapshots (
              operation_id, node_id, file_path, title, body, types, fields, relationships,
              was_deleted, post_mutation_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
          `).run(
            undoContext.operation_id,
            mutation.node_id,
            nodeRow.file_path,
            nodeRow.title,
            nodeRow.body,
            JSON.stringify(typesArr),
            JSON.stringify(fieldsRows),
            JSON.stringify(relRows),
          );
        }
      }
    }
```

After Stage 6 (file write + DB writes complete), update the snapshot with `post_mutation_hash` and (for creates) swap the pending `node_id` placeholder for the generated one. Place this just before the `return { node_id: nodeId, ... }` at the end of Stage 6:

```ts
      // ── Undo snapshot finalization (post-mutation hash) ─────────────
      if (undoContext) {
        if (isCreate) {
          // Swap placeholder node_id for the generated one and record hash
          db.prepare(`
            UPDATE undo_snapshots
            SET node_id = ?, post_mutation_hash = ?
            WHERE operation_id = ? AND node_id = ?
          `).run(nodeId, contentHash, undoContext.operation_id, `pending:${mutation.file_path}`);
        } else {
          db.prepare(`
            UPDATE undo_snapshots
            SET post_mutation_hash = ?
            WHERE operation_id = ? AND node_id = ?
          `).run(contentHash, undoContext.operation_id, nodeId);
        }
      }
```

(The `contentHash` variable is already defined at line ~280 of `execute.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/capture-pipeline.test.ts`
Expected: PASS — all three assertions satisfied.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/execute.ts tests/undo/capture-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): capture undo snapshots in executeMutation

Writes a pre-state snapshot row inside the Stage-1–6 transaction when
an undoContext is provided. For creates, records was_deleted = 1 with
a pending placeholder node_id; after the generated node_id is known,
the row is updated in-place with the real id and post_mutation_hash.
For updates, captures full current DB state (types/fields/body/
relationships) before validation.
EOF
)"
```

---

## Task 4: Pipeline — snapshot capture in `executeDeletion`

**Files:**
- Modify: `src/pipeline/delete.ts`
- Add tests to: `tests/undo/capture-pipeline.test.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/undo/capture-pipeline.test.ts`:

```ts
import { executeDeletion } from '../../src/pipeline/delete.js';

describe('executeDeletion — undo snapshot capture', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('writes a was_deleted=0 snapshot capturing pre-delete state', () => {
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op-del', Date.now(), 'delete-node', 'del');

    const createRes = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'to-delete.md',
      title: 'X', types: ['note'], fields: {}, body: 'content',
    });
    const nodeId = createRes.node_id;

    executeDeletion(db, writeLock, vaultPath, {
      source: 'tool', node_id: nodeId, file_path: 'to-delete.md', unlink_file: true,
    }, { operation_id: 'op-del' });

    const snap = db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?').get('op-del') as { was_deleted: number; file_path: string; body: string; post_mutation_hash: string | null };
    expect(snap.was_deleted).toBe(0);
    expect(snap.file_path).toBe('to-delete.md');
    expect(snap.body).toBe('content');
    expect(snap.post_mutation_hash).toBeNull();
  });

  it('does not write a snapshot when undoContext is absent', () => {
    const createRes = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'silent-delete.md',
      title: 'Y', types: ['note'], fields: {}, body: 'y',
    });
    executeDeletion(db, writeLock, vaultPath, {
      source: 'tool', node_id: createRes.node_id, file_path: 'silent-delete.md', unlink_file: true,
    });
    const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/capture-pipeline.test.ts`
Expected: FAIL — `executeDeletion` signature doesn't accept a second arg.

- [ ] **Step 3: Add `undoContext` parameter to `executeDeletion`**

Modify `src/pipeline/delete.ts`. Import:

```ts
import type { UndoContext } from './types.js';
```

Extend signature:

```ts
export function executeDeletion(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  deletion: ProposedDeletion,
  undoContext?: UndoContext,
): DeletionResult {
```

Inside the existing `db.transaction(() => { ... })` block, **before** the `DELETE FROM nodes_fts` statement, add the snapshot capture:

```ts
  const txn = db.transaction(() => {
    // ── Undo snapshot capture (pre-delete state) ────────────────────
    if (undoContext) {
      const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
        .get(deletion.node_id) as { file_path: string; title: string | null; body: string | null } | undefined;
      if (nodeRow) {
        const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
          .all(deletion.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);
        const fieldsRows = db.prepare(
          'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
        ).all(deletion.node_id);
        const relRows = db.prepare(
          'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
        ).all(deletion.node_id);

        db.prepare(`
          INSERT INTO undo_snapshots (
            operation_id, node_id, file_path, title, body, types, fields, relationships,
            was_deleted, post_mutation_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          undoContext.operation_id,
          deletion.node_id,
          nodeRow.file_path,
          nodeRow.title,
          nodeRow.body,
          JSON.stringify(typesArr),
          JSON.stringify(fieldsRows),
          JSON.stringify(relRows),
        );
      }
    }

    db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(existing.rowid);
    // ... existing statements unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/capture-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/delete.ts tests/undo/capture-pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): capture undo snapshots in executeDeletion

Mirrors executeMutation's pre-state capture for deletions. Records
was_deleted = 0 (meaning undo will resurrect the node) with full
types/fields/body/relationships state. post_mutation_hash is null
since the file is gone after deletion.
EOF
)"
```

---

## Task 5: Pipeline — `source: 'undo'` gate + caller-provided `node_id` on create

**Goal:** When `source: 'undo'`, the pipeline (a) skips default population, (b) tolerates `REQUIRED_MISSING` (same as normalizer), (c) skips its own snapshot capture (to prevent undo-of-undo recursion), and (d) honors a caller-provided `node_id` when creating (for restoring a deleted node with its original id).

**Files:**
- Modify: `src/pipeline/execute.ts`
- Create: `tests/undo/source-undo-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/undo/source-undo-gate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type Database from 'better-sqlite3';

describe("pipeline source: 'undo'", () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
  });

  afterEach(() => { db.close(); cleanup(); });

  it('does not capture a snapshot when undoContext is provided with source=undo', () => {
    db.prepare("INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, ?, ?, 0, 'active')")
      .run('op-undo', Date.now(), 'undo-operations', 'restore');

    executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: null, file_path: 'restored.md',
      title: 'R', types: ['note'], fields: {}, body: 'r',
    }, undefined, { operation_id: 'op-undo' });

    const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('honors a caller-provided node_id on create (source=undo)', () => {
    const res = executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: 'restored_xyz', file_path: 'restored.md',
      title: 'R', types: ['note'], fields: {}, body: 'r',
    });
    expect(res.node_id).toBe('restored_xyz');
    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get('restored_xyz');
    expect(row).toBeDefined();
  });

  it('tolerates REQUIRED_MISSING when source=undo (restoring pre-schema state)', () => {
    // Seed a global field + required claim
    db.prepare("INSERT INTO global_fields (name, field_type, required) VALUES ('status', 'string', 0)").run();
    db.prepare("INSERT INTO schema_field_claims (schema_name, field, required_override) VALUES ('note', 'status', 1)").run();

    // source='undo' should NOT throw even though the required field is absent
    expect(() => executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: null, file_path: 'x.md',
      title: 'X', types: ['note'], fields: {}, body: '',
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/source-undo-gate.test.ts`
Expected: FAIL — snapshot is captured despite source=undo; caller node_id is overwritten by nanoid; REQUIRED_MISSING throws.

- [ ] **Step 3: Update `executeMutation`**

Modify `src/pipeline/execute.ts`:

**3a.** Extend the tolerated-codes logic (around line 85):

```ts
    if (mutation.source === 'tool' || mutation.source === 'normalizer' || mutation.source === 'propagation' || mutation.source === 'undo') {
      // Tool path: check for blocking errors. Normalizer, propagation, and undo
      // also tolerate REQUIRED_MISSING since they re-render / restore DB state
      // without backfilling defaults.
      const isReRenderPath = mutation.source === 'normalizer' || mutation.source === 'propagation' || mutation.source === 'undo';
      const toleratedCodes = isReRenderPath
        ? new Set(['MERGE_CONFLICT', 'REQUIRED_MISSING'])
        : new Set(['MERGE_CONFLICT']);
      // ...
```

**3b.** Gate snapshot capture on `source !== 'undo'`. Update the snapshot-capture block from Task 3:

```ts
    // ── Undo snapshot capture (pre-mutation state) ──────────────────
    if (undoContext && mutation.source !== 'undo') {
      // ... existing capture logic unchanged
    }
```

Apply the same gate to the post-mutation finalization block.

**3c.** Allow caller-provided `node_id` on create. In Stage 6 around line 261:

```ts
      // Generate node_id for new nodes
      const nodeId = mutation.node_id ?? nanoid();
      const now = Date.now();

      // Capture prior identity BEFORE the UPSERT to detect rename.
      // (create = no prior row; rename = file_path or title changed.)
      const isCreate =
        mutation.node_id === null
        || (mutation.source === 'undo' && !(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(mutation.node_id)));
      const prior = !isCreate
        ? (db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(nodeId) as
            | { file_path: string; title: string | null }
            | undefined)
        : undefined;
```

The `isCreate` adjustment handles the case where undo provides a stable `node_id` but the row doesn't exist (because the original was deleted).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/source-undo-gate.test.ts`
Expected: PASS — all three.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/execute.ts tests/undo/source-undo-gate.test.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): add source='undo' gate

- Skips snapshot capture to prevent recursive undo history.
- Tolerates REQUIRED_MISSING (matches normalizer behavior for
  DB-state re-application).
- Allows callers to supply node_id on create so a resurrected node
  keeps its original id — preserving referential continuity with
  wikilinks and resolver state.
EOF
)"
```

---

## Task 6: `src/undo/operation.ts` — operation CRUD

**Goal:** Thin module for creating, listing, finalizing, and marking-undone `undo_operations` rows + reading their snapshots.

**Files:**
- Create: `src/undo/operation.ts`
- Create: `tests/undo/operation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/undo/operation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';
import {
  createOperation,
  finalizeOperation,
  listOperations,
  getOperation,
  getSnapshots,
  markUndone,
} from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

describe('src/undo/operation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addUndoTables(db);
  });
  afterEach(() => db.close());

  it('createOperation inserts with node_count=0 and status active', () => {
    const id = createOperation(db, { source_tool: 'create-node', description: 'desc' });
    const row = db.prepare('SELECT * FROM undo_operations WHERE operation_id = ?').get(id) as { status: string; node_count: number; timestamp: number };
    expect(row.status).toBe('active');
    expect(row.node_count).toBe(0);
    expect(row.timestamp).toBeGreaterThan(0);
  });

  it('finalizeOperation counts snapshots', () => {
    const id = createOperation(db, { source_tool: 'batch-mutate', description: 'batch' });
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, 1), (?, ?, ?, 0)')
      .run(id, 'n1', 'a.md', id, 'n2', 'b.md');
    finalizeOperation(db, id);
    const row = db.prepare('SELECT node_count FROM undo_operations WHERE operation_id = ?').get(id) as { node_count: number };
    expect(row.node_count).toBe(2);
  });

  it('listOperations returns active operations by default, sorted desc by timestamp', () => {
    const id1 = createOperation(db, { source_tool: 'a', description: 'a' });
    // Ensure distinct timestamps
    db.prepare('UPDATE undo_operations SET timestamp = 1000 WHERE operation_id = ?').run(id1);
    const id2 = createOperation(db, { source_tool: 'b', description: 'b' });
    db.prepare('UPDATE undo_operations SET timestamp = 2000 WHERE operation_id = ?').run(id2);

    const out = listOperations(db, { status: 'active', limit: 10 });
    expect(out.operations.map(o => o.operation_id)).toEqual([id2, id1]);
    expect(out.truncated).toBe(false);
  });

  it('listOperations filters by since/until/source_tool', () => {
    const id1 = createOperation(db, { source_tool: 'create-node', description: '' });
    const id2 = createOperation(db, { source_tool: 'update-node', description: '' });
    db.prepare('UPDATE undo_operations SET timestamp = 500 WHERE operation_id = ?').run(id1);
    db.prepare('UPDATE undo_operations SET timestamp = 1500 WHERE operation_id = ?').run(id2);

    const out = listOperations(db, { since: new Date(1000).toISOString(), source_tool: 'update-node' });
    expect(out.operations.map(o => o.operation_id)).toEqual([id2]);
  });

  it('listOperations truncates at limit and reports truncated=true', () => {
    for (let i = 0; i < 3; i++) createOperation(db, { source_tool: 't', description: String(i) });
    const out = listOperations(db, { limit: 2 });
    expect(out.operations.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it('getSnapshots returns snapshots for an op', () => {
    const id = createOperation(db, { source_tool: 't', description: '' });
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, 1)').run(id, 'n1', 'a.md');
    const snaps = getSnapshots(db, id);
    expect(snaps.length).toBe(1);
    expect(snaps[0].node_id).toBe('n1');
  });

  it('markUndone flips status', () => {
    const id = createOperation(db, { source_tool: 't', description: '' });
    markUndone(db, id);
    const row = db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get(id) as { status: string };
    expect(row.status).toBe('undone');
  });

  it('getOperation returns null for missing id', () => {
    expect(getOperation(db, 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/operation.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `src/undo/operation.ts`**

```ts
// src/undo/operation.ts

import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import type { UndoOperationRow, UndoSnapshotRow } from './types.js';

export interface CreateOperationParams {
  source_tool: string;
  description: string;
}

export function createOperation(
  db: Database.Database,
  params: CreateOperationParams,
): string {
  const operation_id = nanoid();
  db.prepare(`
    INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status)
    VALUES (?, ?, ?, ?, 0, 'active')
  `).run(operation_id, Date.now(), params.source_tool, params.description);
  return operation_id;
}

export function finalizeOperation(db: Database.Database, operation_id: string): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots WHERE operation_id = ?')
    .get(operation_id) as { c: number }).c;
  db.prepare('UPDATE undo_operations SET node_count = ? WHERE operation_id = ?')
    .run(count, operation_id);
}

export function markUndone(db: Database.Database, operation_id: string): void {
  db.prepare("UPDATE undo_operations SET status = 'undone' WHERE operation_id = ?")
    .run(operation_id);
}

export function getOperation(db: Database.Database, operation_id: string): UndoOperationRow | null {
  const row = db.prepare('SELECT * FROM undo_operations WHERE operation_id = ?').get(operation_id) as UndoOperationRow | undefined;
  return row ?? null;
}

export function getSnapshots(db: Database.Database, operation_id: string): UndoSnapshotRow[] {
  return db.prepare('SELECT * FROM undo_snapshots WHERE operation_id = ?')
    .all(operation_id) as UndoSnapshotRow[];
}

export interface ListParams {
  since?: string;           // ISO 8601
  until?: string;           // ISO 8601
  source_tool?: string;
  status?: 'active' | 'undone' | 'expired' | 'all';
  limit?: number;           // default 20, max 100
}

export interface ListResult {
  operations: UndoOperationRow[];
  truncated: boolean;
}

export function listOperations(db: Database.Database, params: ListParams = {}): ListResult {
  const limit = Math.min(params.limit ?? 20, 100);
  const clauses: string[] = [];
  const values: (string | number)[] = [];

  const status = params.status ?? 'active';
  if (status !== 'all') {
    clauses.push('status = ?');
    values.push(status);
  }
  if (params.source_tool) {
    clauses.push('source_tool = ?');
    values.push(params.source_tool);
  }
  if (params.since) {
    clauses.push('timestamp >= ?');
    values.push(new Date(params.since).getTime());
  }
  if (params.until) {
    clauses.push('timestamp <= ?');
    values.push(new Date(params.until).getTime());
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM undo_operations ${where} ORDER BY timestamp DESC LIMIT ?`
  ).all(...values, limit + 1) as UndoOperationRow[];

  return {
    operations: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/operation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/undo/operation.ts tests/undo/operation.test.ts
git commit -m "$(cat <<'EOF'
feat(undo): add operation.ts — operation + snapshot read/write helpers

Thin module for CRUD on undo_operations and undo_snapshots rows:
create/finalize/markUndone/list/get. Used by tool handlers (capture)
and by the restore module (read).
EOF
)"
```

---

## Task 7: `src/undo/restore.ts` — conflict detection + restore orchestration

**Files:**
- Create: `src/undo/restore.ts`
- Create: `tests/undo/restore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/undo/restore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { executeDeletion } from '../../src/pipeline/delete.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createOperation, finalizeOperation, getSnapshots } from '../../src/undo/operation.js';
import { detectConflicts, restoreOperation, restoreMany } from '../../src/undo/restore.js';
import type Database from 'better-sqlite3';

describe('detectConflicts', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
  });
  afterEach(() => { db.close(); cleanup(); });

  it('flags modified_after_operation when current content_hash differs', () => {
    const opId = createOperation(db, { source_tool: 'update-node', description: 'u' });
    // Create node
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'c.md', title: 'C', types: ['note'], fields: {}, body: 'v1',
    });
    // Update capturing snapshot
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'c.md', title: 'C', types: ['note'], fields: {}, body: 'v2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);
    // External drift: mutate the node again (bypasses undo context)
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'c.md', title: 'C', types: ['note'], fields: {}, body: 'v3',
    });

    const snaps = getSnapshots(db, opId);
    const conflicts = detectConflicts(db, vaultPath, opId, snaps, new Set([opId]));
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].reason).toBe('modified_after_operation');
  });

  it('flags path_occupied when a deleted file\'s path is re-used by another node', () => {
    const opId = createOperation(db, { source_tool: 'delete-node', description: 'd' });
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'p.md', title: 'P', types: ['note'], fields: {}, body: '',
    });
    executeDeletion(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'p.md', unlink_file: true,
    }, { operation_id: opId });
    finalizeOperation(db, opId);
    // Create a different node at the same path
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'p.md', title: 'P', types: ['note'], fields: {}, body: 'different',
    });

    const snaps = getSnapshots(db, opId);
    const conflicts = detectConflicts(db, vaultPath, opId, snaps, new Set([opId]));
    expect(conflicts.find(c => c.reason === 'path_occupied')).toBeDefined();
  });

  it('flags superseded_by_later_op when a later active op has a snapshot for the same node', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'q.md', title: 'Q', types: ['note'], fields: {}, body: 'a',
    });
    const opEarly = createOperation(db, { source_tool: 'update-node', description: 'early' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'q.md', title: 'Q', types: ['note'], fields: {}, body: 'b',
    }, undefined, { operation_id: opEarly });
    finalizeOperation(db, opEarly);

    const opLate = createOperation(db, { source_tool: 'update-node', description: 'late' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'q.md', title: 'Q', types: ['note'], fields: {}, body: 'c',
    }, undefined, { operation_id: opLate });
    finalizeOperation(db, opLate);

    // Undoing only the earlier op; the later op is NOT in the set
    const snaps = getSnapshots(db, opEarly);
    const conflicts = detectConflicts(db, vaultPath, opEarly, snaps, new Set([opEarly]));
    expect(conflicts.find(c => c.reason === 'superseded_by_later_op')).toBeDefined();
  });

  it('does not flag superseded_by_later_op when later op is part of same undo call', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'r.md', title: 'R', types: ['note'], fields: {}, body: 'a',
    });
    const opEarly = createOperation(db, { source_tool: 'update-node', description: 'early' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'r.md', title: 'R', types: ['note'], fields: {}, body: 'b',
    }, undefined, { operation_id: opEarly });
    finalizeOperation(db, opEarly);
    const opLate = createOperation(db, { source_tool: 'update-node', description: 'late' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'r.md', title: 'R', types: ['note'], fields: {}, body: 'c',
    }, undefined, { operation_id: opLate });
    finalizeOperation(db, opLate);

    const snaps = getSnapshots(db, opEarly);
    const conflicts = detectConflicts(db, vaultPath, opEarly, snaps, new Set([opEarly, opLate]));
    expect(conflicts.find(c => c.reason === 'superseded_by_later_op')).toBeUndefined();
  });
});

describe('restoreOperation', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
  });
  afterEach(() => { db.close(); cleanup(); });

  it('undoes a create by deleting the node', () => {
    const opId = createOperation(db, { source_tool: 'create-node', description: 'c' });
    const res = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'a.md', title: 'A', types: ['note'], fields: {}, body: 'x',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    const result = restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    expect(result.total_undone).toBe(1);
    const row = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(res.node_id);
    expect(row).toBeUndefined();
  });

  it('undoes an update by restoring pre-state body', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'b.md', title: 'B', types: ['note'], fields: {}, body: 'v1',
    });
    const opId = createOperation(db, { source_tool: 'update-node', description: 'u' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'b.md', title: 'B', types: ['note'], fields: {}, body: 'v2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(r1.node_id) as { body: string };
    expect(row.body).toBe('v1');
  });

  it('undoes a delete by recreating the node with its original id', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'd.md', title: 'D', types: ['note'], fields: {}, body: 'orig',
    });
    const opId = createOperation(db, { source_tool: 'delete-node', description: 'd' });
    executeDeletion(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'd.md', unlink_file: true,
    }, { operation_id: opId });
    finalizeOperation(db, opId);

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT body, id FROM nodes WHERE id = ?').get(r1.node_id) as { body: string; id: string };
    expect(row.id).toBe(r1.node_id);
    expect(row.body).toBe('orig');
  });

  it('dry-run returns zero total_undone but computes conflicts', () => {
    const r1 = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'e.md', title: 'E', types: ['note'], fields: {}, body: 'v1',
    });
    const opId = createOperation(db, { source_tool: 'update-node', description: 'u' });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: r1.node_id, file_path: 'e.md', title: 'E', types: ['note'], fields: {}, body: 'v2',
    }, undefined, { operation_id: opId });
    finalizeOperation(db, opId);

    const result = restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]), { dry_run: true });
    expect(result.total_undone).toBe(0);
    expect(result.operations[0].status).toBe('would_undo');
    const row = db.prepare('SELECT body FROM nodes WHERE id = ?').get(r1.node_id) as { body: string };
    expect(row.body).toBe('v2'); // not changed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/restore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `src/undo/restore.ts`**

```ts
// src/undo/restore.ts
//
// Conflict detection + restore orchestration. See design spec:
// docs/superpowers/specs/2026-04-19-undo-system-design.md

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { executeMutation } from '../pipeline/execute.js';
import { executeDeletion } from '../pipeline/delete.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import type { Conflict, ConflictReason, RestoreResult, UndoSnapshotRow } from './types.js';
import { getSnapshots, getOperation, markUndone } from './operation.js';

export interface RestoreOptions {
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
}

export function detectConflicts(
  db: Database.Database,
  vaultPath: string,
  operation_id: string,
  snapshots: UndoSnapshotRow[],
  operations_in_this_call: Set<string>,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const snap of snapshots) {
    // Skip was_deleted=1 if current node absent (nothing to reconcile)
    const currentNode = db.prepare('SELECT id, body, content_hash FROM nodes WHERE id = ?').get(snap.node_id) as { id: string; body: string | null; content_hash: string | null } | undefined;

    if (snap.was_deleted === 1) {
      // Undoing a create: we intend to delete the node. No conflict checks needed.
      continue;
    }

    // snap.was_deleted === 0 below.

    // Path occupancy: undo-delete path is occupied by a different node
    if (!currentNode) {
      const occupant = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(snap.file_path) as { id: string } | undefined;
      if (occupant && occupant.id !== snap.node_id) {
        conflicts.push(buildConflict(snap, 'path_occupied', { occupant_node_id: occupant.id }));
        continue;
      }
    } else {
      // Post-op drift
      if (snap.post_mutation_hash && currentNode.content_hash && currentNode.content_hash !== snap.post_mutation_hash) {
        conflicts.push(buildConflict(snap, 'modified_after_operation', {}));
      }
    }

    // Superseded by later op (NOT part of this undo call)
    const superseding = db.prepare(`
      SELECT o.operation_id, o.source_tool, o.timestamp
      FROM undo_snapshots s
      JOIN undo_operations o ON o.operation_id = s.operation_id
      WHERE s.node_id = ?
        AND o.status = 'active'
        AND o.timestamp > (SELECT timestamp FROM undo_operations WHERE operation_id = ?)
    `).all(snap.node_id, operation_id) as Array<{ operation_id: string; source_tool: string; timestamp: number }>;

    const outsideSet = superseding.filter(row => !operations_in_this_call.has(row.operation_id));
    if (outsideSet.length > 0) {
      const existing = conflicts.find(c => c.node_id === snap.node_id && c.reason === 'superseded_by_later_op');
      if (!existing) {
        conflicts.push(buildConflict(
          snap,
          'superseded_by_later_op',
          { modified_by: outsideSet.map(r => `${r.source_tool} at ${new Date(r.timestamp).toISOString()}`) },
        ));
      }
    }
  }
  return conflicts;
}

function buildConflict(
  snap: UndoSnapshotRow,
  reason: ConflictReason,
  extra: Record<string, unknown>,
): Conflict {
  const current_summary: Record<string, unknown> = {};
  const would_restore_summary: Record<string, unknown> = {};
  if (snap.title !== null) would_restore_summary.title = snap.title;
  // Summaries are intentionally thin — the caller can fetch full state via get-node.
  return {
    operation_id: snap.operation_id,
    node_id: snap.node_id,
    file_path: snap.file_path,
    reason,
    ...(extra.modified_by ? { modified_by: extra.modified_by as string[] } : {}),
    current_summary,
    would_restore_summary,
  };
}

export function restoreOperation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  operation_id: string,
  operations_in_this_call: Set<string>,
  opts: RestoreOptions = {},
): RestoreResult {
  const op = getOperation(db, operation_id);
  if (!op) {
    return {
      operations: [],
      conflicts: [],
      total_undone: 0,
      total_conflicts: 0,
      total_skipped: 0,
    };
  }

  const snapshots = getSnapshots(db, operation_id);
  const conflicts = detectConflicts(db, vaultPath, operation_id, snapshots, operations_in_this_call);
  const conflictedIds = new Set(conflicts.map(c => c.node_id));

  // Partition resolve_conflicts
  const resolveMap = new Map<string, 'revert' | 'skip'>();
  for (const r of opts.resolve_conflicts ?? []) resolveMap.set(r.node_id, r.action);

  let undone = 0;
  let skipped = 0;

  if (!opts.dry_run) {
    // Creates first, then updates, then deletes (within this op)
    const buckets = { create: [] as UndoSnapshotRow[], update: [] as UndoSnapshotRow[], delete: [] as UndoSnapshotRow[] };
    for (const s of snapshots) {
      const resolution = resolveMap.get(s.node_id);
      if (conflictedIds.has(s.node_id) && resolution !== 'revert') {
        if (resolution === 'skip') skipped++;
        continue;
      }
      const currentNode = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(s.node_id);
      if (s.was_deleted === 1) buckets.delete.push(s);
      else if (!currentNode) buckets.create.push(s);
      else buckets.update.push(s);
    }

    for (const s of buckets.create) { restoreCreate(db, writeLock, vaultPath, s); undone++; }
    for (const s of buckets.update) { restoreUpdate(db, writeLock, vaultPath, s); undone++; }
    for (const s of buckets.delete) { restoreDelete(db, writeLock, vaultPath, s); undone++; }

    markUndone(db, operation_id);
  }

  return {
    operations: [{
      operation_id,
      node_count: op.node_count,
      status: opts.dry_run ? 'would_undo' : 'undone',
    }],
    conflicts,
    total_undone: undone,
    total_conflicts: conflicts.length,
    total_skipped: skipped,
  };
}

/** Restore a deleted node by re-creating it with its original id. */
function restoreCreate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): void {
  if (snap.types === null) return;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields: Record<string, unknown> = {};
  for (const r of fieldsRows) fields[r.field_name] = reconstructValue(r);

  executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    body: snap.body ?? '',
  });
}

/** Restore an updated node to its pre-state. */
function restoreUpdate(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): void {
  if (snap.types === null) return;
  const types = JSON.parse(snap.types) as string[];
  const fieldsRows = JSON.parse(snap.fields ?? '[]') as Array<{
    field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null; value_raw_text: string | null;
  }>;
  const fields: Record<string, unknown> = {};
  for (const r of fieldsRows) fields[r.field_name] = reconstructValue(r);

  executeMutation(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    title: snap.title ?? '',
    types,
    fields,
    body: snap.body ?? '',
  });
}

/** Undo a create by deleting the node that was created. */
function restoreDelete(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  snap: UndoSnapshotRow,
): void {
  executeDeletion(db, writeLock, vaultPath, {
    source: 'undo',
    node_id: snap.node_id,
    file_path: snap.file_path,
    unlink_file: true,
  });
}

export interface RestoreManyParams {
  operation_ids?: string[];
  since?: string;
  until?: string;
  dry_run?: boolean;
  resolve_conflicts?: Array<{ node_id: string; action: 'revert' | 'skip' }>;
}

export function restoreMany(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  params: RestoreManyParams,
): RestoreResult {
  // Resolve target operation_ids
  let ids: string[];
  if (params.operation_ids && params.operation_ids.length > 0) {
    ids = params.operation_ids;
  } else {
    const clauses: string[] = ["status = 'active'"];
    const values: (string | number)[] = [];
    if (params.since) { clauses.push('timestamp >= ?'); values.push(new Date(params.since).getTime()); }
    if (params.until) { clauses.push('timestamp <= ?'); values.push(new Date(params.until).getTime()); }
    const rows = db.prepare(
      `SELECT operation_id FROM undo_operations WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC`
    ).all(...values) as Array<{ operation_id: string }>;
    ids = rows.map(r => r.operation_id);
  }

  // Sort reverse chrono
  const idRows = db.prepare(
    `SELECT operation_id, timestamp FROM undo_operations WHERE operation_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as Array<{ operation_id: string; timestamp: number }>;
  idRows.sort((a, b) => b.timestamp - a.timestamp);

  const inCall = new Set(idRows.map(r => r.operation_id));
  const aggregate: RestoreResult = {
    operations: [],
    conflicts: [],
    total_undone: 0,
    total_conflicts: 0,
    total_skipped: 0,
  };

  for (const row of idRows) {
    const result = restoreOperation(db, writeLock, vaultPath, row.operation_id, inCall, {
      dry_run: params.dry_run,
      resolve_conflicts: params.resolve_conflicts,
    });
    aggregate.operations.push(...result.operations);
    aggregate.conflicts.push(...result.conflicts);
    aggregate.total_undone += result.total_undone;
    aggregate.total_conflicts += result.total_conflicts;
    aggregate.total_skipped += result.total_skipped;
  }

  return aggregate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/restore.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/undo/restore.ts tests/undo/restore.test.ts
git commit -m "$(cat <<'EOF'
feat(undo): add restore.ts — conflict detection and restore orchestration

Detects three conflict reasons (path_occupied, modified_after_operation,
superseded_by_later_op) and orchestrates per-operation restore in
create→update→delete order. Restore routes through executeMutation /
executeDeletion with source='undo'; restoreMany handles the full undo
call by sorting targets reverse-chronologically and aggregating results.
EOF
)"
```

---

## Task 8: `src/undo/cleanup.ts` — retention + orphan sweeps

**Files:**
- Create: `src/undo/cleanup.ts`
- Create: `tests/undo/cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/undo/cleanup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { runUndoCleanup } from '../../src/undo/cleanup.js';
import type Database from 'better-sqlite3';

describe('runUndoCleanup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    addUndoTables(db);
  });
  afterEach(() => db.close());

  function seed(id: string, ageMs: number, status: 'active' | 'undone' | 'expired', nodeCount = 1) {
    db.prepare(`INSERT INTO undo_operations (operation_id, timestamp, source_tool, description, node_count, status) VALUES (?, ?, 'x', '', ?, ?)`)
      .run(id, Date.now() - ageMs, nodeCount, status);
  }

  it('flips active → expired when past retention window', () => {
    seed('old', 25 * 60 * 60 * 1000, 'active');   // 25h old
    seed('fresh', 1 * 60 * 60 * 1000, 'active');  // 1h old
    runUndoCleanup(db, { retentionHours: 24 });

    expect((db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get('old') as { status: string }).status).toBe('expired');
    expect((db.prepare('SELECT status FROM undo_operations WHERE operation_id = ?').get('fresh') as { status: string }).status).toBe('active');
  });

  it('deletes already-expired rows on the next pass', () => {
    seed('gone', 25 * 60 * 60 * 1000, 'expired');
    runUndoCleanup(db, { retentionHours: 24 });
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('gone')).toBeUndefined();
  });

  it('deletes undone rows past retention directly', () => {
    seed('done', 25 * 60 * 60 * 1000, 'undone');
    runUndoCleanup(db, { retentionHours: 24 });
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('done')).toBeUndefined();
  });

  it('deletes orphan rows (node_count=0) older than 60s', () => {
    seed('orphan', 2 * 60 * 1000, 'active', 0); // 2 min old, no snapshots
    seed('recent-orphan', 30 * 1000, 'active', 0); // 30s old — still likely in-flight
    runUndoCleanup(db, { retentionHours: 24 });
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('orphan')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get('recent-orphan')).toBeDefined();
  });

  it('cascades snapshot deletion when an operation is deleted', () => {
    seed('with-snaps', 25 * 60 * 60 * 1000, 'expired', 2);
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, was_deleted) VALUES (?, ?, ?, 1), (?, ?, ?, 1)')
      .run('with-snaps', 'n1', 'a.md', 'with-snaps', 'n2', 'b.md');
    runUndoCleanup(db, { retentionHours: 24 });
    const remain = (db.prepare('SELECT COUNT(*) AS c FROM undo_snapshots').get() as { c: number }).c;
    expect(remain).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/cleanup.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `src/undo/cleanup.ts`**

```ts
// src/undo/cleanup.ts

import type Database from 'better-sqlite3';

export interface CleanupOptions {
  retentionHours?: number;
  orphanGraceMs?: number;   // age below which node_count=0 rows are considered in-flight
}

export function runUndoCleanup(db: Database.Database, opts: CleanupOptions = {}): void {
  const retentionHours = opts.retentionHours ?? 24;
  const orphanGraceMs = opts.orphanGraceMs ?? 60_000;
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const orphanCutoff = Date.now() - orphanGraceMs;

  const run = db.transaction(() => {
    // 1. Delete already-expired active rows.
    db.prepare("DELETE FROM undo_operations WHERE status = 'expired'").run();

    // 2. Flip active rows past retention to expired.
    db.prepare("UPDATE undo_operations SET status = 'expired' WHERE status = 'active' AND timestamp < ?")
      .run(cutoff);

    // 3. Delete undone rows past retention.
    db.prepare("DELETE FROM undo_operations WHERE status = 'undone' AND timestamp < ?")
      .run(cutoff);

    // 4. Delete orphans (node_count=0) older than the grace window.
    db.prepare("DELETE FROM undo_operations WHERE node_count = 0 AND timestamp < ?")
      .run(orphanCutoff);
  });
  run();
}

export function startUndoCleanup(db: Database.Database, opts: CleanupOptions = {}): { stop: () => void } {
  runUndoCleanup(db, opts);
  const intervalMs = 60 * 60 * 1000;
  const handle = setInterval(() => runUndoCleanup(db, opts), intervalMs);
  return { stop: () => clearInterval(handle) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/undo/cleanup.ts tests/undo/cleanup.test.ts
git commit -m "$(cat <<'EOF'
feat(undo): add cleanup.ts — retention and orphan sweeps

runUndoCleanup performs the two-step expiry for active rows, outright
deletion for undone rows past retention, and a 60s-grace orphan sweep
for node_count=0 rows (tool handler failures between createOperation
and the first pipeline call). startUndoCleanup registers an hourly
interval; the caller keeps the stop handle.
EOF
)"
```

---

## Task 9: Wire undo into `create-node`

**Files:**
- Modify: `src/mcp/tools/create-node.ts`
- Create: `tests/undo/integration.test.ts` (scaffolded here; extended in later tool-wiring tasks)

- [ ] **Step 1: Write the failing test**

Create `tests/undo/integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { restoreOperation } from '../../src/undo/restore.js';
import { listOperations } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback(args);
}

describe('undo integration — create-node', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerCreateNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one undo_operations row per create-node call', async () => {
    await callTool(server, 'create-node', { title: 'Hello', types: ['note'], body: 'body' });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('create-node');
    expect(list.operations[0].node_count).toBe(1);
    expect(list.operations[0].description).toContain('Hello');
  });

  it('undoing a create removes the node and its file', async () => {
    const result = await callTool(server, 'create-node', { title: 'Temp', types: ['note'], body: 'b' });
    const payload = JSON.parse(result.content[0].text);
    const nodeId = payload.data.node_id;
    const opId = listOperations(db, {}).operations[0].operation_id;

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
    expect(row).toBeUndefined();
  });

  it('does not capture when dry_run=true', async () => {
    await callTool(server, 'create-node', { title: 'Temp', types: ['note'], body: 'b', dry_run: true });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/undo/integration.test.ts`
Expected: FAIL — `undo_operations` has zero rows after the tool call.

- [ ] **Step 3: Modify `src/mcp/tools/create-node.ts`**

Add imports:

```ts
import { createOperation, finalizeOperation } from '../../undo/operation.js';
```

In the tool callback, immediately before the `executeMutation` call (wrapping the success path), generate an operation id and thread it:

```ts
      // ── Undo operation setup (skipped for dry_run) ──────────────────
      const operation_id = dryRun ? undefined : createOperation(db, {
        source_tool: 'create-node',
        description: `create-node: '${title}'`,
      });

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: null,
          file_path: filePath,
          title,
          types,
          fields,
          body,
        }, syncLogger, operation_id ? { operation_id } : undefined);

        if (operation_id) finalizeOperation(db, operation_id);
        // ... existing success response
```

Make sure if the mutation throws, `finalizeOperation` is still called so orphans are cleaned up promptly. Use `try { ... } finally { if (operation_id) finalizeOperation(db, operation_id); }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/undo/integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/create-node.ts tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(create-node): capture undo operation

Generates an operation_id before each pipeline call and finalizes in
a finally block so orphans are always tagged for cleanup. Skipped for
dry_run — no snapshot captured for previews.
EOF
)"
```

---

## Task 10: Wire undo into `update-node` (single + query mode)

**Files:**
- Modify: `src/mcp/tools/update-node.ts`
- Extend: `tests/undo/integration.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/undo/integration.test.ts`:

```ts
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('undo integration — update-node (single)', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerUpdateNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation per single-node update', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('update-node');
    expect(list.operations[0].node_count).toBe(1);
  });

  it('captures K snapshots for a query-mode update over K matched nodes', async () => {
    writeFileSync(join(vaultPath, 'a.md'), '---\ntypes:\n  - note\n---\n# A\n\nv1\n', 'utf-8');
    writeFileSync(join(vaultPath, 'b.md'), '---\ntypes:\n  - note\n---\n# B\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', {
      query: { types: ['note'] },
      set_fields: { tag: 'x' },
      dry_run: false,
    });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].node_count).toBe(2);
    expect(list.operations[0].description).toContain('query');
  });

  it('does not capture in query-mode dry_run', async () => {
    writeFileSync(join(vaultPath, 'c.md'), '---\ntypes:\n  - note\n---\n# C\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'update-node', {
      query: { types: ['note'] },
      set_fields: { tag: 'x' },
      dry_run: true,
    });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/undo/integration.test.ts -t 'update-node'`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mcp/tools/update-node.ts`**

Add imports:

```ts
import { createOperation, finalizeOperation } from '../../undo/operation.js';
```

**Single-node mode:** find the single-node branch in the tool callback. Before the `executeMutation` call, generate an operation_id (skipping when `dryRun`). Thread as the 6th argument. In a `finally`, call `finalizeOperation`.

**Query mode:** the query-mode branch loops over matched nodes and calls `executeMutation` per node. Generate a **single** operation_id before the loop (when not dry_run), thread it into every pipeline call, and finalize once after the loop.

```ts
      // Query mode:
      const operation_id = dryRun ? undefined : createOperation(db, {
        source_tool: 'update-node',
        description: `update-node query: updated ${matchedIds.length} nodes`,
      });

      try {
        for (const matched of matchedIds) {
          // existing executeMutation call, add 6th arg:
          executeMutation(db, writeLock, vaultPath, {
            // ... existing mutation fields
          }, syncLogger, operation_id ? { operation_id } : undefined);
        }
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
```

Single-node description pattern: `update-node: N fields on 'title'` — synthesize based on which params were set.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/undo/integration.test.ts -t 'update-node'`
Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/update-node.ts tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(update-node): capture undo operation (single + query)

Single mode: one snapshot per call. Query mode: one operation covers
all matched-node mutations, with finalizeOperation in a finally block
after the loop. Dry-run skips capture in both modes.
EOF
)"
```

---

## Task 11: Wire undo into `add-type-to-node` and `remove-type-from-node`

**Files:**
- Modify: `src/mcp/tools/add-type-to-node.ts`
- Modify: `src/mcp/tools/remove-type-from-node.ts`
- Extend: `tests/undo/integration.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/undo/integration.test.ts`:

```ts
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
import { registerRemoveTypeFromNode } from '../../src/mcp/tools/remove-type-from-node.js';

describe('undo integration — add/remove type', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]'), ('task', 'Task', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerAddTypeToNode(server, db, writeLock, vaultPath);
    registerRemoveTypeFromNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures an operation when add-type-to-node succeeds', async () => {
    writeFileSync(join(vaultPath, 'at.md'), '---\ntypes:\n  - note\n---\n# AT\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'add-type-to-node', { file_path: 'at.md', type: 'task' });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('add-type-to-node');
  });

  it('captures an operation when remove-type-from-node succeeds', async () => {
    writeFileSync(join(vaultPath, 'rt.md'), '---\ntypes:\n  - note\n  - task\n---\n# RT\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'remove-type-from-node', { file_path: 'rt.md', type: 'task' });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('remove-type-from-node');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/undo/integration.test.ts -t 'add/remove type'`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mcp/tools/add-type-to-node.ts`**

Add imports:

```ts
import { createOperation, finalizeOperation } from '../../undo/operation.js';
```

In the callback, just before the `executeMutation` call (success path):

```ts
      const operation_id = createOperation(db, {
        source_tool: 'add-type-to-node',
        description: `add-type-to-node: added '${typeName}' to '${title}'`,
      });
      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id,
          file_path,
          title,
          types: newTypes,
          fields,
          body,
        }, syncLogger, { operation_id });
        // existing success response
      } finally {
        finalizeOperation(db, operation_id);
      }
```

- [ ] **Step 4: Modify `src/mcp/tools/remove-type-from-node.ts`**

Same pattern — wrap the `executeMutation` call:

```ts
      const operation_id = createOperation(db, {
        source_tool: 'remove-type-from-node',
        description: `remove-type-from-node: removed '${typeName}' from '${title}'`,
      });
      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          // existing mutation fields
        }, syncLogger, { operation_id });
      } finally {
        finalizeOperation(db, operation_id);
      }
```

- [ ] **Step 5: Run to verify passing**

Run: `npx vitest run tests/undo/integration.test.ts -t 'add/remove type'`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/add-type-to-node.ts src/mcp/tools/remove-type-from-node.ts tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(type-ops): capture undo operations for add/remove type

Single snapshot per call, description names the type and node.
EOF
)"
```

---

## Task 12: Wire undo into `rename-node` — shared id across N+1 calls

**Files:**
- Modify: `src/mcp/tools/rename-node.ts`
- Extend: `tests/undo/integration.test.ts`

- [ ] **Step 1: Append failing test**

```ts
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';

describe('undo integration — rename-node', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerRenameNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation with 1 + N snapshots for a rename that touches N refs', async () => {
    writeFileSync(join(vaultPath, 'target.md'), '---\ntypes:\n  - note\n---\n# Target\n', 'utf-8');
    writeFileSync(join(vaultPath, 'refA.md'), '---\ntypes:\n  - note\n---\n# RefA\n\nSee [[Target]]\n', 'utf-8');
    writeFileSync(join(vaultPath, 'refB.md'), '---\ntypes:\n  - note\n---\n# RefB\n\nAlso [[Target]]\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'rename-node', { title: 'Target', new_title: 'Renamed' });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    // 1 for the rename itself + N for each actually-updated referencing node (N ≥ 1)
    expect(list.operations[0].node_count).toBeGreaterThanOrEqual(2);
    expect(list.operations[0].description).toContain('references');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/undo/integration.test.ts -t 'rename-node'`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mcp/tools/rename-node.ts`**

Import:

```ts
import { createOperation, finalizeOperation } from '../../undo/operation.js';
```

Inside `executeRename` (the function that performs the rename + ref updates), accept an `undoContext` from the caller, thread it into **every** `executeMutation` call (the rename itself + the per-referencing-node update):

```ts
export function executeRename(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  params: ExecuteRenameParams,
  syncLogger?: SyncLogger,
  undoContext?: { operation_id: string },
): { refsUpdated: number } {
  // ... existing pre-work ...

  executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: node.node_id,
    file_path: newFilePath,
    title: newTitle,
    types,
    fields,
    body,
  }, syncLogger, undoContext);

  let refsUpdated = 0;
  for (const refNodeId of referencingNodeIds) {
    // ... existing body rewrite logic ...
    if (changed) {
      executeMutation(db, writeLock, vaultPath, {
        // existing ref mutation
      }, syncLogger, undoContext);
      refsUpdated++;
    }
  }
  return { refsUpdated };
}
```

In the MCP tool callback (the outer function `registerRenameNode`), generate the `operation_id` before calling `executeRename`, pass it, and finalize afterward:

```ts
      const operation_id = createOperation(db, {
        source_tool: 'rename-node',
        description: `rename-node: '${currentTitle}' → '${newTitle}' (references pending)`,
      });
      let refsUpdated = 0;
      try {
        refsUpdated = executeRename(db, writeLock, vaultPath, {
          // existing params
        }, syncLogger, { operation_id }).refsUpdated;
        // Update description once we know refsUpdated
        db.prepare('UPDATE undo_operations SET description = ? WHERE operation_id = ?')
          .run(`rename-node: '${currentTitle}' → '${newTitle}' (${refsUpdated} references rewritten)`, operation_id);
      } finally {
        finalizeOperation(db, operation_id);
      }
```

- [ ] **Step 4: Verify passing**

Run: `npx vitest run tests/undo/integration.test.ts -t 'rename-node'`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/rename-node.ts tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(rename-node): capture undo operation across rename + ref rewrites

One operation_id is shared across the rename's single target-node call
and every per-referencing-node update. Description is patched after
the fact with the actual refs-rewritten count.
EOF
)"
```

---

## Task 13: Wire undo into `delete-node`

**Files:**
- Modify: `src/mcp/tools/delete-node.ts`
- Extend: `tests/undo/integration.test.ts`

- [ ] **Step 1: Append failing test**

```ts
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';

describe('undo integration — delete-node', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerDeleteNode(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation capturing pre-delete state', async () => {
    writeFileSync(join(vaultPath, 'del.md'), '---\ntypes:\n  - note\n---\n# Del\n\noriginal\n', 'utf-8');
    fullIndex(vaultPath, db);

    await callTool(server, 'delete-node', { file_path: 'del.md', confirm: true });

    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].source_tool).toBe('delete-node');
    expect(list.operations[0].node_count).toBe(1);
  });

  it('restoring the operation re-creates the node with its original id', async () => {
    writeFileSync(join(vaultPath, 'res.md'), '---\ntypes:\n  - note\n---\n# Res\n\nhello\n', 'utf-8');
    fullIndex(vaultPath, db);
    const originalId = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get('res.md') as { id: string }).id;

    await callTool(server, 'delete-node', { file_path: 'res.md', confirm: true });
    const opId = listOperations(db, {}).operations[0].operation_id;

    restoreOperation(db, writeLock, vaultPath, opId, new Set([opId]));
    const row = db.prepare('SELECT id FROM nodes WHERE id = ?').get(originalId) as { id: string } | undefined;
    expect(row?.id).toBe(originalId);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/undo/integration.test.ts -t 'delete-node'`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mcp/tools/delete-node.ts`**

Import:

```ts
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { executeDeletion } from '../../pipeline/delete.js';
```

Just before the tool's call to `executeDeletion`, generate the operation id and thread it:

```ts
      const operation_id = createOperation(db, {
        source_tool: 'delete-node',
        description: `delete-node: '${title}'`,
      });
      try {
        const result = executeDeletion(db, writeLock, vaultPath, {
          source: 'tool',
          node_id,
          file_path,
          unlink_file: true,
        }, { operation_id });
        // existing success response
      } finally {
        finalizeOperation(db, operation_id);
      }
```

- [ ] **Step 4: Verify passing**

Run: `npx vitest run tests/undo/integration.test.ts -t 'delete-node'`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/delete-node.ts tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(delete-node): capture undo operation

Single snapshot, full pre-delete state captured inside the deletion
transaction so restoreOperation can resurrect the node with its
original id.
EOF
)"
```

---

## Task 14: Wire undo into `batch-mutate` — shared id across K sub-ops

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts`
- Extend: `tests/undo/integration.test.ts`

- [ ] **Step 1: Append failing test**

```ts
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

describe('undo integration — batch-mutate', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerBatchMutate(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('captures one operation with K snapshots for K sub-ops', async () => {
    await callTool(server, 'batch-mutate', {
      operations: [
        { op: 'create', params: { title: 'B1', types: ['note'], body: 'b1' } },
        { op: 'create', params: { title: 'B2', types: ['note'], body: 'b2' } },
        { op: 'create', params: { title: 'B3', types: ['note'], body: 'b3' } },
      ],
    });
    const list = listOperations(db, {});
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].node_count).toBe(3);
    expect(list.operations[0].description).toContain('batch-mutate');
  });

  it('no operation row remains when the batch rolls back', async () => {
    await callTool(server, 'batch-mutate', {
      operations: [
        { op: 'create', params: { title: 'Ok', types: ['note'], body: 'ok' } },
        { op: 'create', params: { title: 'Ok', types: ['note'], body: 'dup' } }, // duplicate path triggers rollback
      ],
    });
    const list = listOperations(db, {});
    // Either: zero ops (orphan swept eventually) OR one op with node_count=0
    // The immediate state after tool return should have no *active-with-snapshots* op
    const withSnaps = list.operations.filter(o => o.node_count > 0);
    expect(withSnaps.length).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/undo/integration.test.ts -t 'batch-mutate'`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mcp/tools/batch-mutate.ts`**

Import:

```ts
import { createOperation, finalizeOperation } from '../../undo/operation.js';
```

In the tool callback, generate `operation_id` once before the big outer `db.transaction` and thread it into every `executeMutation` / `executeDeletion` call inside the loop. Finalize in a `finally` outside the transaction:

```ts
      const operation_id = createOperation(db, {
        source_tool: 'batch-mutate',
        description: `batch-mutate: ${params.operations.length} ops (${countKinds(params.operations)})`,
      });
      let didThrow = false;

      try {
        const txn = db.transaction(() => {
          // ... existing loop. Each executeMutation/executeDeletion call gets
          //     , syncLogger, { operation_id }
          //     or , { operation_id }
          //     appended as the last arg.
        });
        txn();
      } catch (err) {
        didThrow = true;
        throw err;
      } finally {
        finalizeOperation(db, operation_id);
      }
```

Helper:

```ts
function countKinds(ops: Array<{ op: string }>): string {
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}
```

If the batch rolls back, the outer `db.transaction` rollback removes all snapshot inserts. The `undo_operations` row (inserted in `createOperation` in its own earlier txn) remains with `node_count = 0`. `finalizeOperation` counts snapshots (zero) and updates `node_count`. The orphan sweep deletes it on the next hourly pass.

- [ ] **Step 4: Verify passing**

Run: `npx vitest run tests/undo/integration.test.ts -t 'batch-mutate'`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(batch-mutate): capture single undo operation across K sub-ops

One operation_id is shared across every sub-op's pipeline call. On
rollback, snapshots roll back with the outer transaction and the
orphan undo_operations row (node_count=0) is cleaned up by the
hourly sweep.
EOF
)"
```

---

## Task 15: MCP tool — `list-undo-history`

**Files:**
- Create: `src/mcp/tools/list-undo-history.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/mcp/list-undo-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/list-undo-history.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerListUndoHistory } from '../../src/mcp/tools/list-undo-history.js';
import { createOperation } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback(args);
}

describe('list-undo-history', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createTestDb();
    addUndoTables(db);
    server = new McpServer({ name: 'test', version: '0' });
    registerListUndoHistory(server, db);
  });
  afterEach(() => db.close());

  it('returns active operations sorted desc by timestamp', async () => {
    const id1 = createOperation(db, { source_tool: 'create-node', description: 'a' });
    db.prepare('UPDATE undo_operations SET timestamp = 1000 WHERE operation_id = ?').run(id1);
    const id2 = createOperation(db, { source_tool: 'update-node', description: 'b' });
    db.prepare('UPDATE undo_operations SET timestamp = 2000 WHERE operation_id = ?').run(id2);

    const result = await callTool(server, 'list-undo-history', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.operations.map((o: { operation_id: string }) => o.operation_id)).toEqual([id2, id1]);
  });

  it('filters by source_tool', async () => {
    createOperation(db, { source_tool: 'create-node', description: '' });
    createOperation(db, { source_tool: 'update-node', description: '' });

    const result = await callTool(server, 'list-undo-history', { source_tool: 'update-node' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.operations.length).toBe(1);
    expect(payload.data.operations[0].source_tool).toBe('update-node');
  });

  it('reports truncated when results exceed limit', async () => {
    for (let i = 0; i < 3; i++) createOperation(db, { source_tool: 't', description: String(i) });
    const result = await callTool(server, 'list-undo-history', { limit: 2 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.operations.length).toBe(2);
    expect(payload.data.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/mcp/list-undo-history.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Create `src/mcp/tools/list-undo-history.ts`**

```ts
// src/mcp/tools/list-undo-history.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok } from './errors.js';
import { listOperations } from '../../undo/operation.js';

const paramsShape = {
  since: z.string().optional(),
  until: z.string().optional(),
  source_tool: z.string().optional(),
  status: z.enum(['active', 'undone', 'expired', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export function registerListUndoHistory(
  server: McpServer,
  db: Database.Database,
): void {
  server.tool(
    'list-undo-history',
    'List recent undo operations. Each operation corresponds to one user-intent tool call (create-node, update-node, rename-node, delete-node, batch-mutate, etc.) and can be reversed via undo-operations. Filters by time window, source tool, and status. Pure read — no side effects.',
    paramsShape,
    async (params) => {
      const result = listOperations(db, {
        since: params.since,
        until: params.until,
        source_tool: params.source_tool,
        status: params.status,
        limit: params.limit,
      });
      return ok({
        operations: result.operations.map(o => ({
          operation_id: o.operation_id,
          timestamp: new Date(o.timestamp).toISOString(),
          source_tool: o.source_tool,
          description: o.description,
          node_count: o.node_count,
          status: o.status,
        })),
        truncated: result.truncated,
      });
    },
  );
}
```

- [ ] **Step 4: Register in `src/mcp/server.ts`**

Find the other `register*` imports and calls; add:

```ts
import { registerListUndoHistory } from './tools/list-undo-history.js';
// ...
registerListUndoHistory(server, db);
```

- [ ] **Step 5: Verify passing**

Run: `npx vitest run tests/mcp/list-undo-history.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/list-undo-history.ts src/mcp/server.ts tests/mcp/list-undo-history.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add list-undo-history tool

Read-only tool returning recent operations filtered by time, source,
and status. Limit capped at 100; truncated flag is set when more
results exist beyond the limit.
EOF
)"
```

---

## Task 16: MCP tool — `undo-operations`

**Files:**
- Create: `src/mcp/tools/undo-operations.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/mcp/undo-operations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/undo-operations.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { listOperations } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback(args);
}

describe('undo-operations', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerCreateNode(server, db, writeLock, vaultPath);
    registerUpdateNode(server, db, writeLock, vaultPath);
    registerUndoOperations(server, db, writeLock, vaultPath);
  });

  afterEach(() => { db.close(); cleanup(); });

  it('INVALID_PARAMS when neither operation_ids nor since provided', async () => {
    const result = await callTool(server, 'undo-operations', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('INVALID_PARAMS when both operation_ids and since provided', async () => {
    const result = await callTool(server, 'undo-operations', { operation_ids: ['x'], since: new Date().toISOString() });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('INVALID_PARAMS');
  });

  it('OPERATION_NOT_FOUND when id missing', async () => {
    const result = await callTool(server, 'undo-operations', { operation_ids: ['nope'], dry_run: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe('OPERATION_NOT_FOUND');
  });

  it('dry-run returns zero total_undone but reports operations', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    const result = await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.total_undone).toBe(0);
    expect(payload.data.operations[0].status).toBe('would_undo');
  });

  it('executes undo when dry_run=false and reflects restored state', async () => {
    writeFileSync(join(vaultPath, 'u.md'), '---\ntypes:\n  - note\n---\n# U\n\nv1\n', 'utf-8');
    fullIndex(vaultPath, db);
    await callTool(server, 'update-node', { file_path: 'u.md', set_body: 'v2' });
    const opId = listOperations(db, {}).operations[0].operation_id;

    const result = await callTool(server, 'undo-operations', { operation_ids: [opId], dry_run: false });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.total_undone).toBe(1);
    const body = (db.prepare('SELECT body FROM nodes WHERE file_path = ?').get('u.md') as { body: string }).body;
    expect(body).toBe('v1');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/mcp/undo-operations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/mcp/tools/undo-operations.ts`**

```ts
// src/mcp/tools/undo-operations.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { getOperation } from '../../undo/operation.js';
import { restoreMany } from '../../undo/restore.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const paramsShape = {
  operation_ids: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  dry_run: z.boolean().optional(),
  resolve_conflicts: z.array(z.object({
    node_id: z.string(),
    action: z.enum(['revert', 'skip']),
  })).optional(),
};

export function registerUndoOperations(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): void {
  server.tool(
    'undo-operations',
    'Undo one or more previously captured operations. Provide either operation_ids (explicit list, cherry-pickable) or since/until (time range). dry_run defaults to true — preview conflicts before committing. When conflicts arise (modified_after_operation, path_occupied, superseded_by_later_op) they are returned for user mediation; call back with resolve_conflicts to revert or skip per node.',
    paramsShape,
    async (params) => {
      const hasIds = Array.isArray(params.operation_ids) && params.operation_ids.length > 0;
      const hasRange = Boolean(params.since || params.until);

      if (!hasIds && !hasRange) {
        return fail('INVALID_PARAMS', 'Provide either operation_ids or since/until.');
      }
      if (hasIds && hasRange) {
        return fail('INVALID_PARAMS', 'Provide exactly one of operation_ids or since/until, not both.');
      }

      // Existence check for operation_ids
      if (hasIds) {
        for (const id of params.operation_ids!) {
          const op = getOperation(db, id);
          if (!op || op.status !== 'active') {
            return fail('OPERATION_NOT_FOUND', `Operation '${id}' is not active or does not exist.`, { operation_id: id });
          }
        }
      }

      const dry_run = params.dry_run ?? true;
      const result = restoreMany(db, writeLock, vaultPath, {
        operation_ids: params.operation_ids,
        since: params.since,
        until: params.until,
        dry_run,
        resolve_conflicts: params.resolve_conflicts,
      });

      return ok({
        dry_run,
        operations: result.operations,
        conflicts: result.conflicts,
        total_undone: result.total_undone,
        total_conflicts: result.total_conflicts,
        total_skipped: result.total_skipped,
      });
    },
  );
}
```

- [ ] **Step 4: Register in `src/mcp/server.ts`**

```ts
import { registerUndoOperations } from './tools/undo-operations.js';
// ...
registerUndoOperations(server, db, writeLock, vaultPath);
```

- [ ] **Step 5: Verify passing**

Run: `npx vitest run tests/mcp/undo-operations.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/undo-operations.ts src/mcp/server.ts tests/mcp/undo-operations.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add undo-operations tool

Wraps restoreMany with MCP-envelope error handling. INVALID_PARAMS
for missing/both target groups; OPERATION_NOT_FOUND for unknown or
non-active ids. dry_run defaults to true.
EOF
)"
```

---

## Task 17: `vault-stats` — add `undo` aggregate

**Files:**
- Modify: `src/mcp/tools/vault-stats.ts`
- Create: `tests/mcp/vault-stats-undo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/vault-stats-undo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { createOperation } from '../../src/undo/operation.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback(args);
}

describe('vault-stats — undo aggregate', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    server = new McpServer({ name: 'test', version: '0' });
    registerVaultStats(server, db, vaultPath);
  });
  afterEach(() => { db.close(); cleanup(); });

  it('includes undo.active_operations and undo.total_snapshot_bytes', async () => {
    const id = createOperation(db, { source_tool: 'create-node', description: 'x' });
    db.prepare('INSERT INTO undo_snapshots (operation_id, node_id, file_path, body, was_deleted) VALUES (?, ?, ?, ?, 0)')
      .run(id, 'n1', 'a.md', 'hello world');

    const result = await callTool(server, 'vault-stats', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.undo).toBeDefined();
    expect(payload.data.undo.active_operations).toBe(1);
    expect(payload.data.undo.total_snapshot_bytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/mcp/vault-stats-undo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify `src/mcp/tools/vault-stats.ts`**

Read the existing file and locate the `data` object assembled for the response. Add:

```ts
      const undoActive = (db.prepare("SELECT COUNT(*) AS c FROM undo_operations WHERE status = 'active'").get() as { c: number }).c;
      // Approx byte size: sum of LENGTH on body + JSON columns.
      const undoBytes = (db.prepare(`
        SELECT COALESCE(SUM(
          IFNULL(LENGTH(body), 0) +
          IFNULL(LENGTH(types), 0) +
          IFNULL(LENGTH(fields), 0) +
          IFNULL(LENGTH(relationships), 0)
        ), 0) AS b FROM undo_snapshots
      `).get() as { b: number }).b;

      // ... in the data object:
      undo: {
        active_operations: undoActive,
        total_snapshot_bytes: undoBytes,
      },
```

- [ ] **Step 4: Verify passing**

Run: `npx vitest run tests/mcp/vault-stats-undo.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/vault-stats.ts tests/mcp/vault-stats-undo.test.ts
git commit -m "$(cat <<'EOF'
feat(vault-stats): add undo aggregate

Reports count of active operations and approximate snapshot storage
bytes. Answers design-doc open Q1.
EOF
)"
```

---

## Task 18: Startup — cleanup interval

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Locate the reconciler start site**

Near the end of `src/index.ts`, after the reconciler is started, add:

```ts
import { startUndoCleanup } from './undo/cleanup.js';

// ... after reconciler/normalizer setup:
const undoCleanup = startUndoCleanup(db);
```

Ensure `undoCleanup.stop()` is called alongside other stop handles in any process-shutdown hook that already exists.

- [ ] **Step 2: Smoke check**

Run: `npm run build`
Expected: PASS.

Run: `npm test`
Expected: PASS — existing tests unaffected.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(startup): register hourly undo cleanup sweep

Runs an immediate pass at boot then re-runs every hour. The handle is
kept alongside other long-running sync subsystems for clean shutdown.
EOF
)"
```

---

## Task 19: End-to-end integration — capture → list → undo → conflict resolution

**Files:**
- Extend: `tests/undo/integration.test.ts` with a final "full flow" describe block.

- [ ] **Step 1: Append end-to-end test**

```ts
describe('undo end-to-end', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    addUndoTables(db);
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('note', 'Note', '[]')").run();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerCreateNode(server, db, writeLock, vaultPath);
    registerUpdateNode(server, db, writeLock, vaultPath);
    registerDeleteNode(server, db, writeLock, vaultPath);
    registerListUndoHistory(server, db);
    registerUndoOperations(server, db, writeLock, vaultPath);
  });
  afterEach(() => { db.close(); cleanup(); });

  it('create → update → delete, then undo all three in reverse order', async () => {
    // 1. create
    const createResp = await callTool(server, 'create-node', { title: 'E2E', types: ['note'], body: 'v1' });
    const nodeId = JSON.parse(createResp.content[0].text).data.node_id;

    // 2. update
    await callTool(server, 'update-node', { node_id: nodeId, set_body: 'v2' });

    // 3. delete
    await callTool(server, 'delete-node', { node_id: nodeId, confirm: true });

    // Verify three operations in history
    const listResp = await callTool(server, 'list-undo-history', {});
    const list = JSON.parse(listResp.content[0].text).data;
    expect(list.operations.length).toBe(3);

    // Undo all via time range
    const undoResp = await callTool(server, 'undo-operations', {
      since: new Date(0).toISOString(),
      dry_run: false,
    });
    const undoPayload = JSON.parse(undoResp.content[0].text).data;
    expect(undoPayload.total_undone).toBe(3);

    // Node is gone (undoing the create removes it)
    const row = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(nodeId);
    expect(row).toBeUndefined();
  });

  it('surfaces modified_after_operation conflict and resolves via revert', async () => {
    const createResp = await callTool(server, 'create-node', { title: 'Conf', types: ['note'], body: 'v1' });
    const nodeId = JSON.parse(createResp.content[0].text).data.node_id;
    await callTool(server, 'update-node', { node_id: nodeId, set_body: 'v2' });
    const opToUndo = JSON.parse((await callTool(server, 'list-undo-history', {})).content[0].text).data.operations.find(
      (o: { source_tool: string }) => o.source_tool === 'update-node',
    ).operation_id;

    // External drift
    await callTool(server, 'update-node', { node_id: nodeId, set_body: 'v3' });

    // Try to undo — should report conflict
    const dryResp = await callTool(server, 'undo-operations', { operation_ids: [opToUndo], dry_run: true });
    const dryPayload = JSON.parse(dryResp.content[0].text).data;
    expect(dryPayload.conflicts.length).toBeGreaterThan(0);
    expect(dryPayload.conflicts[0].reason).toBe('modified_after_operation');

    // Resolve via revert
    const resolveResp = await callTool(server, 'undo-operations', {
      operation_ids: [opToUndo],
      dry_run: false,
      resolve_conflicts: [{ node_id: nodeId, action: 'revert' }],
    });
    const resolvePayload = JSON.parse(resolveResp.content[0].text).data;
    expect(resolvePayload.total_undone).toBe(1);

    const body = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(nodeId) as { body: string }).body;
    expect(body).toBe('v1');
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/undo/integration.test.ts -t 'end-to-end'`
Expected: PASS.

- [ ] **Step 3: Run full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/undo/integration.test.ts
git commit -m "$(cat <<'EOF'
test(undo): add end-to-end capture → list → undo coverage

Exercises the full tool-user loop: three mutations, list, undo all via
time range, verify restored DB state. Separately exercises conflict
detection and resolve_conflicts: action='revert' recovery.
EOF
)"
```

---

## Self-review checklist

After completing all 19 tasks:

- [ ] **Spec coverage:** Every spec section has at least one task:
  - Scope (node-level tools): Tasks 9–14.
  - Data model: Task 1.
  - Snapshot capture (pipeline): Tasks 3, 4.
  - Undo execution (source 'undo' + pipeline routing): Tasks 5, 7.
  - Conflict detection (three reasons): Task 7.
  - MCP surface (list-undo-history, undo-operations): Tasks 15, 16.
  - vault-stats extension: Task 17.
  - Retention + two-step expiry + orphan sweep: Task 8.
  - Startup wiring: Task 18.
  - Operation identity + description synthesis: Tasks 9–14.
  - Node-id preservation on delete-undo: Task 5 + Task 7 + Task 13 integration.
  - Observability (`undo-restore` edits_log entry): **GAP** — not explicitly tested. The pipeline's existing edits_log write produces entries for source='undo' naturally, but we should verify. Add a line to Task 19's end-to-end assertion that checks at least one `undo-restore` event_type entry exists after an undo. (Inline fix: append to the end-to-end test a query for `SELECT event_type, details FROM edits_log WHERE event_type LIKE '%undo%'` and assert presence.)
- [ ] **Placeholder scan:** No TBD / TODO / "handle edge cases" left in the plan.
- [ ] **Type consistency:** `UndoContext`, `UndoOperationRow`, `UndoSnapshotRow`, `Conflict`, `RestoreResult` are used with the same shape across all tasks. `operation_id` is always a string. `source_tool` is a free-form string (not an enum) — matches `listOperations` filter.
- [ ] **Build + full suite green:** `npm run build && npm test` green after every task.

**Final spec-coverage fix (pre-execution):** extend Task 19's end-to-end test with an `edits_log` assertion so the observability hook is covered — append:

```ts
    const undoEvents = db.prepare("SELECT event_type FROM edits_log WHERE event_type LIKE '%undo%' OR details LIKE '%undo%'").all();
    expect(undoEvents.length).toBeGreaterThan(0);
```

If the pipeline's existing `edits_log` entry shape doesn't naturally include an `operation_id` or `undo` marker when `source: 'undo'`, the assertion will fail and expose the gap; fix by adding an `undo-restore` event_type case in `src/pipeline/edits-log.ts` (small addition) as a side task before the test passes.
