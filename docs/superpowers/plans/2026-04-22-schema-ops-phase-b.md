# Schema Ops Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the safety-default asymmetry between schema ops and node ops by adding dry-run (B1), a `confirm_large_change` gate on orphan-producing updates (B2), and undo parity for `update-schema`/`create-schema`/`delete-schema` (B3). Also fold in non-blocking Phase A polish (T1/T3/T7 + test cleanup).

**Architecture:** Two new source files — `src/schema/preview.ts` (SAVEPOINT-based preview workhorse) and `src/undo/schema-snapshot.ts` (capture/restore helpers). `propagateSchemaChange()` gains a `{ preview, operation_id }` options object so a single code path serves dry-run, the confirm gate's pre-commit check, and undo-threaded commits. A new `undo_schema_snapshots` table + `undo_operations.schema_count` column carries schema-level undo state; the undo restore path gains a schema-first pass before nodes. All schema-ops tool handlers wrap their commit block in a single outer `db.transaction` so a mid-propagation throw rolls back DB state atomically.

**Tech Stack:** TypeScript (ESM), better-sqlite3 (SAVEPOINT for preview, nested transactions for atomicity), zod for tool input, vitest for tests. ESM `.js` import extensions throughout (per CLAUDE.md).

**Source spec:** `docs/superpowers/specs/2026-04-21-schema-ops-phase-b-design.md`. Read that before touching code — it explains the "why" behind every decision below.

**Branch:** `phase-b/schema-ops` off `main`.

---

## File Structure

**New files:**

- `src/schema/preview.ts` — `previewSchemaChange()` running the real mutation inside a SQLite SAVEPOINT; always rolls back.
- `src/undo/schema-snapshot.ts` — `captureSchemaSnapshot()` + `restoreSchemaSnapshot()` for schema-level undo.
- `tests/schema/preview.test.ts` — unit tests for `previewSchemaChange` (valid, claim-invalid, propagation-invalid, display-only-no-diff).
- `tests/undo/schema-snapshot.test.ts` — unit tests for capture/restore roundtrip (update/create-new/delete).

**Modified files:**

- `src/schema/propagate.ts` — add `{ preview, operation_id }` options; collect orphan field names per-field in preview mode; defensive groups-filter (Phase A polish T1); thread `operation_id` to `executeMutation` when non-preview.
- `src/mcp/tools/update-schema.ts` — add `dry_run` + `confirm_large_change` params; wrap commit in a single `db.transaction`; thread `operation_id` into propagation; render schema YAML outside the transaction.
- `src/mcp/tools/create-schema.ts` — wrap in `createOperation` + `captureSchemaSnapshot({was_new:true})` + existing create + `finalizeOperation`.
- `src/mcp/tools/delete-schema.ts` — wrap in `createOperation` + `captureSchemaSnapshot({was_deleted:true})` + existing delete + `finalizeOperation`.
- `src/undo/restore.ts` — add a schema-first restore pass to `restoreOperation` (runs before the existing node-snapshot buckets).
- `src/undo/types.ts` — add `schema_count` to `UndoOperationRow`.
- `src/mcp/tools/list-undo-history.ts` — surface `schema_count` in the response.
- `src/mcp/tools/errors.ts` — add `CONFIRMATION_REQUIRED` to `ErrorCode`.
- `src/db/migrate.ts` — new `addSchemaUndoSnapshots()` migration.
- `src/db/schema.ts` — include `schema_count` column on `undo_operations` and new `undo_schema_snapshots` table for fresh DBs.
- `src/index.ts` — call new migration at startup.
- `tests/helpers/db.ts` — call new migration in the test DB helper.
- `tests/mcp/update-schema.test.ts` — dry-run, confirm-gate, undo-roundtrip integration tests.
- `tests/mcp/list-undo-history.test.ts` — assert `schema_count` surfaces.
- `tests/schema/propagation.test.ts` — add rollback-verification test (Phase A polish T3) and preview-mode behaviour tests.
- `tests/mcp/batch-mutate-directory.test.ts` — add regression test documenting the deliberate breaking change (Phase A polish T7); replace `any` casts with structural types.

---

## Task 0: Phase A polish backlog

These are non-blocking fixes from Phase A reviews. They ride along at the start of the Phase B branch so the foundation is clean before new work lands.

**Files:**
- Modify: `src/schema/propagate.ts`
- Modify: `tests/schema/propagation.test.ts`
- Modify: `tests/mcp/batch-mutate-directory.test.ts`

- [ ] **Step 1: T1 — defensive groups filter in `propagate.ts`**

`SchemaValidationError` can today be constructed with `groups: []` if the only per-node issues are codes that `ISSUE_TO_REASON` maps to `null` (e.g. a sole `INTERNAL_CONSISTENCY`). The current gate checks `perNodeIssues.length` but should check the post-grouping array.

Open `src/schema/propagate.ts`. Replace the tail of the `runLoop` transaction body at the bottom of `propagateSchemaChange` — the existing lines read:

```typescript
    if (perNodeIssues.length > 0) {
      throw new SchemaValidationError(groupValidationIssues(perNodeIssues));
    }
```

Replace with:

```typescript
    if (perNodeIssues.length > 0) {
      const groups = groupValidationIssues(perNodeIssues);
      if (groups.length > 0) {
        throw new SchemaValidationError(groups);
      }
    }
```

- [ ] **Step 2: T3 — add rollback-verification test**

Append a new describe block to `tests/schema/propagation.test.ts`:

```typescript
import { SchemaValidationError } from '../../src/schema/errors.js';

describe('propagateSchemaChange — transaction rollback on validation failure', () => {
  it('rolls back all field-defaulted + fields-orphaned rows when any node fails validation', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal', required: true });

    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status' }],
    });

    // 3 valid nodes (status='open') + 1 invalid node (status='bogus')
    createNode({ file_path: 'n1.md', title: 'N1', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'n2.md', title: 'N2', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'n3.md', title: 'N3', types: ['task'], fields: { status: 'done' } });
    createNode({ file_path: 'n4.md', title: 'N4', types: ['task'], fields: { status: 'bogus' } });

    // Update schema: drop status claim, add required+default priority claim.
    // Valid nodes would orphan `status` and default `priority`; invalid node rejects on `status`.
    const oldClaims = [{ field: 'status', sort_order: 1000 }];
    const newClaims = [{ field: 'priority', sort_order: 1000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    expect(() => propagateSchemaChange(db, writeLock, vaultPath, 'task', diff))
      .toThrow(SchemaValidationError);

    // Because the throw inside db.transaction rolls back, NO edits_log rows for
    // fields-orphaned or field-defaulted should persist.
    const leakedOrphan = db.prepare(
      "SELECT COUNT(*) AS c FROM edits_log WHERE event_type = 'fields-orphaned'"
    ).get() as { c: number };
    expect(leakedOrphan.c).toBe(0);

    const leakedDefault = db.prepare(
      "SELECT COUNT(*) AS c FROM edits_log WHERE event_type = 'field-defaulted'"
    ).get() as { c: number };
    expect(leakedDefault.c).toBe(0);
  });
});
```

- [ ] **Step 3: T7 — regression test for default_directory breaking change + any-cast cleanup**

Open `tests/mcp/batch-mutate-directory.test.ts`. Replace the current `parseResult` helper with a structurally typed version:

```typescript
interface BatchResponse {
  ok: boolean;
  data?: {
    results: Array<{ file_path: string; node_id?: string }>;
    [k: string]: unknown;
  };
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity?: string }>;
}

function parseResult(result: unknown): BatchResponse {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as BatchResponse;
}
```

Drop any remaining `any` annotations in this file. Where the code previously read e.g. `(result.warnings as Array<...>).find(...)`, it can now use `result.warnings.find(...)` directly.

At the end of the describe block, add the regression test:

```typescript
  it('regression: legacy path-only call on a type with default_directory is BATCH_FAILED with routes-to message', async () => {
    // Documents the Phase A3 breaking change — old callers that supplied
    // `path` (or `directory`) that conflicts with a schema's default_directory
    // now get BATCH_FAILED instead of silently landing the file in the
    // caller-specified directory.
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'LegacyOnNote', types: ['note'], path: 'Elsewhere' } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('BATCH_FAILED');
    expect(result.error?.message).toMatch(/routes to "Notes\/"/);
    const deprecation = result.warnings.find(w => w.code === 'DEPRECATED_PARAM');
    expect(deprecation).toBeDefined();
  });
```

- [ ] **Step 4: Verify the polish tasks**

Run:

```bash
npm test -- tests/schema/propagation.test.ts tests/mcp/batch-mutate-directory.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit the polish**

```bash
git checkout -b phase-b/schema-ops
git add src/schema/propagate.ts tests/schema/propagation.test.ts tests/mcp/batch-mutate-directory.test.ts
git commit -m "chore(phase-a-polish): defensive groups filter, rollback test, batch-mutate regression test"
```

---

## Task 1: B1.1 — `propagateSchemaChange` preview + operation_id options

**Rationale.** The preview workhorse and the undo-threading both flow through the same propagation function. Introducing both options up-front means B1.2 and B3.3 can wire them in cleanly without refactoring the signature again.

**Files:**
- Modify: `src/schema/propagate.ts`
- Test: `tests/schema/propagation.test.ts`

- [ ] **Step 1: Write the failing preview-mode test**

Append to `tests/schema/propagation.test.ts`:

```typescript
describe('propagateSchemaChange — preview mode', () => {
  it('preview=true: no file writes, no throw on validation failure; returns validation_groups + orphaned_field_names', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    createNode({ file_path: 'n1.md', title: 'N1', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'n2.md', title: 'N2', types: ['task'], fields: { status: 'open' } });

    // Record file mtimes before propagation preview.
    const mtimeBefore = statSync(join(vaultPath, 'n1.md')).mtimeMs;

    const oldClaims = [{ field: 'status', sort_order: 1000 }];
    const newClaims: Array<{ field: string; sort_order?: number }> = [];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff, undefined, { preview: true });

    // fields_orphaned counts the number of field values, not nodes.
    expect(result.fields_orphaned).toBe(2);
    expect(result.orphaned_field_names).toEqual([{ field: 'status', count: 2 }]);
    expect(result.validation_groups).toEqual([]);

    // No files were rewritten.
    const mtimeAfter = statSync(join(vaultPath, 'n1.md')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    expect(result.nodes_affected).toBe(2);
  });

  it('preview=true: validation failures flow into validation_groups instead of throwing', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true, default_value: 'normal' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    createNode({ file_path: 'ok.md', title: 'OK', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'bad.md', title: 'Bad', types: ['task'], fields: { status: 'bogus' } });

    const oldClaims = [{ field: 'status', sort_order: 1000 }];
    const newClaims = [{ field: 'priority', sort_order: 1000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff, undefined, { preview: true });

    expect(result.validation_groups).toBeDefined();
    expect(result.validation_groups!.length).toBeGreaterThan(0);
    const enumGroup = result.validation_groups!.find(g => g.reason === 'ENUM_INVALID');
    expect(enumGroup?.field).toBe('status');
    expect(enumGroup?.count).toBe(1);

    // Orphan names still surface regardless of validation outcome.
    expect(result.orphaned_field_names).toEqual([{ field: 'status', count: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema/propagation.test.ts -t "preview mode"`
Expected: FAIL — `preview` option not recognised / result missing `validation_groups`.

- [ ] **Step 3: Extend the propagation function signature and behaviour**

Open `src/schema/propagate.ts`. Apply these changes:

Extend the `PropagationResult` interface at the top:

```typescript
export interface PropagationResult {
  nodes_affected: number;
  nodes_rerendered: number;
  defaults_populated: number;
  fields_orphaned: number;
  // Preview-mode augmentations (present iff opts.preview was true):
  validation_groups?: import('./errors.js').ValidationGroup[];
  orphaned_field_names?: Array<{ field: string; count: number }>;
}

export interface PropagationOptions {
  preview?: boolean;
  operation_id?: string;
}
```

Change the `propagateSchemaChange` signature to accept a 7th `opts?` argument:

```typescript
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  syncLogger?: SyncLogger,
  opts: PropagationOptions = {},
): PropagationResult {
```

Inside the function, before the `runLoop` transaction:

```typescript
  const preview = opts.preview === true;
  const orphanCounts = new Map<string, number>();
```

Inside the per-node loop, replace the `rerenderNodeThroughPipeline` call with a preview-aware variant:

```typescript
      let pipelineResult: { node_id: string; file_path: string; file_written: boolean } | null = null;
      try {
        pipelineResult = rerenderNodeThroughPipeline(
          db, writeLock, vaultPath, nodeId, adoptionDefaults, syncLogger, state,
          { dbOnly: preview, operation_id: opts.operation_id },
        );
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          for (const issue of err.validation.issues) {
            perNodeIssues.push({
              node_id: nodeId,
              title: state.title,
              field: issue.field,
              code: issue.code,
              value: state.currentFields[issue.field],
            });
          }
          continue;
        }
        throw err;
      }
      if (!pipelineResult) continue;
```

Update `rerenderNodeThroughPipeline` signature + body to accept the new options and skip file writes in preview mode. Replace the existing function with:

```typescript
function rerenderNodeThroughPipeline(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  adoptionDefaults: Record<string, unknown>,
  syncLogger: SyncLogger | undefined,
  preLoaded?: LoadedNodeState,
  opts?: { dbOnly?: boolean; operation_id?: string },
): { node_id: string; file_path: string; file_written: boolean } | null {
  const state = preLoaded ?? loadNodeState(db, nodeId);
  if (!state) return null;

  const mergedFields: Record<string, unknown> = { ...state.currentFields };
  for (const [field, value] of Object.entries(adoptionDefaults)) {
    if (!(field in mergedFields)) {
      mergedFields[field] = value;
    }
  }

  const undoCtx = opts?.operation_id ? { operation_id: opts.operation_id } : undefined;

  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'propagation',
    node_id: nodeId,
    file_path: state.file_path,
    title: state.title,
    types: state.types,
    fields: mergedFields,
    body: state.body,
    raw_field_texts: state.rawFieldTexts,
    db_only: opts?.dbOnly === true,
  }, syncLogger, undoCtx);

  return {
    node_id: result.node_id,
    file_path: result.file_path,
    file_written: result.file_written,
  };
}
```

In the per-node orphan-counting section, skip the edits_log insert when previewing and count per-field orphans:

```typescript
      const orphanedInThisNode = diff.removed.filter(f => f in state.currentFields);
      if (orphanedInThisNode.length > 0) {
        if (!preview) {
          insertLog.run(nodeId, now, 'fields-orphaned', JSON.stringify({
            source: 'propagation',
            trigger,
            orphaned_fields: orphanedInThisNode,
            node_types: state.types,
          }));
        }
        result.fields_orphaned += orphanedInThisNode.length;
        if (preview) {
          for (const f of orphanedInThisNode) {
            orphanCounts.set(f, (orphanCounts.get(f) ?? 0) + 1);
          }
        }
      }
```

Apply the same preview guard around the `field-defaulted` log insert above — still bump `result.defaults_populated++`, but skip the `insertLog.run(...)` call.

At the end of `runLoop`, replace the error-throw section:

```typescript
    if (perNodeIssues.length > 0) {
      const groups = groupValidationIssues(perNodeIssues);
      if (groups.length > 0) {
        if (preview) {
          result.validation_groups = groups;
        } else {
          throw new SchemaValidationError(groups);
        }
      }
    }
```

After `runLoop();`, populate the preview-only fields before returning:

```typescript
  if (preview) {
    result.validation_groups = result.validation_groups ?? [];
    result.orphaned_field_names = Array.from(orphanCounts.entries())
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
  }

  return result;
}
```

**Note on `UndoContext` interface.** `src/pipeline/types.ts::UndoContext` already has the `{ operation_id: string }` shape and `executeMutation` already accepts `undoContext` as its 5th arg — no pipeline changes needed here.

**Note on write-lock in preview.** `executeMutation` acquires the write-lock only around its file write; with `db_only: true` the file write is skipped, so preview effectively does not hold the lock for I/O. Behaviour matches the spec's "do NOT acquire the write-lock" intent; no further change required. Verify by reading the write-lock call sites in `src/pipeline/execute.ts` during implementation.

- [ ] **Step 4: Run preview tests to verify they pass**

Run: `npx vitest run tests/schema/propagation.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/schema/propagate.ts tests/schema/propagation.test.ts
git commit -m "feat(schema): propagateSchemaChange gains preview + operation_id options"
```

---

## Task 2: B1.2 — `previewSchemaChange()` with SAVEPOINT rollback

**Rationale.** Single workhorse used by dry-run, the confirm gate, and non-dry-run pre-commit checks. SAVEPOINT ensures the real code path runs (no preview/commit drift) without persisting any state.

**Files:**
- Create: `src/schema/preview.ts`
- Test: `tests/schema/preview.test.ts`

- [ ] **Step 1: Write the failing preview-function tests**

Create `tests/schema/preview.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { previewSchemaChange } from '../../src/schema/preview.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
});

afterEach(() => { db.close(); cleanup(); });

function createNode(overrides: { file_path: string; title: string; types: string[]; fields?: Record<string, unknown> }) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: overrides.file_path,
    title: overrides.title,
    types: overrides.types,
    fields: overrides.fields ?? {},
    body: '',
  });
}

describe('previewSchemaChange — SAVEPOINT-based preview', () => {
  it('ok:true — claim added, propagation succeeds, DB unchanged after preview', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const claimsBefore = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'status' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims_added).toEqual(['status']);
    expect(result.claims_removed).toEqual([]);
    expect(result.claims_modified).toEqual([]);
    expect(result.propagation.nodes_affected).toBe(1);
    expect(result.propagation.defaults_populated).toBe(1);
    expect(result.propagation.fields_orphaned).toBe(0);
    expect(result.orphaned_field_names).toEqual([]);

    const claimsAfter = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claimsAfter).toEqual(claimsBefore);
  });

  it('ok:false with claim-level failure (UNKNOWN_FIELD) — groups populated, DB unchanged', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'nonexistent' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.groups.some(g => g.reason === 'UNKNOWN_FIELD')).toBe(true);

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toEqual([]);
  });

  it('ok:false with propagation-level failure (ENUM_INVALID)', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'ok.md', title: 'OK', types: ['task'], fields: { status: 'open' } });

    // Simulate a stale value that bypassed validation in a prior state.
    db.prepare('UPDATE node_fields SET value_text = ? WHERE field_name = ?').run('garbage', 'status');

    createGlobalField(db, { name: 'priority', field_type: 'string', required: true, default_value: 'normal' });

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'status' }, { field: 'priority' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.groups.some(g => g.reason === 'ENUM_INVALID')).toBe(true);
    expect(result.claims_added).toContain('priority');
  });

  it('display-only update — no claim diff, propagation a no-op', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [], display_name: 'Task' });

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      display_name: 'Tasks',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims_added).toEqual([]);
    expect(result.claims_removed).toEqual([]);
    expect(result.claims_modified).toEqual([]);
    expect(result.propagation.nodes_affected).toBe(0);
  });

  it('does not write files to disk when propagation would re-render them', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const mtimeBefore = statSync(join(vaultPath, 'a.md')).mtimeMs;

    previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'status' }],
    });

    const mtimeAfter = statSync(join(vaultPath, 'a.md')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/schema/preview.test.ts`
Expected: FAIL with "Cannot find module '../../src/schema/preview.js'".

- [ ] **Step 3: Create `src/schema/preview.ts`**

Uses `db.prepare('SAVEPOINT x').run()` etc. rather than raw `exec()` — SAVEPOINT statements are single-statement DDL that better-sqlite3 accepts via prepare+run.

```typescript
// src/schema/preview.ts
//
// SAVEPOINT-based preview of an update-schema call. Runs the real mutation
// pipeline inside a savepoint and unconditionally rolls back. Used by
// update-schema's dry_run path, by the confirm_large_change gate to compute
// orphan counts pre-commit, and as the single source of the preview response
// shape.

import type Database from 'better-sqlite3';
import { getSchemaDefinition, updateSchemaDefinition, type UpdateSchemaInput } from './crud.js';
import { diffClaims, propagateSchemaChange } from './propagate.js';
import { SchemaValidationError, type ValidationGroup } from './errors.js';
import type { WriteLockManager } from '../sync/write-lock.js';

export interface SchemaPreviewBaseFields {
  claims_added: string[];
  claims_removed: string[];
  claims_modified: string[];
  orphaned_field_names: Array<{ field: string; count: number }>;
  propagation: {
    nodes_affected: number;
    nodes_rerendered: number;
    defaults_populated: number;
    fields_orphaned: number;
  };
}

export type SchemaPreviewResult =
  | ({ ok: true } & SchemaPreviewBaseFields)
  | ({ ok: false; groups: ValidationGroup[] } & SchemaPreviewBaseFields);

export function previewSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  proposedUpdate: UpdateSchemaInput,
): SchemaPreviewResult {
  const existing = getSchemaDefinition(db, schemaName);
  if (!existing) {
    throw new Error(`Schema '${schemaName}' not found`);
  }

  // Read current claims (pre-savepoint) for diff computation and orphan counting.
  const oldClaims = readCurrentClaims(db, schemaName);

  const base: SchemaPreviewBaseFields = {
    claims_added: [],
    claims_removed: [],
    claims_modified: [],
    orphaned_field_names: [],
    propagation: { nodes_affected: 0, nodes_rerendered: 0, defaults_populated: 0, fields_orphaned: 0 },
  };

  if (proposedUpdate.field_claims !== undefined) {
    const newClaimsShape = proposedUpdate.field_claims.map(c => ({
      field: c.field,
      sort_order: c.sort_order,
      label: c.label,
      description: c.description,
      required: c.required ?? null,
      default_value: c.default_value ?? null,
      enum_values_override: c.enum_values_override ?? null,
    }));
    const diff = diffClaims(oldClaims, newClaimsShape);
    base.claims_added = diff.added;
    base.claims_removed = diff.removed;
    base.claims_modified = diff.changed;
  }

  db.prepare('SAVEPOINT preview_schema_change').run();
  let result: SchemaPreviewResult;
  try {
    try {
      updateSchemaDefinition(db, schemaName, proposedUpdate);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        result = { ok: false, groups: err.groups, ...base };
        return result;
      }
      throw err;
    }

    let propagationGroups: ValidationGroup[] = [];
    if (proposedUpdate.field_claims !== undefined) {
      const newClaims = readCurrentClaims(db, schemaName);
      const diff = diffClaims(oldClaims, newClaims);
      const prop = propagateSchemaChange(db, writeLock, vaultPath, schemaName, diff, undefined, { preview: true });
      base.propagation = {
        nodes_affected: prop.nodes_affected,
        nodes_rerendered: prop.nodes_rerendered,
        defaults_populated: prop.defaults_populated,
        fields_orphaned: prop.fields_orphaned,
      };
      base.orphaned_field_names = prop.orphaned_field_names ?? [];
      propagationGroups = prop.validation_groups ?? [];
    }

    if (propagationGroups.length > 0) {
      result = { ok: false, groups: propagationGroups, ...base };
    } else {
      result = { ok: true, ...base };
    }
    return result;
  } finally {
    db.prepare('ROLLBACK TO SAVEPOINT preview_schema_change').run();
    db.prepare('RELEASE SAVEPOINT preview_schema_change').run();
  }
}

interface ClaimRow {
  field: string;
  sort_order: number;
  label: string | null;
  description: string | null;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
}

function readCurrentClaims(db: Database.Database, schemaName: string): Array<{
  field: string;
  sort_order?: number;
  label?: string;
  description?: string;
  required?: boolean | null;
  default_value?: unknown;
  enum_values_override?: string[] | null;
}> {
  const rows = db.prepare(
    'SELECT field, sort_order, label, description, required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ?',
  ).all(schemaName) as ClaimRow[];
  return rows.map(r => ({
    field: r.field,
    sort_order: r.sort_order,
    label: r.label ?? undefined,
    description: r.description ?? undefined,
    required: r.required_override !== null ? r.required_override === 1 : null,
    default_value: r.default_value_overridden === 1
      ? (r.default_value_override !== null ? JSON.parse(r.default_value_override) : null)
      : undefined,
    enum_values_override: r.enum_values_override !== null ? JSON.parse(r.enum_values_override) : null,
  }));
}
```

- [ ] **Step 4: Run preview tests to verify they pass**

Run: `npx vitest run tests/schema/preview.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full test suite to verify no regressions**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/schema/preview.ts tests/schema/preview.test.ts
git commit -m "feat(schema): add previewSchemaChange with SAVEPOINT rollback"
```

---

## Task 3: B1.3 — wire `dry_run` param into `update-schema`

**Files:**
- Modify: `src/mcp/tools/update-schema.ts`
- Test: `tests/mcp/update-schema.test.ts`

- [ ] **Step 1: Write the failing dry_run integration test**

If `tests/mcp/update-schema.test.ts` already exists from Phase A, append to it. If not, create it with this header:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { createTempVault } from '../helpers/vault.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: unknown[];
}

function parseResult(result: unknown): Envelope {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Envelope;
}

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler() {
  let h: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake = {
    tool: (_n: string, _d: string, _s: unknown, fn: (...a: unknown[]) => unknown) => {
      h = (args) => fn(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateSchema(fake, db, { writeLock, vaultPath, syncLogger });
  return h!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);
  handler = captureHandler();
});

afterEach(() => { db.close(); cleanup(); });

function createNode(opts: { file_path: string; title: string; types: string[]; fields?: Record<string, unknown> }) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: opts.file_path,
    title: opts.title,
    types: opts.types,
    fields: opts.fields ?? {},
    body: '',
  });
}
```

Append this describe block:

```typescript
describe('update-schema dry_run', () => {
  it('dry_run=true returns preview data without committing the change', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect((result.data as { claims_added: string[] }).claims_added).toEqual(['status']);
    expect((result.data as { propagation: { defaults_populated: number } }).propagation.defaults_populated).toBe(1);

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toEqual([]);
  });

  it('dry_run=true with claim-level failure returns ok:false with groups in error.details', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'nonexistent' }],
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    const details = result.error?.details as { groups: Array<{ reason: string }>; claims_added: string[] };
    expect(details.groups.some(g => g.reason === 'UNKNOWN_FIELD')).toBe(true);
    expect(details.claims_added).toEqual(['nonexistent']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/update-schema.test.ts -t "dry_run"`
Expected: FAIL — `dry_run` rejected by zod or no preview data in response.

- [ ] **Step 3: Wire `dry_run` into the handler**

Replace the full contents of `src/mcp/tools/update-schema.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { updateSchemaDefinition } from '../../schema/crud.js';
import { diffClaims, propagateSchemaChange } from '../../schema/propagate.js';
import { renderSchemaFile } from '../../schema/render.js';
import { previewSchemaChange } from '../../schema/preview.js';
import { SchemaValidationError } from '../../schema/errors.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
  default_value_overridden: z.boolean().optional().describe('Set true when default_value key is present, even if null'),
  enum_values_override: z.array(z.string()).optional().describe('Per-type enum values (replaces global for this type)'),
});

const TOOL_DESC =
  'Updates an existing schema definition. If field_claims is provided, it replaces all existing claims. ' +
  'When dry_run=true, returns a preview (claim diff, orphan counts, propagation numbers) without committing — ' +
  'a response with ok:false on a dry-run means the change WOULD BE REJECTED if committed, not that the dry-run itself failed; ' +
  'preview data is then in error.details alongside groups.';

export function registerUpdateSchema(
  server: McpServer,
  db: Database.Database,
  ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger },
): void {
  server.tool(
    'update-schema',
    TOOL_DESC,
    {
      name: z.string().describe('Schema name to update'),
      display_name: z.string().optional(),
      icon: z.string().optional(),
      filename_template: z.string().optional(),
      default_directory: z.string().optional(),
      field_claims: z.array(fieldClaimSchema).optional(),
      metadata: z.unknown().optional(),
      dry_run: z.boolean().optional().describe('Preview the effect without committing'),
    },
    async ({ name, dry_run, ...rest }) => {
      if (!ctx?.writeLock || !ctx?.vaultPath) {
        return fail('INTERNAL_ERROR', 'update-schema requires write context (writeLock + vaultPath).');
      }
      const writeLock = ctx.writeLock;
      const vaultPath = ctx.vaultPath;

      // Preview first — no operation created, no side effects.
      let preview;
      try {
        preview = previewSchemaChange(db, writeLock, vaultPath, name, rest);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }

      if (!preview.ok) {
        return fail(
          'VALIDATION_FAILED',
          `Schema change rejected: ${preview.groups.length} validation group(s).`,
          { details: {
              groups: preview.groups,
              claims_added: preview.claims_added,
              claims_removed: preview.claims_removed,
              claims_modified: preview.claims_modified,
              orphaned_field_names: preview.orphaned_field_names,
              propagation: preview.propagation,
            } },
        );
      }

      if (dry_run) {
        return ok({
          would_commit: true,
          claims_added: preview.claims_added,
          claims_removed: preview.claims_removed,
          claims_modified: preview.claims_modified,
          orphaned_field_names: preview.orphaned_field_names,
          propagation: preview.propagation,
        });
      }

      // Live-commit path. (B2 confirm gate lands here; B3 undo threading in Task 8.)
      try {
        const result = updateSchemaDefinition(db, name, rest);

        let propagation;
        if (rest.field_claims) {
          // Reuse the diff computed by the preview — preview ran against the
          // same pre-update state as our commit path.
          const preDiff = {
            added: preview.claims_added,
            removed: preview.claims_removed,
            changed: preview.claims_modified,
          };
          propagation = propagateSchemaChange(db, writeLock, vaultPath, name, preDiff, ctx.syncLogger);
        }

        renderSchemaFile(db, vaultPath, name);
        return ok({ ...result, propagation });
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
```

**Note on claim diff in the commit path.** Task 8 will rewrite this section to wrap commit in `db.transaction` and recompute the diff from current DB state inside the transaction. For now (B1 only), the pragmatic shortcut is to reuse the preview-computed diff via `preview.claims_added/removed/modified`. This is safe because nothing can mutate the schema between preview and commit in a single handler call.

- [ ] **Step 4: Run the integration tests**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: all pass.

- [ ] **Step 5: Run full suite + build**

Run: `npm test && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): add dry_run param via previewSchemaChange"
```

---

## Task 4: B2 — `CONFIRMATION_REQUIRED` error code + `confirm_large_change` gate

**Files:**
- Modify: `src/mcp/tools/errors.ts`
- Modify: `src/mcp/tools/update-schema.ts`
- Test: `tests/mcp/update-schema.test.ts`

- [ ] **Step 1: Write the failing confirm-gate tests**

Append to `tests/mcp/update-schema.test.ts`:

```typescript
describe('update-schema confirm_large_change gate', () => {
  beforeEach(() => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
  });

  it('orphan-producing change without confirm_large_change returns CONFIRMATION_REQUIRED', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    const details = result.error?.details as {
      orphaned_field_names: Array<{ field: string; count: number }>;
      propagation: { fields_orphaned: number };
      claims_removed: string[];
    };
    expect(details.orphaned_field_names).toEqual([{ field: 'status', count: 1 }]);
    expect(details.claims_removed).toEqual(['status']);
    expect(details.propagation.fields_orphaned).toBe(1);

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toHaveLength(1);
  });

  it('same change with confirm_large_change=true succeeds', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      confirm_large_change: true,
    }));

    expect(result.ok).toBe(true);
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toHaveLength(0);
  });

  it('change with zero orphans succeeds without confirm_large_change', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }],
    }));

    expect(result.ok).toBe(true);
  });

  it('dry_run with orphans does not trigger the gate — preview returns normally', async () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: { status: 'done' } });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [],
      dry_run: true,
    }));

    expect(result.ok).toBe(true);
    expect((result.data as { propagation: { fields_orphaned: number } }).propagation.fields_orphaned).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mcp/update-schema.test.ts -t "confirm_large_change"`
Expected: FAIL — gate not enforced.

- [ ] **Step 3: Add the error code**

In `src/mcp/tools/errors.ts`, extend the union:

```typescript
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
  | 'CONFIRMATION_REQUIRED';
```

- [ ] **Step 4: Wire the gate into `update-schema.ts`**

In `src/mcp/tools/update-schema.ts`, add `confirm_large_change` to the zod shape (next to `dry_run`):

```typescript
      dry_run: z.boolean().optional().describe('Preview the effect without committing'),
      confirm_large_change: z.boolean().optional().describe('Acknowledge the change would orphan field values. Required when propagation would orphan any field.'),
```

Update the handler signature:

```typescript
    async ({ name, dry_run, confirm_large_change, ...rest }) => {
```

Between the `if (!preview.ok)` block and the `if (dry_run)` block, insert the gate:

```typescript
      if (preview.propagation.fields_orphaned > 0 && !confirm_large_change) {
        const fieldCount = preview.orphaned_field_names.length;
        return fail(
          'CONFIRMATION_REQUIRED',
          `This change would orphan ${preview.propagation.fields_orphaned} field value(s) across ${fieldCount} field(s). Set confirm_large_change: true to proceed, or run with dry_run: true to preview.`,
          { details: {
              orphaned_field_names: preview.orphaned_field_names,
              propagation: preview.propagation,
              claims_removed: preview.claims_removed,
            } },
        );
      }
```

Order: preview → gate → dry_run return → commit. `dry_run` stays gate-free (the spec is explicit: dry-run runs the preview without requiring confirmation).

Update the `TOOL_DESC` literal:

```typescript
const TOOL_DESC =
  'Updates an existing schema definition. If field_claims is provided, it replaces all existing claims. ' +
  'When dry_run=true, returns a preview (claim diff, orphan counts, propagation numbers) without committing — ' +
  'a response with ok:false on a dry-run means the change WOULD BE REJECTED if committed, not that the dry-run itself failed; ' +
  'preview data is then in error.details alongside groups. ' +
  'When a non-dry-run commit would orphan any field value(s), the response is ok:false with error.code CONFIRMATION_REQUIRED; ' +
  're-call with confirm_large_change:true to proceed.';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/errors.ts src/mcp/tools/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): add CONFIRMATION_REQUIRED gate for orphan-producing commits"
```

---

## Task 5: B3.1 — migration for `undo_schema_snapshots` + `schema_count` column

**Files:**
- Modify: `src/db/migrate.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/index.ts`
- Modify: `tests/helpers/db.ts`

- [ ] **Step 1: Add the migration function**

Append to `src/db/migrate.ts`:

```typescript
/**
 * Migration: add undo_schema_snapshots table + undo_operations.schema_count
 * column (2026-04-22, Phase B3).
 *
 * Captures pre-mutation schema state so update-schema/create-schema/delete-schema
 * can participate in the undo system. schema_count surfaces via list-undo-history
 * alongside node_count.
 *
 * Per the migration-ordering rule, CREATE INDEX on the new column lives in this
 * migration, not in createSchema's CREATE TABLE IF NOT EXISTS path.
 *
 * Idempotent — safe to run on a database that already has the new schema.
 */
export function addSchemaUndoSnapshots(db: Database.Database): void {
  const run = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS undo_schema_snapshots (
        operation_id       TEXT NOT NULL,
        schema_name        TEXT NOT NULL,
        was_new            INTEGER NOT NULL DEFAULT 0,
        was_deleted        INTEGER NOT NULL DEFAULT 0,
        display_name       TEXT,
        icon               TEXT,
        filename_template  TEXT,
        default_directory  TEXT,
        metadata           TEXT,
        field_claims       TEXT,
        PRIMARY KEY (operation_id, schema_name),
        FOREIGN KEY (operation_id) REFERENCES undo_operations(operation_id) ON DELETE CASCADE
      )
    `).run();

    const cols = (db.prepare('PRAGMA table_info(undo_operations)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('schema_count')) {
      db.prepare('ALTER TABLE undo_operations ADD COLUMN schema_count INTEGER NOT NULL DEFAULT 0').run();
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_undo_schema_snapshots_op ON undo_schema_snapshots(operation_id)').run();
  });
  run();
}
```

- [ ] **Step 2: Mirror the table + column in `src/db/schema.ts`**

Open `src/db/schema.ts`. Search for `undo_operations` — if the fresh-DB `CREATE TABLE` for `undo_operations` lives there, extend it with `schema_count INTEGER NOT NULL DEFAULT 0` and add the `undo_schema_snapshots` table in the same block. If `undo_operations` is only created inside `addUndoTables` (and not in `createSchema`), no change to `schema.ts` is needed — the migration is the source of truth for the undo tables. Check this before editing.

- [ ] **Step 3: Wire the migration into startup**

In `src/index.ts`, update the import line to include `addSchemaUndoSnapshots`:

```typescript
import {
  upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6,
  addCreatedAt, upgradeForOverrides, ensureMetaTable, upgradeForResolvedTargetId,
  addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots,
} from './db/migrate.js';
```

Add the call after `addNodeTypesSortOrder(db)`:

```typescript
addNodeTypesSortOrder(db);
addSchemaUndoSnapshots(db);
```

- [ ] **Step 4: Update the test DB helper**

In `tests/helpers/db.ts`:

```typescript
import { addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots } from '../../src/db/migrate.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  addSchemaUndoSnapshots(db);
  return db;
}
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test && npm run build`
Expected: all pass. If any integration test was creating its own in-memory DB without going through `createTestDb`, update it to call `addSchemaUndoSnapshots` — grep the codebase for `addUndoTables(` to find the call sites.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrate.ts src/db/schema.ts src/index.ts tests/helpers/db.ts
git commit -m "feat(db): undo_schema_snapshots table + undo_operations.schema_count"
```

---

## Task 6: B3.2 — `captureSchemaSnapshot` + `restoreSchemaSnapshot`

**Files:**
- Create: `src/undo/schema-snapshot.ts`
- Test: `tests/undo/schema-snapshot.test.ts`

- [ ] **Step 1: Write the failing capture/restore tests**

Create `tests/undo/schema-snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition, deleteSchemaDefinition, getSchemaDefinition } from '../../src/schema/crud.js';
import { createOperation } from '../../src/undo/operation.js';
import { captureSchemaSnapshot, restoreSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
import { renderSchemaFile, deleteSchemaFile } from '../../src/schema/render.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
});

afterEach(() => { db.close(); cleanup(); });

describe('captureSchemaSnapshot + restoreSchemaSnapshot — update path', () => {
  it('restores schema row + claims to pre-update state', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createGlobalField(db, { name: 'priority', field_type: 'string' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status' }],
      display_name: 'Task',
    });

    const op = createOperation(db, { source_tool: 'update-schema', description: 'u' });
    captureSchemaSnapshot(db, op, 'task');

    updateSchemaDefinition(db, 'task', {
      display_name: 'Tasks!',
      field_claims: [{ field: 'priority' }],
    });

    expect(getSchemaDefinition(db, 'task')!.display_name).toBe('Tasks!');
    const claimsBeforeRestore = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claimsBeforeRestore.map(c => c.field)).toEqual(['priority']);

    restoreSchemaSnapshot(db, vaultPath, op, 'task');

    expect(getSchemaDefinition(db, 'task')!.display_name).toBe('Task');
    const claimsAfter = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claimsAfter.map(c => c.field)).toEqual(['status']);
  });
});

describe('captureSchemaSnapshot + restoreSchemaSnapshot — was_new path', () => {
  it('restore deletes a newly created schema (and its yaml file)', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });

    const op = createOperation(db, { source_tool: 'create-schema', description: 'c' });
    captureSchemaSnapshot(db, op, 'task', { was_new: true });

    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    renderSchemaFile(db, vaultPath, 'task');
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(true);

    restoreSchemaSnapshot(db, vaultPath, op, 'task');

    expect(getSchemaDefinition(db, 'task')).toBeNull();
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(false);
  });
});

describe('captureSchemaSnapshot + restoreSchemaSnapshot — was_deleted path', () => {
  it('restore re-inserts a deleted schema + claims + yaml file', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }], display_name: 'Task' });

    const op = createOperation(db, { source_tool: 'delete-schema', description: 'd' });
    captureSchemaSnapshot(db, op, 'task', { was_deleted: true });

    deleteSchemaDefinition(db, 'task');
    deleteSchemaFile(db, vaultPath, 'task');
    expect(getSchemaDefinition(db, 'task')).toBeNull();

    restoreSchemaSnapshot(db, vaultPath, op, 'task');

    expect(getSchemaDefinition(db, 'task')!.display_name).toBe('Task');
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['status']);
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(true);
  });
});

describe('captureSchemaSnapshot — idempotency', () => {
  it('INSERT OR IGNORE: second capture for same (op, schema) is a no-op', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const op = createOperation(db, { source_tool: 'update-schema', description: 'u' });

    captureSchemaSnapshot(db, op, 'task');
    captureSchemaSnapshot(db, op, 'task');

    const rows = db.prepare('SELECT COUNT(*) AS c FROM undo_schema_snapshots WHERE operation_id = ?').get(op) as { c: number };
    expect(rows.c).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/undo/schema-snapshot.test.ts`
Expected: FAIL with "Cannot find module '../../src/undo/schema-snapshot.js'".

- [ ] **Step 3: Create `src/undo/schema-snapshot.ts`**

```typescript
// src/undo/schema-snapshot.ts
//
// Schema-level undo snapshot capture and restore. Mirrors the node-level
// undo_snapshots flow but operates on schemas + schema_field_claims.

import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { renderSchemaFile } from '../schema/render.js';

export interface CaptureOptions {
  was_new?: boolean;
  was_deleted?: boolean;
}

interface SchemaRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
}

interface ClaimRow {
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
}

/**
 * Capture the pre-mutation state of a schema into undo_schema_snapshots.
 *
 * - was_new=true: called before a create-schema; stores a marker row only.
 *   Restore = DELETE.
 * - was_deleted=true: called before a delete-schema; captures current schema
 *   row + all claims so restore can re-INSERT.
 * - Default (update path): captures current schema row + claims so restore
 *   can UPDATE schemas + DELETE/re-INSERT schema_field_claims.
 *
 * INSERT OR IGNORE: idempotent when multi-call tool handlers share an
 * operation_id.
 */
export function captureSchemaSnapshot(
  db: Database.Database,
  operation_id: string,
  schema_name: string,
  opts: CaptureOptions = {},
): void {
  const wasNew = opts.was_new === true ? 1 : 0;
  const wasDeleted = opts.was_deleted === true ? 1 : 0;

  if (wasNew === 1) {
    db.prepare(`
      INSERT OR IGNORE INTO undo_schema_snapshots (
        operation_id, schema_name, was_new, was_deleted,
        display_name, icon, filename_template, default_directory, metadata, field_claims
      ) VALUES (?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(operation_id, schema_name);
    return;
  }

  const schemaRow = db.prepare(
    'SELECT name, display_name, icon, filename_template, default_directory, metadata FROM schemas WHERE name = ?',
  ).get(schema_name) as SchemaRow | undefined;
  if (!schemaRow) return; // best-effort; caller shouldn't capture a missing schema

  const claims = db.prepare(
    'SELECT field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ?',
  ).all(schema_name) as ClaimRow[];

  db.prepare(`
    INSERT OR IGNORE INTO undo_schema_snapshots (
      operation_id, schema_name, was_new, was_deleted,
      display_name, icon, filename_template, default_directory, metadata, field_claims
    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation_id,
    schema_name,
    wasDeleted,
    schemaRow.display_name,
    schemaRow.icon,
    schemaRow.filename_template,
    schemaRow.default_directory,
    schemaRow.metadata,
    JSON.stringify(claims),
  );
}

interface SnapshotRow {
  operation_id: string;
  schema_name: string;
  was_new: number;
  was_deleted: number;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
  field_claims: string | null;
}

/**
 * Restore a schema to its captured state.
 */
export function restoreSchemaSnapshot(
  db: Database.Database,
  vaultPath: string,
  operation_id: string,
  schema_name: string,
): void {
  const snap = db.prepare(
    'SELECT * FROM undo_schema_snapshots WHERE operation_id = ? AND schema_name = ?',
  ).get(operation_id, schema_name) as SnapshotRow | undefined;
  if (!snap) return;

  if (snap.was_new === 1) {
    // Undo a create: DELETE the schema. CASCADE removes schema_field_claims.
    db.prepare('DELETE FROM schemas WHERE name = ?').run(schema_name);
    try {
      const absPath = safeVaultPath(vaultPath, join('.schemas', `${schema_name}.yaml`));
      if (existsSync(absPath)) unlinkSync(absPath);
      db.prepare('DELETE FROM schema_file_hashes WHERE file_path = ?').run(`.schemas/${schema_name}.yaml`);
    } catch {
      // Path traversal block or file-missing — don't propagate; restore continues.
    }
    return;
  }

  // was_deleted=1 or update-path. Both require the same work: upsert schemas
  // row, replace claims. INSERT OR REPLACE handles both.
  db.prepare(`
    INSERT OR REPLACE INTO schemas (
      name, display_name, icon, filename_template, default_directory, field_claims, metadata
    ) VALUES (?, ?, ?, ?, ?, '[]', ?)
  `).run(
    schema_name,
    snap.display_name,
    snap.icon,
    snap.filename_template,
    snap.default_directory,
    snap.metadata,
  );

  db.prepare('DELETE FROM schema_field_claims WHERE schema_name = ?').run(schema_name);
  if (snap.field_claims) {
    const claims = JSON.parse(snap.field_claims) as Array<{
      field: string; label: string | null; description: string | null; sort_order: number;
      required_override: number | null; default_value_override: string | null;
      default_value_overridden: number; enum_values_override: string | null;
    }>;
    const insert = db.prepare(`
      INSERT INTO schema_field_claims (
        schema_name, field, label, description, sort_order,
        required_override, default_value_override, default_value_overridden, enum_values_override
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of claims) {
      insert.run(
        schema_name,
        c.field,
        c.label,
        c.description,
        c.sort_order,
        c.required_override,
        c.default_value_override,
        c.default_value_overridden,
        c.enum_values_override,
      );
    }
  }

  renderSchemaFile(db, vaultPath, schema_name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/undo/schema-snapshot.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/undo/schema-snapshot.ts tests/undo/schema-snapshot.test.ts
git commit -m "feat(undo): captureSchemaSnapshot + restoreSchemaSnapshot"
```

---

## Task 7: B3.3 — verify `operation_id` threading end-to-end

**Rationale.** Task 1 already added `operation_id` as an option to `propagateSchemaChange` and threaded it to `rerenderNodeThroughPipeline`'s `executeMutation` call. This task adds a sanity test confirming that per-node snapshots are captured when a caller provides an `operation_id`.

**Files:**
- Test: `tests/schema/propagation.test.ts`

- [ ] **Step 1: Write the verification test**

Append to `tests/schema/propagation.test.ts`:

```typescript
describe('propagateSchemaChange — operation_id threading', () => {
  it('per-node snapshots are captured under the caller-supplied operation_id', async () => {
    const { createOperation, finalizeOperation } = await import('../../src/undo/operation.js');
    const { addSchemaUndoSnapshots } = await import('../../src/db/migrate.js');
    addSchemaUndoSnapshots(db);

    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const n1 = createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const op = createOperation(db, { source_tool: 'update-schema', description: 'test' });
    try {
      const oldClaims: Array<{ field: string; sort_order?: number }> = [];
      const newClaims = [{ field: 'status', sort_order: 1000 }];
      updateSchemaDefinition(db, 'task', { field_claims: newClaims });
      const diff = diffClaims(oldClaims, newClaims);

      propagateSchemaChange(db, writeLock, vaultPath, 'task', diff, undefined, { operation_id: op });
    } finally {
      finalizeOperation(db, op);
    }

    const snaps = db.prepare('SELECT node_id FROM undo_snapshots WHERE operation_id = ?').all(op) as Array<{ node_id: string }>;
    expect(snaps.some(s => s.node_id === n1.node_id)).toBe(true);

    const opRow = db.prepare('SELECT node_count FROM undo_operations WHERE operation_id = ?').get(op) as { node_count: number };
    expect(opRow.node_count).toBeGreaterThan(0);
  });
});
```

The local `beforeEach` builds its own DB; this test dynamically imports and runs `addSchemaUndoSnapshots` so migration ordering is explicit.

**Note:** `addUndoTables` is already called by the existing `beforeEach` via `createSchema` or a direct call — verify during implementation. If not, add it.

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/schema/propagation.test.ts -t "operation_id threading"`
Expected: PASS (Task 1 already wired threading).

- [ ] **Step 3: Commit**

```bash
git add tests/schema/propagation.test.ts
git commit -m "test(schema): verify propagation threads operation_id to node snapshots"
```

---

## Task 8: B3.4 — wrap `update-schema` commit in transaction + capture schema snapshot

**Rationale.** Today each sub-call (updateSchemaDefinition, propagateSchemaChange) has its own inner transaction. A throw mid-propagation leaves the schema row updated but propagation incomplete. Outer `db.transaction` wraps everything atomically. Schema snapshot capture runs inside the same transaction so it's rolled back if commit fails.

**Files:**
- Modify: `src/mcp/tools/update-schema.ts`
- Test: `tests/mcp/update-schema.test.ts`

- [ ] **Step 1: Write the failing undo-roundtrip tests**

Append to `tests/mcp/update-schema.test.ts`:

```typescript
import { restoreMany } from '../../src/undo/restore.js';
import { listOperations } from '../../src/undo/operation.js';

describe('update-schema undo integration', () => {
  it('successful commit is captured in list-undo-history with schema_count=1', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }],
    }));
    expect(result.ok).toBe(true);

    const list = listOperations(db, { source_tool: 'update-schema' });
    expect(list.operations.length).toBe(1);
    const op = list.operations[0];
    expect(op.schema_count).toBe(1);
    expect(op.node_count).toBeGreaterThan(0);
  });

  it('undo-operations restores schema to pre-state (claims cleared)', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    await handler({ name: 'task', field_claims: [{ field: 'status' }] });

    const list = listOperations(db, { source_tool: 'update-schema' });
    const op_id = list.operations[0].operation_id;

    restoreMany(db, writeLock, vaultPath, { operation_ids: [op_id], dry_run: false });

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims).toEqual([]);
  });

  it('validation-rejecting commit rolls back; operation row carries counts=0', async () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'ok.md', title: 'OK', types: ['task'], fields: { status: 'open' } });

    db.prepare('UPDATE node_fields SET value_text = ? WHERE field_name = ?').run('garbage', 'status');

    createGlobalField(db, { name: 'priority', field_type: 'string', required: true, default_value: 'normal' });

    const result = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status' }, { field: 'priority' }],
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');

    // Schema row unchanged.
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ? ORDER BY field').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['status']);

    // After a rollback, the undo_operations row exists but carries node_count=0
    // and schema_count=0 (no state was actually persisted). The orphan sweep in
    // runUndoCleanup reaps such rows within 60s.
    const ops = db.prepare(
      "SELECT node_count, schema_count, status FROM undo_operations WHERE source_tool = 'update-schema'"
    ).all() as Array<{ node_count: number; schema_count: number; status: string }>;
    expect(ops.length).toBeLessThanOrEqual(1);
    if (ops.length === 1) {
      expect(ops[0].node_count).toBe(0);
      expect(ops[0].schema_count).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mcp/update-schema.test.ts -t "undo integration"`
Expected: FAIL — no schema_count, no snapshot capture.

- [ ] **Step 3: Rework the commit path in `update-schema.ts`**

Open `src/mcp/tools/update-schema.ts`. Replace the entire `// Live-commit path.` block (the `try { const result = updateSchemaDefinition(...); ... } catch (err) { ... }` section) with:

```typescript
      // Live-commit path.
      const operation_id = createOperation(db, {
        source_tool: 'update-schema',
        description: buildDescription(name, rest, preview),
      });

      let finalResult: Awaited<ReturnType<typeof updateSchemaDefinition>> | undefined;
      let propagation: ReturnType<typeof propagateSchemaChange> | undefined;
      try {
        const tx = db.transaction(() => {
          captureSchemaSnapshot(db, operation_id, name);
          finalResult = updateSchemaDefinition(db, name, rest);
          if (rest.field_claims) {
            const preDiff = {
              added: preview.claims_added,
              removed: preview.claims_removed,
              changed: preview.claims_modified,
            };
            propagation = propagateSchemaChange(
              db, writeLock, vaultPath, name, preDiff, ctx.syncLogger,
              { operation_id },
            );
          }
        });
        tx();

        // Bump schema_count. finalizeOperation only updates node_count, so this
        // write survives the later finalize call in the finally block.
        db.prepare(
          'UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?',
        ).run(operation_id);

        renderSchemaFile(db, vaultPath, name);
        return ok({ ...finalResult!, propagation, operation_id });
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          return fail('VALIDATION_FAILED', err.message, { details: { groups: err.groups } });
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
```

At the top of the file, extend imports:

```typescript
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';
```

At the bottom of the file, add the helper:

```typescript
function buildDescription(
  name: string,
  rest: { field_claims?: unknown },
  preview: { claims_added: string[]; claims_removed: string[]; claims_modified: string[] },
): string {
  if (!rest.field_claims) return `update-schema: ${name}`;
  const a = preview.claims_added.length;
  const r = preview.claims_removed.length;
  const m = preview.claims_modified.length;
  return `update-schema: ${name} (+${a}/-${r}/~${m} claims)`;
}
```

**Rollback semantics, explicit.** The outer `db.transaction` wraps `captureSchemaSnapshot` + `updateSchemaDefinition` + `propagateSchemaChange`. A throw anywhere inside unwinds all three. The `undo_operations` row itself is created BEFORE the transaction and is not rolled back — but with `node_count=0` and `schema_count=0`, the hourly orphan sweep (`runUndoCleanup` in `src/undo/cleanup.ts`) deletes it within 60s.

**Why `schema_count` update lives outside the transaction.** If we updated `schema_count` inside the transaction, `finalizeOperation` running afterward would still see it. That's fine — but doing the write post-transaction also makes the intent explicit: "this row now represents a successfully committed schema op." Either placement works; we keep it post-tx for clarity.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp/update-schema.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full test suite**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/update-schema.ts tests/mcp/update-schema.test.ts
git commit -m "feat(update-schema): wrap commit in transaction + capture schema snapshot"
```

---

## Task 9: B3.5 — undo for `create-schema` and `delete-schema`

**Files:**
- Modify: `src/mcp/tools/create-schema.ts`
- Modify: `src/mcp/tools/delete-schema.ts`
- Test: `tests/mcp/create-delete-schema.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/create-delete-schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addSchemaUndoSnapshots } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, getSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { registerCreateSchema } from '../../src/mcp/tools/create-schema.js';
import { registerDeleteSchema } from '../../src/mcp/tools/delete-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { listOperations } from '../../src/undo/operation.js';
import { restoreMany } from '../../src/undo/restore.js';

interface Envelope { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string }; warnings: unknown[] }
function parseResult(result: unknown): Envelope {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Envelope;
}

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function captureCreate(): (args: Record<string, unknown>) => Promise<unknown> {
  let h: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, fn: (...a: unknown[]) => unknown) => { h = (args) => fn(args) as Promise<unknown>; } } as unknown as McpServer;
  registerCreateSchema(fake, db, { vaultPath });
  return h!;
}
function captureDelete(): (args: Record<string, unknown>) => Promise<unknown> {
  let h: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const fake = { tool: (_n: string, _d: string, _s: unknown, fn: (...a: unknown[]) => unknown) => { h = (args) => fn(args) as Promise<unknown>; } } as unknown as McpServer;
  registerDeleteSchema(fake, db, { vaultPath });
  return h!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addSchemaUndoSnapshots(db);
  writeLock = new WriteLockManager();
});
afterEach(() => { db.close(); cleanup(); });

describe('create-schema undo', () => {
  it('creates op; undo removes schema + yaml', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    const handler = captureCreate();
    const result = parseResult(await handler({ name: 'task', field_claims: [{ field: 'status' }] }));
    expect(result.ok).toBe(true);

    const list = listOperations(db, { source_tool: 'create-schema' });
    expect(list.operations.length).toBe(1);
    expect(list.operations[0].schema_count).toBe(1);

    restoreMany(db, writeLock, vaultPath, { operation_ids: [list.operations[0].operation_id], dry_run: false });

    expect(getSchemaDefinition(db, 'task')).toBeNull();
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(false);
  });
});

describe('delete-schema undo', () => {
  it('deletes op; undo restores schema + yaml', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }], display_name: 'Task' });
    const handler = captureDelete();
    const result = parseResult(await handler({ name: 'task' }));
    expect(result.ok).toBe(true);

    const list = listOperations(db, { source_tool: 'delete-schema' });
    expect(list.operations.length).toBe(1);

    restoreMany(db, writeLock, vaultPath, { operation_ids: [list.operations[0].operation_id], dry_run: false });

    const restored = getSchemaDefinition(db, 'task');
    expect(restored?.display_name).toBe('Task');
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/mcp/create-delete-schema.test.ts`
Expected: FAIL on restore assertions — `restoreMany` does not yet know about schema snapshots. The creation+capture side (`listOperations` + `schema_count=1`) may pass after Step 3/4; the full restore assertions require Task 10.

- [ ] **Step 3: Extend `create-schema.ts`**

Replace `src/mcp/tools/create-schema.ts` with:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { createSchemaDefinition } from '../../schema/crud.js';
import { renderSchemaFile } from '../../schema/render.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
  default_value_overridden: z.boolean().optional(),
  enum_values_override: z.array(z.string()).optional(),
});

export function registerCreateSchema(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'create-schema',
    'Creates a new schema definition with field claims. Referenced global fields must already exist.',
    {
      name: z.string(),
      display_name: z.string().optional(),
      icon: z.string().optional(),
      filename_template: z.string().optional(),
      default_directory: z.string().optional(),
      field_claims: z.array(fieldClaimSchema),
      metadata: z.unknown().optional(),
    },
    async (params) => {
      if (params.name.startsWith('_')) {
        return fail('INVALID_PARAMS', "Schema names starting with '_' are reserved for engine-managed files.");
      }

      const operation_id = createOperation(db, {
        source_tool: 'create-schema',
        description: `create-schema: ${params.name}`,
      });

      try {
        const tx = db.transaction(() => {
          captureSchemaSnapshot(db, operation_id, params.name, { was_new: true });
          createSchemaDefinition(db, params);
        });
        tx();

        db.prepare('UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?').run(operation_id);

        if (ctx?.vaultPath) renderSchemaFile(db, ctx.vaultPath, params.name);
        return ok({ name: params.name, operation_id });
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}
```

- [ ] **Step 4: Extend `delete-schema.ts`**

Replace `src/mcp/tools/delete-schema.ts` with:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { deleteSchemaDefinition } from '../../schema/crud.js';
import { deleteSchemaFile } from '../../schema/render.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';

export function registerDeleteSchema(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'delete-schema',
    'Deletes a schema definition and its field claims. Node types referencing this schema are not removed.',
    { name: z.string() },
    async ({ name }) => {
      const operation_id = createOperation(db, {
        source_tool: 'delete-schema',
        description: `delete-schema: ${name}`,
      });

      try {
        let result: ReturnType<typeof deleteSchemaDefinition> | undefined;
        const tx = db.transaction(() => {
          captureSchemaSnapshot(db, operation_id, name, { was_deleted: true });
          result = deleteSchemaDefinition(db, name);
        });
        tx();

        db.prepare('UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?').run(operation_id);

        if (ctx?.vaultPath) deleteSchemaFile(db, ctx.vaultPath, name);
        return ok({ ...result!, operation_id });
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/create-schema.ts src/mcp/tools/delete-schema.ts tests/mcp/create-delete-schema.test.ts
git commit -m "feat(create/delete-schema): capture snapshots under undo operation"
```

Restore-side assertions in the new test file still fail — Task 10 wires the restore path.

---

## Task 10: B3.6 — schema-first restore pass in `undo/restore.ts`

**Rationale.** Schema state must restore before node state so the pipeline re-validates restored nodes against the restored (pre-change) schema.

**Files:**
- Modify: `src/undo/restore.ts`
- Modify: `src/undo/types.ts`
- Test: `tests/mcp/update-schema.test.ts`, `tests/mcp/create-delete-schema.test.ts`

- [ ] **Step 1: Run the Task 8/9 tests to confirm they fail on restore**

Run: `npx vitest run tests/mcp/update-schema.test.ts tests/mcp/create-delete-schema.test.ts`
Expected: restore-side assertions fail (schema-first pass not wired).

- [ ] **Step 2: Add `schema_count` to `UndoOperationRow`**

In `src/undo/types.ts`:

```typescript
export interface UndoOperationRow {
  operation_id: string;
  timestamp: number;
  source_tool: string;
  description: string;
  node_count: number;
  schema_count: number;
  status: 'active' | 'undone' | 'expired';
}
```

- [ ] **Step 3: Extend `restoreOperation` to run a schema pass first**

Open `src/undo/restore.ts`. Add import at the top:

```typescript
import { restoreSchemaSnapshot } from './schema-snapshot.js';
```

Inside `restoreOperation`, just before the `conflictedIds`/resolveMap setup, add:

```typescript
  // Schema snapshots tied to this operation. Schema-level conflicts are not
  // detected; re-updates between the operation and the undo overwrite without
  // warning. Node-level snapshots still run through detectConflicts.
  const schemaSnaps = db.prepare(
    'SELECT schema_name FROM undo_schema_snapshots WHERE operation_id = ?',
  ).all(operation_id) as Array<{ schema_name: string }>;
```

Inside the `if (!opts.dry_run)` block, before the `for (const s of buckets.create) { ... }` lines, add:

```typescript
    // Schema-first pass: restore schema state before any node work so
    // node restores re-validate against the pre-change schema.
    for (const snap of schemaSnaps) {
      restoreSchemaSnapshot(db, vaultPath, operation_id, snap.schema_name);
    }
```

The existing node-bucket code runs unchanged after this pass.

- [ ] **Step 4: Run the integration tests**

Run: `npx vitest run tests/mcp/update-schema.test.ts tests/mcp/create-delete-schema.test.ts`
Expected: all pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run build`
Expected: all green. If `tests/undo/restore.test.ts` or `tests/undo/integration.test.ts` break, investigate — the schema-first pass should be a no-op when `undo_schema_snapshots` has no rows for the operation.

- [ ] **Step 6: Commit**

```bash
git add src/undo/restore.ts src/undo/types.ts
git commit -m "feat(undo): schema-first restore pass before node snapshots"
```

---

## Task 11: B3.7 — surface `schema_count` in `list-undo-history`

**Files:**
- Modify: `src/mcp/tools/list-undo-history.ts`
- Test: `tests/mcp/list-undo-history.test.ts`

- [ ] **Step 1: Write the failing test**

Open `tests/mcp/list-undo-history.test.ts`. Append a test asserting `schema_count` appears in the output (adapt the boilerplate — `handler`, `parseResult`, `db` — to whatever the existing file uses):

```typescript
import { createOperation } from '../../src/undo/operation.js';
import { addSchemaUndoSnapshots } from '../../src/db/migrate.js';

it('includes schema_count in each operation row', async () => {
  addSchemaUndoSnapshots(db);
  const op = createOperation(db, { source_tool: 'update-schema', description: 'u' });
  db.prepare('UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?').run(op);

  const result = parseResult(await handler({ source_tool: 'update-schema' }));
  const rows = (result.data as { operations: Array<{ operation_id: string; schema_count: number }> }).operations;
  expect(rows[0].operation_id).toBe(op);
  expect(rows[0].schema_count).toBe(1);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/mcp/list-undo-history.test.ts`
Expected: FAIL — `schema_count` missing from output.

- [ ] **Step 3: Extend `list-undo-history.ts`**

In `src/mcp/tools/list-undo-history.ts`, extend the mapping to include `schema_count`:

```typescript
      return ok({
        operations: result.operations.map(o => ({
          operation_id: o.operation_id,
          timestamp: new Date(o.timestamp).toISOString(),
          source_tool: o.source_tool,
          description: o.description,
          node_count: o.node_count,
          schema_count: o.schema_count,
          status: o.status,
        })),
        truncated: result.truncated,
      });
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/mcp/list-undo-history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/list-undo-history.ts tests/mcp/list-undo-history.test.ts
git commit -m "feat(list-undo-history): surface schema_count in output"
```

---

## Task 12: Phase B verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: 100% pass.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 3: Manual smoke test via local dev**

In a scratch vault, exercise the happy path end-to-end via an MCP client (claude.ai UI preferred — see user memory on CLI stringification quirks):

```
1. create-schema name:'demo', field_claims:[{field:'status'}]
   → verify operation_id returned; list-undo-history shows schema_count=1
2. create-node name:'demo', status:'active'
3. update-schema name:'demo', field_claims:[], dry_run:true
   → ok:true; orphaned_field_names:[{field:'status', count:1}]; propagation.fields_orphaned:1
   → verify DB still has the schema claim (no commit)
4. update-schema name:'demo', field_claims:[]   (no confirm flag)
   → ok:false, error.code:'CONFIRMATION_REQUIRED'
5. update-schema name:'demo', field_claims:[], confirm_large_change:true
   → ok:true; list-undo-history shows a new update-schema op with schema_count=1
6. undo-operations {operation_ids:[<the update op>], dry_run:false}
   → schema claims restored
```

Document any surprises in a follow-up PR comment.

- [ ] **Step 4: Push branch and open PR**

```bash
git push -u origin phase-b/schema-ops
gh pr create --title "Phase B: schema ops dry-run, confirm gate, undo parity" --body "$(cat <<'EOF'
## Summary
- B1: dry_run preview for update-schema (SAVEPOINT-based)
- B2: CONFIRMATION_REQUIRED gate on orphan-producing commits
- B3: undo parity for create-schema / update-schema / delete-schema
- Folds in Phase A polish: defensive groups filter, rollback test, batch-mutate regression test

## Test plan
- [x] npm test
- [x] npm run build
- [ ] Manual smoke test: dry-run preview, confirm gate, undo roundtrip
EOF
)"
```

---

## Self-review checklist (fresh-eyes pass)

Before handing off to subagent-driven-development:

- **Spec coverage:** B1 (Tasks 1-3), B2 (Task 4), B3.1 (Task 5), B3.2 (Task 6), B3.3 (Task 7), B3.4 (Task 8), B3.5 (Task 9), B3.6 (Task 10), B3.7 (Task 11). ✓
- **Polish backlog:** T1 (Task 0 Step 1), T3 (Task 0 Step 2), T7 (Task 0 Step 3), any-cast replacement (Task 0 Step 3). ✓
- **Placeholders:** none.
- **Type consistency:** `propagateSchemaChange` signature is 7-args (db, writeLock, vaultPath, schemaName, diff, syncLogger, opts) used consistently. `PropagationResult` augmented with optional `validation_groups` and `orphaned_field_names`. `SchemaPreviewResult` defined in preview.ts, used in update-schema.ts. `UndoOperationRow` gains `schema_count` in Task 10 Step 2.
- **Migration ordering:** `addSchemaUndoSnapshots` creates the table, adds the column, and creates the index in one migration (not relying on `createSchema` IF NOT EXISTS on an existing DB).
- **`finalizeOperation` interaction with `schema_count`:** `finalizeOperation` in `src/undo/operation.ts` only updates `node_count`. Post-transaction `UPDATE schema_count = 1` survives the later `finalizeOperation` call. Documented in Task 8 notes.
- **Rollback semantics:** Outer `db.transaction` in update-schema / create-schema / delete-schema wraps schema snapshot capture + schema mutation + (for update) propagation. A mid-work throw unwinds everything. The `undo_operations` row is created BEFORE the transaction and remains post-throw with counts=0, reaped by the orphan sweep.
- **Schema-first restore ordering:** Task 10 Step 3 positions the schema-restore pass before node buckets.
- **Preview mode no file writes:** `db_only: true` threaded through `rerenderNodeThroughPipeline` → `executeMutation`. Task 2's file-mtime test verifies.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-04-22-schema-ops-phase-b.md`. Recommended execution path: **superpowers:subagent-driven-development** — matches the Phase A workflow; dispatches a fresh subagent per task with two-stage review between commits.
