# Bundle A — Pipeline Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three pipeline-hygiene items from the 2026-04-25 deferred backlog: §1d reconciler silent-catch, §3e override-resolution reuse, §2d rename-node atomicity weak contract.

**Architecture:** Three localized fixes within already-mapped subsystems. §1d adds visible logging to the reconciler error path without changing control flow. §3e moves `default_source` derivation from the pipeline back into `mergeFieldClaims` so the pipeline reads it from `EffectiveField` instead of re-iterating `claimsByType`. §2d records filesystem renames performed inside `executeRename` and reverses them when the outer transaction throws.

**Tech Stack:** TypeScript (ESM), better-sqlite3 (nested transactions via SAVEPOINT), vitest, node:fs.

---

## Pre-flight

- [ ] **Step 0a: Confirm working tree is clean and on `main`**

Run: `git status -s && git rev-parse --abbrev-ref HEAD`
Expected: empty status, `main`.

- [ ] **Step 0b: Run the existing test suite to establish baseline green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 0c: Create the working branch**

```bash
git checkout -b chore/bundle-a-pipeline-hygiene
```

---

## Task 1 — §1d: Reconciler error visibility

**Files:**
- Modify: `src/sync/reconciler.ts:84-90` (per-file catch in sweep)
- Modify: `src/sync/reconciler.ts:115-132` (`walkDir` silent readdir catch)
- Test: `tests/integration/reconciler-error-logging.test.ts` (extend existing file)

**Background:** Today the per-file `catch` in `sweep()` writes to the `edits_log` table only — operators never see the error in the engine's process log. The `walkDir` helper has a true silent `try/catch` around `readdirSync` that returns nothing on failure. Other subsystems use `console.error('[subsystem] ...')` (see `src/sync/normalizer.ts:176`, `src/sync/watcher.ts:243`).

- [ ] **Step 1.1: Write the failing test for per-file error console output**

Add a new `it(...)` block to the existing `describe('reconciler error logging', ...)` in `tests/integration/reconciler-error-logging.test.ts`:

```typescript
  it('emits a console.error tagged [reconciler] when a per-file sweep throws', async () => {
    const bad = join(vaultPath, 'unreadable.md');
    writeFileSync(bad, '---\ntypes:\n---\n# X\n', 'utf-8');
    chmodSync(bad, 0o000);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
    };

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
      await new Promise(resolve => setTimeout(resolve, 150));
      reconciler.stop();

      expect(errors.some(line => line.includes('[reconciler]') && line.includes('unreadable.md'))).toBe(true);
    } finally {
      console.error = originalError;
      chmodSync(bad, 0o644);
    }
  });
```

- [ ] **Step 1.2: Run the new test to confirm it fails**

Run: `npx vitest run tests/integration/reconciler-error-logging.test.ts -t 'emits a console.error'`
Expected: FAIL — assertion `errors.some(...)` is `false` (no console.error today).

- [ ] **Step 1.3: Implement: add console.error in the per-file catch**

Edit `src/sync/reconciler.ts`. Replace the existing `catch` block at lines 84-90:

```typescript
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reconciler] sweep error for ${relPath}: ${msg}`);
          db.prepare(
            'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
          ).run(null, Date.now(), 'reconciler-error', `${relPath}: ${msg}`);
          stats.errors++;
        }
```

- [ ] **Step 1.4: Run the new test to confirm it passes**

Run: `npx vitest run tests/integration/reconciler-error-logging.test.ts -t 'emits a console.error'`
Expected: PASS.

- [ ] **Step 1.5: Re-run the original `edits_log` test to confirm no regression**

Run: `npx vitest run tests/integration/reconciler-error-logging.test.ts`
Expected: both tests PASS.

- [ ] **Step 1.6: Surface the silent `walkDir` catch**

Edit `src/sync/reconciler.ts`. Replace the silent catch at lines 115-121:

```typescript
function walkDir(dir: string, vaultPath: string, results: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reconciler] walkDir failed for ${dir}: ${msg}`);
    return;
  }
```

- [ ] **Step 1.7: Run the full test suite to confirm no regression**

Run: `npm test`
Expected: PASS.

- [ ] **Step 1.8: Commit**

```bash
git add src/sync/reconciler.ts tests/integration/reconciler-error-logging.test.ts
git commit -m "$(cat <<'EOF'
fix(reconciler): surface per-file and walkDir errors via console.error

Errors during sweep were only written to edits_log; operators tailing
the engine log saw nothing. Add tagged console.error alongside the
existing edits_log capture and surface the previously silent walkDir
readdir failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — §3e: Move `default_source` into `EffectiveField`

**Files:**
- Modify: `src/validation/types.ts` (add `default_source` to `EffectiveField`)
- Modify: `src/validation/merge.ts:74-117` (compute `default_source` while resolving the default)
- Modify: `src/pipeline/execute.ts:166-183` (collapse loop) and `src/pipeline/execute.ts:233-249` (collapse loop)
- Test: `tests/validation/merge.test.ts` (add `default_source` cases)

**Background:** `mergeFieldClaims` already determines whether the resolved default came from a per-type override or fell back to the global value (see `src/validation/merge.ts:84-94`). The pipeline then re-derives a `'global' | 'claim'` source label by re-iterating `claimsByType` for every defaulted field — duplicated logic, two copies (tool path + watcher path), and **subtly wrong**: it returns `'claim'` whenever *any* claim has an override, even when overrides cancel back to the global value on disagreement.

The fix surfaces `default_source` on `EffectiveField`, computed correctly at the merge step, and replaces both pipeline loops with a single lookup.

### Subtask 2A — Extend `EffectiveField` and `mergeFieldClaims`

- [ ] **Step 2.1: Add `default_source` test for the no-override case**

Add to `tests/validation/merge.test.ts`, after the existing `'single type, single claim'` test:

```typescript
  it('default_source — global when no override applies', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft' })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.default_source).toBe('global');
  });

  it('default_source — claim when a single override applies', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft', overrides_allowed: { required: false, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', default_value_override: { kind: 'override', value: 'open' } })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_default_value).toBe('open');
    expect(ef.default_source).toBe('claim');
  });

  it('default_source — global when overrides cancel on disagreement', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', default_value: 'draft', overrides_allowed: { required: false, default_value: true, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', default_value_override: { kind: 'override', value: 'open' } })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', default_value_override: { kind: 'override', value: 'active' } })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.resolved_default_value).toBe('draft');
    expect(ef.default_source).toBe('global');
  });
```

- [ ] **Step 2.2: Run the new tests to confirm they fail**

Run: `npx vitest run tests/validation/merge.test.ts -t 'default_source'`
Expected: FAIL — `default_source` is `undefined` (property does not exist yet).

- [ ] **Step 2.3: Add `default_source` to the `EffectiveField` type**

Edit `src/validation/types.ts:41-51`. Replace the `EffectiveField` interface:

```typescript
export interface EffectiveField {
  field: string;
  global_field: GlobalFieldDefinition;
  resolved_label: string | null;
  resolved_description: string | null;
  resolved_order: number;
  resolved_required: boolean;
  resolved_default_value: unknown;
  /** Where `resolved_default_value` came from: 'claim' iff a per-type override
   *  actually won (single override or all overrides agreed). 'global' otherwise,
   *  including the cancel-to-global case when overrides disagreed. */
  default_source: 'global' | 'claim';
  claiming_types: string[];
  per_type_enum_values?: PerTypeEnumValues[];
}
```

- [ ] **Step 2.4: Compute `default_source` in `mergeFieldClaims`**

Edit `src/validation/merge.ts`. Replace the default-resolution block at lines 83-94 and the `effectiveFields.set(...)` call at lines 106-116:

```typescript
    // --- Resolve default_value: cancellation on conflict ---
    let resolvedDefaultValue = globalField.default_value;
    let defaultSource: 'global' | 'claim' = 'global';
    const defaultOverrides = claimEntries.filter(e => e.claim.default_value_override.kind === 'override');
    if (defaultOverrides.length > 0) {
      const first = JSON.stringify((defaultOverrides[0].claim.default_value_override as { kind: 'override'; value: unknown }).value);
      const allAgree = defaultOverrides.every(e =>
        JSON.stringify((e.claim.default_value_override as { kind: 'override'; value: unknown }).value) === first
      );
      if (allAgree) {
        resolvedDefaultValue = (defaultOverrides[0].claim.default_value_override as { kind: 'override'; value: unknown }).value;
        defaultSource = 'claim';
      }
      // disagreement: keep globalField.default_value AND defaultSource='global'
    }
```

And the `effectiveFields.set(...)` block:

```typescript
    effectiveFields.set(fieldName, {
      field: fieldName,
      global_field: globalField,
      resolved_label: resolvedLabel,
      resolved_description: resolvedDescription,
      resolved_order: resolvedOrder,
      resolved_required: resolvedRequired,
      resolved_default_value: resolvedDefaultValue,
      default_source: defaultSource,
      claiming_types: claimingTypes,
      per_type_enum_values: perTypeEnumValues,
    });
```

- [ ] **Step 2.5: Run the new tests to confirm they pass**

Run: `npx vitest run tests/validation/merge.test.ts -t 'default_source'`
Expected: PASS.

- [ ] **Step 2.6: Run the full merge test file to confirm no regression**

Run: `npx vitest run tests/validation/merge.test.ts`
Expected: PASS.

### Subtask 2B — Replace pipeline loops with `default_source` lookup

- [ ] **Step 2.7: Find any other consumers of `EffectiveField` that may construct one inline**

Run: `grep -rn "claiming_types:" src/ tests/ --include="*.ts" | grep -v "merge.ts\|types.ts"`
Expected: any matches that construct an `EffectiveField` literal must also have `default_source` added. If nothing matches outside `merge.ts`/`types.ts`, no further changes are needed for this step.

If a match exists, add `default_source: 'global'` (the safe default for any place that doesn't already track it). Do not modify call sites that just *consume* `EffectiveField`.

- [ ] **Step 2.8: Replace the tool-path loop in `execute.ts`**

Edit `src/pipeline/execute.ts`. Replace lines 167-183 (the tool-path defaulted-fields tracking inside the `if (mutation.source === 'tool' || ...)` branch):

```typescript
      // Track defaulted fields for edits log
      for (const [, cv] of Object.entries(validation.coerced_state)) {
        if (cv.source === 'defaulted') {
          const ef = validation.effective_fields.get(cv.field);
          const source: 'global' | 'claim' = ef?.default_source ?? 'global';
          defaultedFields.push({ field: cv.field, default_value: cv.value, default_source: source });
        }
      }
```

- [ ] **Step 2.9: Replace the watcher-path loop in `execute.ts`**

Edit `src/pipeline/execute.ts`. Replace lines 234-249 (the watcher-path defaulted-fields tracking inside the `else` branch):

```typescript
      // Track defaulted fields
      for (const [, cv] of Object.entries(validation.coerced_state)) {
        if (cv.source === 'defaulted') {
          const ef = validation.effective_fields.get(cv.field);
          const source: 'global' | 'claim' = ef?.default_source ?? 'global';
          defaultedFields.push({ field: cv.field, default_value: cv.value, default_source: source });
        }
      }
```

- [ ] **Step 2.10: Build to catch any type errors**

Run: `npm run build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 2.11: Run the full test suite**

Run: `npm test`
Expected: PASS.

If any test that asserts `default_source: 'claim'` is now reporting `'global'` because the prior buggy behavior was being relied on, fix the test to reflect the corrected semantics (override that cancels to global is `'global'`, not `'claim'`).

- [ ] **Step 2.12: Commit**

```bash
git add src/validation/types.ts src/validation/merge.ts src/pipeline/execute.ts tests/validation/merge.test.ts
git commit -m "$(cat <<'EOF'
refactor(pipeline): read default_source from EffectiveField

mergeFieldClaims already knows whether the resolved default came from
a per-type override or fell back to global. The pipeline was re-deriving
that label by re-iterating claimsByType in two places (tool + watcher
paths) and was subtly wrong: it returned 'claim' whenever any override
existed, even when conflict cancelled to global. Surface default_source
on EffectiveField, set it correctly at merge time, and collapse the
duplicated loops to a single lookup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — §2d: Rename-node filesystem rollback on transaction failure

**Files:**
- Modify: `src/mcp/tools/rename-node.ts:77-200` (`executeRename`) and `:277-283` (txn invocation)
- Test: `tests/mcp/rename-node-rollback.test.ts` (new file)

**Background:** DB-level atomicity is correct — better-sqlite3 nests `db.transaction()` calls via SAVEPOINTs, and the outer txn at `rename-node.ts:277` covers the whole operation. The weak contract is the **filesystem** side: `renameSync` at `executeRename` line 125 happens before the downstream `executeMutation` calls (the re-render at line 145 and each ref-update at line 186). If any of those throw, the DB rolls back fully but the file is already at its new path, leaving DB↔FS divergence.

Fix: track filesystem mutations performed during the rename, and reverse them when the outer txn throws.

Out of scope: `executeMutation` itself writes files via `atomicWriteFile` inside the same outer txn. Reversing those is a much bigger change (would need pre-write content snapshots for every touched file). The realistic harm window for rename specifically is the single `renameSync` of the renamed node's file — that's what we make recoverable. Document the remaining gap explicitly.

### Subtask 3A — Track and reverse filesystem renames

- [ ] **Step 3.1: Write the failing rollback test**

Create `tests/mcp/rename-node-rollback.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('rename-node filesystem rollback', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-rename-rollback-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('reverses the on-disk rename when the outer transaction throws', () => {
    const writeLock = new WriteLockManager();

    // Create a node at Notes/old.md via the pipeline so DB and disk agree.
    const oldFilePath = 'Notes/old.md';
    const initial = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: oldFilePath,
      title: 'old',
      types: [],
      fields: {},
      body: '# old',
    });
    const nodeId = initial.node_id;
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);

    // Inject a poison: monkey-patch db.prepare so the next executeMutation
    // (the re-render inside executeRename) throws. We let the rename UPDATE
    // through and trip on the executeMutation re-render call's INSERT.
    const newFilePath = 'Notes/new.md';
    const txn = db.transaction(() => {
      // Capture original; we will simulate a downstream pipeline failure by
      // throwing from inside executeRename via a wrapper that overrides
      // executeMutation. Simplest: set the renamed file's path then directly
      // throw from a custom step.
      executeRename(
        db,
        writeLock,
        vaultPath,
        { node_id: nodeId, file_path: oldFilePath, title: 'old' },
        'new',
        newFilePath,
      );
      throw new Error('simulated downstream failure after rename');
    });

    expect(() => txn()).toThrow('simulated downstream failure after rename');

    // DB-level: nodes row should still be at the old path.
    const row = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?')
      .get(nodeId) as { file_path: string; title: string };
    expect(row.file_path).toBe(oldFilePath);
    expect(row.title).toBe('old');

    // Filesystem: file should be back at the old path, not at the new path.
    expect(existsSync(join(vaultPath, oldFilePath))).toBe(true);
    expect(existsSync(join(vaultPath, newFilePath))).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run the new test to confirm it fails**

Run: `npx vitest run tests/mcp/rename-node-rollback.test.ts`
Expected: FAIL — file is still at `Notes/new.md`, DB rolled back but disk did not.

- [ ] **Step 3.3: Add a rollback registry parameter to `executeRename`**

Edit `src/mcp/tools/rename-node.ts`. Update the `executeRename` signature and add a tracked rename to the disk-rename block. Replace the function up through step 1 (lines 77-127):

```typescript
/**
 * A pending filesystem mutation that should be reversed if the surrounding
 * DB transaction throws. Currently only the file-rename in step 1 is tracked;
 * `executeMutation`'s atomic file writes are not (would require pre-write
 * content snapshots — a bigger change). See §2d in the 2026-04-25 backlog.
 */
export interface FsRollback {
  push(undo: () => void): void;
}

/**
 * Core rename logic: renames file on disk, updates DB, re-renders, and rewrites references.
 * Must be called inside a db.transaction(). Pass `fsRollback` to make the
 * filesystem rename reversible if the surrounding transaction throws after
 * step 1.
 */
export function executeRename(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  node: { node_id: string; file_path: string; title: string },
  newTitle: string,
  newFilePath: string,
  syncLogger?: SyncLogger,
  undoContext?: { operation_id: string },
  fsRollback?: FsRollback,
): { refsUpdated: number } {
  const oldTitle = node.title;
  const oldFilePath = node.file_path;

  // Find all referencing nodes using full five-tier resolution
  const distinctTargets = db.prepare('SELECT DISTINCT target FROM relationships').all() as { target: string }[];
  const targetsPointingToNode: string[] = [];
  for (const { target } of distinctTargets) {
    const resolved = resolveTarget(db, target);
    if (resolved && resolved.id === node.node_id) {
      targetsPointingToNode.push(target);
    }
  }

  const referencingNodeIds = new Set<string>();
  if (targetsPointingToNode.length > 0) {
    const placeholders = targetsPointingToNode.map(() => '?').join(',');
    const refs = db.prepare(
      `SELECT DISTINCT source_id FROM relationships WHERE target IN (${placeholders}) AND source_id != ?`
    ).all(...targetsPointingToNode, node.node_id) as { source_id: string }[];
    for (const r of refs) referencingNodeIds.add(r.source_id);
  }

  // 0. Capture undo snapshot BEFORE mutating nodes row.
  if (undoContext) {
    captureRenameSnapshot(db, undoContext.operation_id, node.node_id);
  }

  // 1. Rename file on disk (tracked for filesystem rollback).
  if (newFilePath !== oldFilePath) {
    const oldAbs = join(vaultPath, oldFilePath);
    const newAbs = safeVaultPath(vaultPath, newFilePath);
    if (existsSync(oldAbs)) {
      const newDirPath = dirname(newAbs);
      if (!existsSync(newDirPath)) mkdirSync(newDirPath, { recursive: true });
      renameSync(oldAbs, newAbs);
      fsRollback?.push(() => {
        // Best-effort: if the file isn't where we left it (e.g. a later step
        // moved it again), skip silently. The aim is to restore the common
        // case where executeMutation never reached its file-write stage.
        if (existsSync(newAbs) && !existsSync(oldAbs)) {
          renameSync(newAbs, oldAbs);
        }
      });
    }
  }
```

(The rest of `executeRename` from step 2 onward is unchanged.)

- [ ] **Step 3.4: Wire up the rollback at the txn invocation**

Edit `src/mcp/tools/rename-node.ts`. Replace the `// Execute in a single transaction` block (lines 276-286):

```typescript
      // Execute in a single transaction. Track filesystem mutations so we can
      // reverse the on-disk rename if the txn throws (DB rolls back, but the
      // file is already at the new path otherwise).
      const fsUndos: Array<() => void> = [];
      const fsRollback: FsRollback = { push: (u) => fsUndos.push(u) };
      const txn = db.transaction(() => {
        return executeRename(db, writeLock, vaultPath, {
          node_id: node.node_id,
          file_path: oldFilePath,
          title: oldTitle,
        }, params.new_title, newFilePath, syncLogger, { operation_id }, fsRollback);
      });

      try {
        const { refsUpdated } = txn();
```

- [ ] **Step 3.5: Add the catch-side rollback**

Edit `src/mcp/tools/rename-node.ts`. Replace the existing `catch (err)` block (around line 312):

```typescript
      } catch (err) {
        // DB rolled back; reverse any filesystem mutations performed during
        // the txn so disk state matches the rolled-back DB. Reverse order so
        // multi-step mutations unwind correctly.
        for (let i = fsUndos.length - 1; i >= 0; i--) {
          try {
            fsUndos[i]();
          } catch (undoErr) {
            const msg = undoErr instanceof Error ? undoErr.message : String(undoErr);
            console.error(`[rename-node] fs rollback failed: ${msg}`);
          }
        }
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
```

- [ ] **Step 3.6: Run the rollback test to confirm it passes**

Run: `npx vitest run tests/mcp/rename-node-rollback.test.ts`
Expected: PASS.

- [ ] **Step 3.7: Build and run the full test suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 3.8: Commit**

```bash
git add src/mcp/tools/rename-node.ts tests/mcp/rename-node-rollback.test.ts
git commit -m "$(cat <<'EOF'
fix(rename-node): reverse on-disk rename when outer txn throws

DB-level atomicity was already correct (better-sqlite3 nests via
SAVEPOINT), but the filesystem rename in executeRename ran before the
downstream executeMutation calls. If any of those threw, DB rolled back
but the file was left at the new path. Track filesystem mutations and
reverse them in the catch handler. executeMutation's own file writes
remain a known gap (would require pre-write snapshots).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step F.1: Confirm all three commits land cleanly**

Run: `git log --oneline main..HEAD`
Expected: three commits (`fix(reconciler)…`, `refactor(pipeline)…`, `fix(rename-node)…`).

- [ ] **Step F.2: Run the full test suite one more time**

Run: `npm test`
Expected: PASS.

- [ ] **Step F.3: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step F.4: Hand back to the user for merge decision (PR vs. fast-forward to main)**

Do not merge or push without explicit user direction.
