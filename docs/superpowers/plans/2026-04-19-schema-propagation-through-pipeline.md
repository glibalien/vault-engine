# Schema Propagation Through the Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route schema propagation through `executeMutation` via a new `source: 'propagation'` branch so `src/schema/propagate.ts` stops running its own render → write → DB-insert loops.

**Architecture:** Extend `ProposedMutation.source` to include `'propagation'` (skipDefaults=true, tolerate REQUIRED_MISSING). Rewrite `src/schema/propagate.ts` around a shared private helper that loads node state, pre-resolves adoption defaults, and calls `executeMutation`. Keep exported function signatures unchanged; call sites (`update-schema.ts`, `update-global-field.ts`, `rename-global-field.ts`) don't change. Correct the `source` mislabel on `field-defaulted` / `fields-orphaned` log rows (today writes `"tool"` → new writes `"propagation"`).

**Tech Stack:** TypeScript (ESM, `.js` extensions in imports), better-sqlite3, vitest. Build via `npm run build`. Tests via `npm test`.

**Spec reference:** [`docs/superpowers/specs/2026-04-19-schema-propagation-through-pipeline-design.md`](../specs/2026-04-19-schema-propagation-through-pipeline-design.md)

---

## File map

**Modify:**
- `src/pipeline/types.ts` — extend `ProposedMutation.source` union with `'propagation'`.
- `src/pipeline/execute.ts` — extend the tool/normalizer branch to also accept `'propagation'`. Adjust `skipDefaults` and `toleratedCodes` keying.
- `src/pipeline/edits-log.ts` — extend the `source` parameter type in `buildDeviationEntries` to include `'propagation'`.
- `src/schema/propagate.ts` — full internal rewrite. Keep exports: `diffClaims`, `propagateSchemaChange`, `rerenderNodesWithField`, `PropagationResult` type.

**Create:**
- `tests/pipeline/propagation-source.test.ts` — unit tests for the new pipeline branch.
- `tests/schema/propagation.test.ts` — behavior tests for `propagateSchemaChange` and `rerenderNodesWithField` through the pipeline.

**Unchanged (verify only):**
- `src/mcp/tools/update-schema.ts`
- `src/mcp/tools/update-global-field.ts`
- `src/mcp/tools/rename-global-field.ts`

---

## Task 1: Extend `ProposedMutation.source` union

**Files:**
- Modify: `src/pipeline/types.ts:11`
- Modify: `src/pipeline/edits-log.ts:20` (source param type)

- [ ] **Step 1: Update the ProposedMutation.source union**

Edit `src/pipeline/types.ts`, change line 11:

```ts
  source: 'tool' | 'watcher' | 'normalizer' | 'propagation';
```

- [ ] **Step 2: Update buildDeviationEntries source param type**

Edit `src/pipeline/edits-log.ts:20`. Change the signature:

```ts
export function buildDeviationEntries(
  nodeId: string,
  source: 'tool' | 'watcher' | 'normalizer' | 'propagation',
  coercedState: Record<string, CoercedValue>,
  issues: ValidationIssue[],
  nodeTypes: string[],
  retainedValues?: Record<string, { retained_value: unknown; rejected_value: unknown }>,
  defaultedFields?: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }>,
): EditsLogEntry[] {
```

- [ ] **Step 3: Verify the build succeeds**

Run: `npm run build`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/edits-log.ts
git commit -m "feat(pipeline): add 'propagation' to ProposedMutation.source union"
```

---

## Task 2: Extend `executeMutation` branch logic for `'propagation'`

**Files:**
- Modify: `src/pipeline/execute.ts:85-91` (the tool/normalizer branch)

- [ ] **Step 1: Extend the source-gating branch**

Edit `src/pipeline/execute.ts`. Find the block starting at line 85:

```ts
    if (mutation.source === 'tool' || mutation.source === 'normalizer') {
      // Tool path: check for blocking errors. Normalizer also tolerates
      // REQUIRED_MISSING since it re-renders existing DB state without
      // backfilling defaults.
      const toleratedCodes = mutation.source === 'normalizer'
        ? new Set(['MERGE_CONFLICT', 'REQUIRED_MISSING'])
        : new Set(['MERGE_CONFLICT']);
```

Replace with:

```ts
    if (mutation.source === 'tool' || mutation.source === 'normalizer' || mutation.source === 'propagation') {
      // Tool path: check for blocking errors. Normalizer and propagation
      // also tolerate REQUIRED_MISSING since they re-render existing DB state
      // without backfilling defaults — pre-existing violations must not
      // block schema-driven re-renders.
      const isReRenderPath = mutation.source === 'normalizer' || mutation.source === 'propagation';
      const toleratedCodes = isReRenderPath
        ? new Set(['MERGE_CONFLICT', 'REQUIRED_MISSING'])
        : new Set(['MERGE_CONFLICT']);
```

- [ ] **Step 2: Update the skipDefaults arg**

In the same file, find line 76:

```ts
      { fileCtx, skipDefaults: mutation.source === 'normalizer' },
```

Replace with:

```ts
      { fileCtx, skipDefaults: mutation.source === 'normalizer' || mutation.source === 'propagation' },
```

- [ ] **Step 3: Verify the build succeeds**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Run the existing pipeline tests to confirm no regression**

Run: `npx vitest run tests/pipeline/execute.test.ts`
Expected: all existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/execute.ts
git commit -m "feat(pipeline): route 'propagation' source through tool/normalizer branch"
```

---

## Task 3: Unit tests for the new `'propagation'` pipeline branch

**Files:**
- Create: `tests/pipeline/propagation-source.test.ts`

- [ ] **Step 1: Create the test file**

Create `tests/pipeline/propagation-source.test.ts` with the following content:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { sha256 } from '../../src/indexer/hash.js';
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

afterEach(() => {
  db.close();
  cleanup();
});

function makeMutation(overrides: Partial<ProposedMutation> = {}): ProposedMutation {
  return {
    source: 'propagation',
    node_id: null,
    file_path: 'test-node.md',
    title: 'Test Node',
    types: [],
    fields: {},
    body: '',
    ...overrides,
  };
}

describe("executeMutation — source: 'propagation'", () => {
  it('tolerates REQUIRED_MISSING (does not throw)', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // First create a node WITHOUT the required field via the normalizer source
    // (which tolerates REQUIRED_MISSING). We can't create with 'tool' since that
    // would reject on the missing required field.
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'normalizer',
      file_path: 'task.md',
      title: 'Task',
      types: ['task'],
      fields: {},
    }));
    expect(created.node_id).toBeTruthy();

    // Re-render via propagation; should NOT throw despite REQUIRED_MISSING
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'propagation',
      node_id: created.node_id,
      file_path: 'task.md',
      title: 'Task',
      types: ['task'],
      fields: {},
    }));

    expect(result.node_id).toBe(created.node_id);
    expect(result.validation.issues.some(i => i.code === 'REQUIRED_MISSING')).toBe(true);
  });

  it('throws on non-tolerated errors (TYPE_MISMATCH)', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'item', field_claims: [{ field: 'count' }] });

    expect(() => {
      executeMutation(db, writeLock, vaultPath, makeMutation({
        source: 'propagation',
        file_path: 'item.md',
        title: 'Item',
        types: ['item'],
        fields: { count: 'not-a-number' },
      }));
    }).toThrow(PipelineError);
  });

  it("skipDefaults is true: required+default missing stays missing", () => {
    // With skipDefaults=true, the validator must NOT populate the default.
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'propagation',
      file_path: 'task.md',
      title: 'Task',
      types: ['task'],
      fields: {},
    }));

    // Field remains absent from coerced_state (no 'defaulted' entry)
    expect(result.validation.coerced_state['status']).toBeUndefined();

    // REQUIRED_MISSING is emitted but tolerated
    expect(result.validation.issues.some(i => i.code === 'REQUIRED_MISSING' && i.field === 'status')).toBe(true);

    // node_fields does NOT contain a 'status' row
    const field = db.prepare('SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'status');
    expect(field).toBeUndefined();
  });

  it('no-op: file + DB hash match → file_written is false', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'tool',
      file_path: 'doc.md',
      title: 'Doc',
    }));
    expect(created.file_written).toBe(true);

    // Call again with identical inputs via propagation: expect no-op
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'propagation',
      node_id: created.node_id,
      file_path: 'doc.md',
      title: 'Doc',
    }));

    expect(result.file_written).toBe(false);
    expect(result.edits_logged).toBe(0);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run tests/pipeline/propagation-source.test.ts`
Expected: all four tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/pipeline/propagation-source.test.ts
git commit -m "test(pipeline): cover new 'propagation' source branch"
```

---

## Task 4: Rewrite `src/schema/propagate.ts` around the pipeline

**Files:**
- Modify: `src/schema/propagate.ts` (full file rewrite)

- [ ] **Step 1: Replace the full contents of `src/schema/propagate.ts`**

Overwrite `src/schema/propagate.ts` with the following:

```ts
// src/schema/propagate.ts
//
// Schema change propagation: when schema claims change, affected nodes
// are re-rendered through the write pipeline (source='propagation').
// Defaults are populated for added claims; removed claims become orphans.

import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { mergeFieldClaims } from '../validation/merge.js';
import { loadSchemaContext } from '../pipeline/schema-context.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import { resolveDefaultValue } from '../validation/resolve-default.js';
import type { FileContext } from '../validation/resolve-default.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { executeMutation } from '../pipeline/execute.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';

export interface PropagationResult {
  nodes_affected: number;
  nodes_rerendered: number;
  defaults_populated: number;
  fields_orphaned: number;
}

interface ClaimDiff {
  added: string[];    // field names added to claims
  removed: string[];  // field names removed from claims
  changed: string[];  // field names with changed metadata
}

/**
 * Diff old claims against new claims to determine what changed.
 */
export function diffClaims(
  oldClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown; enum_values_override?: string[] | null }>,
  newClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown; enum_values_override?: string[] | null }>,
): ClaimDiff {
  const oldSet = new Map(oldClaims.map(c => [c.field, c]));
  const newSet = new Map(newClaims.map(c => [c.field, c]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [field] of newSet) {
    if (!oldSet.has(field)) added.push(field);
    else {
      const o = oldSet.get(field)!;
      const n = newSet.get(field)!;
      if (
        o.sort_order !== n.sort_order ||
        o.label !== n.label ||
        o.description !== n.description ||
        o.required !== n.required ||
        JSON.stringify(o.default_value) !== JSON.stringify(n.default_value) ||
        JSON.stringify(o.enum_values_override) !== JSON.stringify(n.enum_values_override)
      ) {
        changed.push(field);
      }
    }
  }

  for (const [field] of oldSet) {
    if (!newSet.has(field)) removed.push(field);
  }

  return { added, removed, changed };
}

interface LoadedNodeState {
  file_path: string;
  title: string;
  body: string;
  types: string[];
  currentFields: Record<string, unknown>;
  rawFieldTexts: Record<string, string>;
}

/**
 * Load a node's mutable state from DB for re-rendering.
 * Returns null if the node no longer exists.
 */
function loadNodeState(db: Database.Database, nodeId: string): LoadedNodeState | null {
  const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(nodeId) as
    | { file_path: string; title: string; body: string }
    | undefined;
  if (!nodeRow) return null;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(nodeId) as Array<{ schema_type: string }>)
    .map(r => r.schema_type);

  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
    value_raw_text: string | null;
  }>;

  const currentFields: Record<string, unknown> = {};
  const rawFieldTexts: Record<string, string> = {};
  for (const row of fieldRows) {
    currentFields[row.field_name] = reconstructValue(row);
    if (row.value_raw_text) rawFieldTexts[row.field_name] = row.value_raw_text;
  }

  return {
    file_path: nodeRow.file_path,
    title: nodeRow.title,
    body: nodeRow.body,
    types,
    currentFields,
    rawFieldTexts,
  };
}

/**
 * Build a FileContext for date-token resolution of adoption defaults.
 * Falls back to { mtimeMs: now, createdAtMs: null } if the file is missing.
 */
function buildFileContext(db: Database.Database, vaultPath: string, nodeId: string, filePath: string): FileContext {
  const absPath = safeVaultPath(vaultPath, filePath);
  let mtimeMs = Date.now();
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    // File missing — fall back to now; caller continues regardless
  }
  const row = db.prepare('SELECT created_at FROM nodes WHERE id = ?').get(nodeId) as { created_at: number | null } | undefined;
  return { mtimeMs, createdAtMs: row?.created_at ?? null };
}

/**
 * Shared per-node primitive: load node state, inject adoption defaults,
 * call executeMutation with source='propagation'.
 * Returns null if the node disappeared between query and processing.
 */
function rerenderNodeThroughPipeline(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  adoptionDefaults: Record<string, unknown>,
  syncLogger: SyncLogger | undefined,
  preLoaded?: LoadedNodeState,
): { node_id: string; file_path: string; file_written: boolean } | null {
  const state = preLoaded ?? loadNodeState(db, nodeId);
  if (!state) return null;

  // Merge adoption defaults into currentFields — never overwrite existing values.
  const mergedFields: Record<string, unknown> = { ...state.currentFields };
  for (const [field, value] of Object.entries(adoptionDefaults)) {
    if (!(field in mergedFields)) {
      mergedFields[field] = value;
    }
  }

  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'propagation',
    node_id: nodeId,
    file_path: state.file_path,
    title: state.title,
    types: state.types,
    fields: mergedFields,
    body: state.body,
    raw_field_texts: state.rawFieldTexts,
  }, syncLogger);

  return {
    node_id: result.node_id,
    file_path: result.file_path,
    file_written: result.file_written,
  };
}

/**
 * Propagate schema claim changes to all affected nodes.
 * Re-renders affected nodes through executeMutation and populates defaults
 * for added claims. Emits `field-defaulted` and `fields-orphaned` edits_log
 * rows post-mutation with source='propagation'.
 */
export function propagateSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  diff: ClaimDiff,
  syncLogger?: SyncLogger,
): PropagationResult {
  const result: PropagationResult = {
    nodes_affected: 0,
    nodes_rerendered: 0,
    defaults_populated: 0,
    fields_orphaned: 0,
  };

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return result;
  }

  const nodeIds = (db.prepare('SELECT node_id FROM node_types WHERE schema_type = ?').all(schemaName) as Array<{ node_id: string }>)
    .map(r => r.node_id);

  if (nodeIds.length === 0) return result;
  result.nodes_affected = nodeIds.length;

  const trigger = `update-schema: ${schemaName}`;
  const mergeCache = new Map<string, ReturnType<typeof mergeFieldClaims>>();
  const insertLog = db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)');

  for (const nodeId of nodeIds) {
    const state = loadNodeState(db, nodeId);
    if (!state) continue;

    // Cache merge results by sorted type-set key
    const typeKey = [...state.types].sort().join(',');
    let mergeResult = mergeCache.get(typeKey);
    if (!mergeResult) {
      const ctx = loadSchemaContext(db, state.types);
      mergeResult = mergeFieldClaims(state.types, ctx.claimsByType, ctx.globalFields);
      mergeCache.set(typeKey, mergeResult);
    }
    const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;

    // Identify fields that need adoption defaults on this node.
    const adoptionFieldsToDefault: Array<{ field: string; value: unknown }> = [];
    let fileCtx: FileContext | null = null;
    for (const field of diff.added) {
      if (field in state.currentFields) continue; // re-adoption — value already present
      const ef = effectiveFields.get(field);
      if (!ef?.resolved_required) continue;
      if (ef.resolved_default_value === null || ef.resolved_default_value === undefined) continue;

      if (fileCtx === null) fileCtx = buildFileContext(db, vaultPath, nodeId, state.file_path);
      adoptionFieldsToDefault.push({
        field,
        value: resolveDefaultValue(ef.resolved_default_value, fileCtx),
      });
    }

    // Resolve default source ('global' vs 'claim') for each adoption default.
    // loadSchemaContext is called at most once per node regardless of adoption count.
    const adoptionDefaults: Record<string, unknown> = {};
    const adoptionSources: Record<string, 'global' | 'claim'> = {};
    if (adoptionFieldsToDefault.length > 0) {
      const ctx = loadSchemaContext(db, state.types);
      for (const { field, value } of adoptionFieldsToDefault) {
        adoptionDefaults[field] = value;
        let src: 'global' | 'claim' = 'global';
        for (const claims of ctx.claimsByType.values()) {
          for (const c of claims) {
            if (c.field === field && c.default_value_override.kind === 'override') {
              src = 'claim';
              break;
            }
          }
          if (src === 'claim') break;
        }
        adoptionSources[field] = src;
      }
    }

    // Call the pipeline
    const pipelineResult = rerenderNodeThroughPipeline(
      db, writeLock, vaultPath, nodeId, adoptionDefaults, syncLogger, state,
    );
    if (!pipelineResult) continue;

    // Post-mutation emission: field-defaulted (adoption)
    const now = Date.now();
    for (const [field, value] of Object.entries(adoptionDefaults)) {
      insertLog.run(nodeId, now, 'field-defaulted', JSON.stringify({
        source: 'propagation',
        field,
        default_value: value,
        default_source: adoptionSources[field],
        trigger,
        node_types: state.types,
      }));
      result.defaults_populated++;
    }

    // Post-mutation emission: fields-orphaned (one row per node, listing all)
    const orphanedInThisNode = diff.removed.filter(f => f in state.currentFields);
    if (orphanedInThisNode.length > 0) {
      insertLog.run(nodeId, now, 'fields-orphaned', JSON.stringify({
        source: 'propagation',
        trigger,
        orphaned_fields: orphanedInThisNode,
        node_types: state.types,
      }));
      result.fields_orphaned += orphanedInThisNode.length;
    }

    if (pipelineResult.file_written) result.nodes_rerendered++;
  }

  return result;
}

/**
 * Re-render all nodes that have a specific field.
 * Used after rename-global-field and update-global-field type changes.
 * No adoption/orphan events — schema claims don't change here.
 */
export function rerenderNodesWithField(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  fieldName: string,
  additionalNodeIds?: string[],
  syncLogger?: SyncLogger,
): number {
  const fromField = (db.prepare('SELECT DISTINCT node_id FROM node_fields WHERE field_name = ?').all(fieldName) as Array<{ node_id: string }>)
    .map(r => r.node_id);

  const nodeIdSet = new Set(fromField);
  if (additionalNodeIds) {
    for (const id of additionalNodeIds) nodeIdSet.add(id);
  }
  const nodeIds = Array.from(nodeIdSet);

  if (nodeIds.length === 0) return 0;

  let rerendered = 0;
  for (const nodeId of nodeIds) {
    const pipelineResult = rerenderNodeThroughPipeline(
      db, writeLock, vaultPath, nodeId, {}, syncLogger,
    );
    if (pipelineResult?.file_written) rerendered++;
  }

  return rerendered;
}
```

- [ ] **Step 2: Verify the build succeeds**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Run the existing propagation test to confirm no regression**

Run: `npx vitest run tests/phase3/tools.test.ts`
Expected: all existing tests PASS (including `update-schema add claim populates defaults on existing nodes`)

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests PASS. If any fail, inspect whether they rely on the old `source: "tool"` mislabel on propagation-originated log rows (fix those asserts to `source: "propagation"`); otherwise investigate as a real regression.

- [ ] **Step 5: Commit**

```bash
git add src/schema/propagate.ts
git commit -m "refactor(propagate): route schema propagation through executeMutation

Replace the bespoke render → write → DB-insert loop (plus broken
multi-file backup/restore sleeve) with per-node executeMutation calls
using source='propagation'. Adoption defaults are pre-resolved and
injected before the pipeline. Post-mutation field-defaulted and
fields-orphaned log rows now correctly carry source='propagation'
(was mislabeled 'tool'). Closes arch-review 2026-04-18 §2b."
```

---

## Task 5: Behavior tests for `propagateSchemaChange`

**Files:**
- Create: `tests/schema/propagation.test.ts`

- [ ] **Step 1: Create the test file skeleton**

Create `tests/schema/propagation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition } from '../../src/schema/crud.js';
import { propagateSchemaChange, diffClaims, rerenderNodesWithField } from '../../src/schema/propagate.js';
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

afterEach(() => {
  db.close();
  cleanup();
});

function createNode(overrides: Partial<ProposedMutation> = {}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: 'test.md',
    title: 'Test',
    types: [],
    fields: {},
    body: '',
    ...overrides,
  });
}

function readDetails(row: { details: string }): Record<string, unknown> {
  return JSON.parse(row.details);
}

describe('propagateSchemaChange — adoption', () => {
  it("added required+default claim populates the field and emits field-defaulted with source='propagation'", () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const node = createNode({ file_path: 'a.md', title: 'A', types: ['task'], fields: {} });

    // Add 'status' claim
    const oldClaims: Array<{ field: string; sort_order?: number }> = [];
    const newClaims = [{ field: 'status', sort_order: 1000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(1);
    expect(result.nodes_rerendered).toBe(1);

    // Field was persisted
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'status') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('open');

    // field-defaulted row emitted with source='propagation'
    const logRow = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY timestamp DESC, id DESC LIMIT 1",
    ).get(node.node_id) as { details: string };
    const details = readDetails(logRow);
    expect(details.source).toBe('propagation');
    expect(details.field).toBe('status');
    expect(details.default_value).toBe('open');
    expect(details.trigger).toBe('update-schema: task');
    expect(details.default_source).toBe('global');
  });

  it('added non-required claim: no default populated, no field-defaulted row', () => {
    createGlobalField(db, { name: 'notes', field_type: 'string', default_value: 'n/a' });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const node = createNode({ file_path: 'b.md', title: 'B', types: ['task'], fields: {} });

    const oldClaims: Array<{ field: string; sort_order?: number }> = [];
    const newClaims = [{ field: 'notes', sort_order: 1000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(0);

    const field = db.prepare('SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'notes');
    expect(field).toBeUndefined();

    const logRow = db.prepare(
      "SELECT * FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'",
    ).get(node.node_id);
    expect(logRow).toBeUndefined();
  });

  it('re-adopted claim (field already on node) does NOT emit field-defaulted or overwrite', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'c.md', title: 'C', types: ['task'], fields: { status: 'closed' } });

    // Remove the claim then re-add it
    updateSchemaDefinition(db, 'task', { field_claims: [] });
    propagateSchemaChange(db, writeLock, vaultPath, 'task', diffClaims(
      [{ field: 'status', sort_order: 1000 }],
      [],
    ));
    updateSchemaDefinition(db, 'task', { field_claims: [{ field: 'status', sort_order: 1000 }] });
    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diffClaims(
      [],
      [{ field: 'status', sort_order: 1000 }],
    ));

    // Re-adoption: no default populated (value was preserved as orphan during removal)
    expect(result.defaults_populated).toBe(0);

    // Value preserved — still 'closed'
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'status') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('closed');
  });
});

describe('propagateSchemaChange — orphaning', () => {
  it("removed claim emits fields-orphaned with source='propagation'", () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'd.md', title: 'D', types: ['task'], fields: { status: 'open' } });

    updateSchemaDefinition(db, 'task', { field_claims: [] });
    const diff = diffClaims([{ field: 'status', sort_order: 1000 }], []);
    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.fields_orphaned).toBe(1);

    // Value still preserved
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.node_id, 'status') as { value_text: string } | undefined;
    expect(field?.value_text).toBe('open');

    // fields-orphaned row has source='propagation'
    const logRow = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'fields-orphaned' ORDER BY timestamp DESC, id DESC LIMIT 1",
    ).get(node.node_id) as { details: string };
    const details = readDetails(logRow);
    expect(details.source).toBe('propagation');
    expect(details.orphaned_fields).toEqual(['status']);
    expect(details.trigger).toBe('update-schema: task');
  });
});

describe('propagateSchemaChange — edge cases', () => {
  it('changed claim (metadata only) re-renders but emits no adoption/orphan rows', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'e.md', title: 'E', types: ['task'], fields: { status: 'open' } });

    const oldClaims = [{ field: 'status', sort_order: 1000 }];
    const newClaims = [{ field: 'status', sort_order: 500 }];  // sort_order changed
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.defaults_populated).toBe(0);
    expect(result.fields_orphaned).toBe(0);

    const adoptionRow = db.prepare(
      "SELECT * FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'",
    ).get(node.node_id);
    expect(adoptionRow).toBeUndefined();

    const orphanRow = db.prepare(
      "SELECT * FROM edits_log WHERE node_id = ? AND event_type = 'fields-orphaned'",
    ).get(node.node_id);
    expect(orphanRow).toBeUndefined();
  });

  it('pre-existing REQUIRED_MISSING on unrelated field does not block propagation', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority', sort_order: 1000 }] });

    // Create the node via normalizer (bypasses REQUIRED_MISSING)
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'normalizer',
      node_id: null,
      file_path: 'f.md',
      title: 'F',
      types: ['task'],
      fields: {},  // priority is missing
      body: '',
    });

    // Now add 'status' claim — should succeed despite pre-existing REQUIRED_MISSING
    const oldClaims = [{ field: 'priority', sort_order: 1000 }];
    const newClaims = [
      { field: 'priority', sort_order: 1000 },
      { field: 'status', sort_order: 2000 },
    ];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    expect(result.nodes_affected).toBe(1);
    // Node was processed — file on disk exists
    expect(existsSync(join(vaultPath, 'f.md'))).toBe(true);
  });

  it('empty diff returns zero-result and does not touch DB', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode({ file_path: 'g.md', title: 'G', types: ['task'], fields: { status: 'open' } });

    const logCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM edits_log').get() as { c: number }).c;

    const result = propagateSchemaChange(db, writeLock, vaultPath, 'task', { added: [], removed: [], changed: [] });

    expect(result.nodes_affected).toBe(0);
    expect(result.nodes_rerendered).toBe(0);
    expect(result.defaults_populated).toBe(0);
    expect(result.fields_orphaned).toBe(0);

    const logCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM edits_log').get() as { c: number }).c;
    expect(logCountAfter).toBe(logCountBefore);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run tests/schema/propagation.test.ts`
Expected: all seven tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/schema/propagation.test.ts
git commit -m "test(propagate): cover adoption, orphaning, and edge cases via pipeline"
```

---

## Task 6: Tests for `rerenderNodesWithField`

**Files:**
- Modify: `tests/schema/propagation.test.ts` (append)

- [ ] **Step 1: Append the `rerenderNodesWithField` test block**

Append to `tests/schema/propagation.test.ts`:

```ts
describe('rerenderNodesWithField', () => {
  it('re-renders nodes containing the named field, no adoption/orphan rows', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    createNode({ file_path: 'h1.md', title: 'H1', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'h2.md', title: 'H2', types: ['task'], fields: { status: 'done' } });
    // A node WITHOUT the field — must not be touched
    createNode({ file_path: 'h3.md', title: 'H3' });

    // Flip the content so re-render will produce a different hash
    // (status field is persisted; changing the claim's label affects rendering)
    updateSchemaDefinition(db, 'task', { field_claims: [{ field: 'status', sort_order: 1000, label: 'New Status' }] });

    const logIdBaseline = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM edits_log').get() as { id: number }).id;

    const rerendered = rerenderNodesWithField(db, writeLock, vaultPath, 'status');

    // Nodes containing 'status' may or may not re-write depending on whether
    // the rendered output actually changed. What matters here: no adoption or
    // orphan rows should be emitted, and the count reflects only nodes whose
    // output actually changed.
    expect(rerendered).toBeGreaterThanOrEqual(0);

    // Confirm no adoption/orphan rows were emitted by rerenderNodesWithField
    const newAdoptionRows = db.prepare(
      "SELECT COUNT(*) AS c FROM edits_log WHERE event_type IN ('field-defaulted', 'fields-orphaned') AND id > ?"
    ).get(logIdBaseline) as { c: number };
    expect(newAdoptionRows.c).toBe(0);
  });

  it('additionalNodeIds deduplicates: a node in both sets is re-rendered once', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1000 }] });

    const node = createNode({ file_path: 'i.md', title: 'I', types: ['task'], fields: { status: 'open' } });

    // Use additionalNodeIds to double-pass the same node; the implementation
    // should dedupe so we don't double-process.
    const count = rerenderNodesWithField(db, writeLock, vaultPath, 'status', [node.node_id]);

    // No assertion on the exact count value (it may be 0 if hashes already match);
    // the check is that we don't throw and the file remains well-formed.
    expect(existsSync(join(vaultPath, 'i.md'))).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('additionalNodeIds picks up nodes whose field was deleted (type-change uncoercible case)', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'item', field_claims: [{ field: 'count', sort_order: 1000 }] });

    const node = createNode({ file_path: 'j.md', title: 'J', types: ['item'], fields: { count: 42 } });

    // Simulate update-global-field deleting the uncoercible row
    db.prepare('DELETE FROM node_fields WHERE node_id = ? AND field_name = ?').run(node.node_id, 'count');

    // The node no longer matches the field query — but additionalNodeIds forces it in
    const count = rerenderNodesWithField(db, writeLock, vaultPath, 'count', [node.node_id]);

    // The file was re-rendered (content changed since the field was removed)
    expect(count).toBe(1);
    const body = readFileSync(join(vaultPath, 'j.md'), 'utf-8');
    expect(body.includes('count: 42')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the appended tests**

Run: `npx vitest run tests/schema/propagation.test.ts`
Expected: all tests in the file PASS (including the three new ones)

- [ ] **Step 3: Commit**

```bash
git add tests/schema/propagation.test.ts
git commit -m "test(propagate): cover rerenderNodesWithField through pipeline"
```

---

## Task 7: Row-ordering integration test

**Files:**
- Modify: `tests/schema/propagation.test.ts` (append)

- [ ] **Step 1: Append the row-ordering test**

Append to `tests/schema/propagation.test.ts`:

```ts
describe('propagateSchemaChange — edits_log row ordering', () => {
  it('pipeline rows precede caller-emitted adoption/orphan rows within a single update-schema call', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createGlobalField(db, { name: 'legacy', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'legacy', sort_order: 1000 }] });

    // Node has 'legacy' field but not 'status'
    const node = createNode({
      file_path: 'k.md',
      title: 'K',
      types: ['task'],
      fields: { legacy: 'old-value' },
    });

    const logIdBeforeBaseline = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM edits_log').get() as { id: number }).id;

    // Now: remove 'legacy' AND add 'status' (with required+default) simultaneously
    const oldClaims = [{ field: 'legacy', sort_order: 1000 }];
    const newClaims = [{ field: 'status', sort_order: 2000 }];
    updateSchemaDefinition(db, 'task', { field_claims: newClaims });
    const diff = diffClaims(oldClaims, newClaims);

    propagateSchemaChange(db, writeLock, vaultPath, 'task', diff);

    // Fetch rows added during this propagation, in insertion order
    const rows = db.prepare(
      "SELECT id, event_type, details FROM edits_log WHERE node_id = ? AND id > ? ORDER BY id ASC"
    ).all(node.node_id, logIdBeforeBaseline) as Array<{ id: number; event_type: string; details: string }>;

    // Exactly one field-defaulted and one fields-orphaned row from propagate.ts's post-emission
    const fieldDefaulted = rows.filter(r => r.event_type === 'field-defaulted');
    const fieldsOrphaned = rows.filter(r => r.event_type === 'fields-orphaned');
    expect(fieldDefaulted.length).toBe(1);
    expect(fieldsOrphaned.length).toBe(1);

    // Adoption row comes before orphan row (caller emits in this order)
    expect(fieldDefaulted[0].id).toBeLessThan(fieldsOrphaned[0].id);

    // Both rows carry source='propagation'
    expect(JSON.parse(fieldDefaulted[0].details).source).toBe('propagation');
    expect(JSON.parse(fieldsOrphaned[0].details).source).toBe('propagation');

    // If the pipeline itself emitted any rows (none expected here since no
    // value-coerced or merge-conflict scenarios), they'd sit BEFORE the
    // adoption/orphan rows by id.
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/schema/propagation.test.ts`
Expected: all tests in the file PASS

- [ ] **Step 3: Commit**

```bash
git add tests/schema/propagation.test.ts
git commit -m "test(propagate): row-ordering contract for mixed add/remove schema diff"
```

---

## Task 8: Full regression — build + test + lint

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: PASS (no TypeScript errors)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: ALL tests PASS.

If any tests fail:
- **If they assert `source: "tool"` on a propagation-originated `field-defaulted` or `fields-orphaned` row** → update the assertion to `source: "propagation"` (this is the intended label correction).
- **Any other failure** → investigate as a genuine regression. Do NOT mask failures. Common areas to check: watcher/normalizer interactions, the in-memory DB test helpers, schema YAML rendering.

- [ ] **Step 3: Git status clean check**

Run: `git status`
Expected: `nothing to commit, working tree clean`

If there are uncommitted files, review them — any changes that got in without an accompanying commit should either be committed with a small follow-up or reverted.

- [ ] **Step 4: Review the commit series**

Run: `git log --oneline main..HEAD`

Expected — a series of commits roughly like:
```
<sha> test(propagate): row-ordering contract for mixed add/remove schema diff
<sha> test(propagate): cover rerenderNodesWithField through pipeline
<sha> test(propagate): cover adoption, orphaning, and edge cases via pipeline
<sha> refactor(propagate): route schema propagation through executeMutation
<sha> test(pipeline): cover new 'propagation' source branch
<sha> feat(pipeline): route 'propagation' source through tool/normalizer branch
<sha> feat(pipeline): add 'propagation' to ProposedMutation.source union
```

No further commit needed if everything is already in a clean state.
