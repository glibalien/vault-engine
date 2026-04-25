# Uniform `dry_run` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a uniform `dry_run: false` (default) parameter to four mutation tools — `delete-node`, `add-type-to-node`, `remove-type-from-node`, `batch-mutate` — so callers can preview without applying.

**Architecture:** Per-tool inline preview branches that short-circuit before pipeline mutation. `delete-node` / `remove-type-from-node` reuse existing `confirm:false` preview shapes with a `dry_run: true` flag added. `add-type-to-node` builds a new preview using `loadSchemaContext` + `validateProposedState` (mirrors `create-node`'s dry-run pattern). `batch-mutate` uses a transaction-and-rollback approach with `db_only: true` on update mutations, `unlink_file: false` on delete ops, undo-op gating, file-backup gating, and a `DryRunRollback` sentinel error to force the txn to roll back after collecting per-op preview entries.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Zod, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-04-25-uniform-dry-run-design.md`

---

## File Structure

**Source files modified (existing, no new files):**
- `src/mcp/tools/delete-node.ts` — add `dry_run` param, wrap preview branch.
- `src/mcp/tools/remove-type-from-node.ts` — add `dry_run` param, generalize preview branch beyond last-type case.
- `src/mcp/tools/add-type-to-node.ts` — add `dry_run` param, new preview branch.
- `src/mcp/tools/batch-mutate.ts` — add `dry_run` param, `DryRunRollback` sentinel class, undo/backup gating, `would_apply` collection, txn rollback handling.

**Test files added (new, in `tests/mcp/`):**
- `tests/mcp/delete-node-dry-run.test.ts`
- `tests/mcp/remove-type-from-node-dry-run.test.ts`
- `tests/mcp/add-type-to-node-dry-run.test.ts`
- `tests/mcp/batch-mutate-dry-run.test.ts`

The MCP-handler test pattern (per `tests/mcp/batch-mutate-directory.test.ts`) is the right style: register the tool against a fake `McpServer`, capture the handler, call it directly, parse the JSON response.

---

## Reference: existing patterns to follow

- **`dry_run` precedent:** `src/mcp/tools/create-node.ts:29` (param shape) and `:116` (preview return); `src/mcp/tools/update-node.ts:91, 274` (single-node mode).
- **MCP test harness:** `tests/mcp/batch-mutate-directory.test.ts:1-55` — `parseResult`, `getHandler`, `createTempVault`, `addUndoTables`, `createSchemaDefinition`.
- **Pipeline flags:** `src/pipeline/types.ts:19` (`db_only?: boolean`), `src/pipeline/delete.ts:12` (`unlink_file: boolean`).
- **Undo wiring:** `src/undo/operation.ts` exports `createOperation`, `finalizeOperation`. The `operation_id` is passed via the `{ operation_id }` option to `executeMutation` / `executeDeletion`. Pass `undefined` to skip snapshot capture.

---

## Task 1: `delete-node` dry_run

**Files:**
- Modify: `src/mcp/tools/delete-node.ts`
- Create: `tests/mcp/delete-node-dry-run.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/delete-node-dry-run.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { executeMutation } from '../../src/pipeline/execute.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

interface Response {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  warnings: Array<{ code: string; message: string; severity?: string }>;
}

function parseResult(result: unknown): Response {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Response;
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerDeleteNode(fakeServer, db, writeLock, vaultPath);
  return captured!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  writeLock = new WriteLockManager();
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

describe('delete-node dry_run', () => {
  it('dry_run: true returns preview with dry_run flag and does not delete', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'A.md',
      title: 'A', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ node_id: created.node_id, dry_run: true }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.node_id).toBe(created.node_id);
    expect(result.data?.file_path).toBe('A.md');
    // Side-effect checks: file present, DB row present, no undo op recorded.
    expect(existsSync(join(vaultPath, 'A.md'))).toBe(true);
    const dbRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(created.node_id);
    expect(dbRow).toBeDefined();
    const undoRows = db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number };
    expect(undoRows.c).toBe(0);
  });

  it('dry_run: true wins over confirm: true (still previews)', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'B.md',
      title: 'B', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ node_id: created.node_id, dry_run: true, confirm: true }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(existsSync(join(vaultPath, 'B.md'))).toBe(true);
  });

  it('dry_run omitted (default false): existing behavior unchanged', async () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'C.md',
      title: 'C', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    // confirm:false → existing preview shape (no dry_run field)
    const previewResult = parseResult(await handler({ node_id: created.node_id }));
    expect(previewResult.ok).toBe(true);
    expect(previewResult.data?.dry_run).toBeUndefined();
    expect(previewResult.data?.preview).toBe(true);

    // confirm:true → actual deletion
    const deleteResult = parseResult(await handler({ node_id: created.node_id, confirm: true }));
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.data?.deleted).toBe(true);
    expect(existsSync(join(vaultPath, 'C.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/delete-node-dry-run.test.ts`
Expected: tests fail because `dry_run` is unrecognized in the schema and the response doesn't carry `dry_run: true`.

- [ ] **Step 3: Modify `src/mcp/tools/delete-node.ts`**

Find this block (around `paramsShape`):

```ts
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  confirm: z.boolean().default(false),
  referencing_nodes_limit: z.number().default(20),
};
```

Replace with:

```ts
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  confirm: z.boolean().default(false),
  dry_run: z.boolean().default(false),
  referencing_nodes_limit: z.number().default(20),
};
```

Find the `if (!params.confirm) { ... return ok({...}, warnings); }` block. Replace its condition and add the `dry_run: true` flag when `params.dry_run` is set:

```ts
if (params.dry_run || !params.confirm) {
  const referencing_nodes = incomingRels.slice(0, params.referencing_nodes_limit).map(r => ({
    node_id: r.source_id,
    title: r.title,
    field: r.rel_type,
  }));
  const warnings: Issue[] = [];
  if (incomingCount.c > 0) {
    warnings.push({
      code: 'PENDING_REFERENCES',
      severity: 'warning',
      message: `${incomingCount.c} other node(s) reference this node. Deletion will leave dangling references.`,
      details: { incoming_reference_count: incomingCount.c, referencing_nodes },
    });
  }
  const payload: Record<string, unknown> = {
    preview: true,
    node_id: node.node_id,
    file_path: node.file_path,
    title: node.title,
    types,
    field_count: fieldCount,
    relationship_count: outRels,
    incoming_reference_count: incomingCount.c,
    referencing_nodes,
  };
  if (params.dry_run) payload.dry_run = true;
  return ok(payload, warnings);
}
```

Update the tool description (find `'Delete a node and its file. Without confirm: true, returns a preview showing referencing nodes.'`) to:

```ts
'Delete a node and its file. Without confirm: true, returns a preview showing referencing nodes. Use dry_run: true to preview without applying. dry_run is independent of confirm — dry_run: true always previews.',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/delete-node-dry-run.test.ts`
Expected: all three tests pass.

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: pass. If `tests/phase3/tools.test.ts` or any other delete-node test fails, restore behavior — the live path is supposed to be unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/delete-node.ts tests/mcp/delete-node-dry-run.test.ts
git commit -m "feat(mcp): add dry_run to delete-node"
```

---

## Task 2: `remove-type-from-node` dry_run

**Files:**
- Modify: `src/mcp/tools/remove-type-from-node.ts`
- Create: `tests/mcp/remove-type-from-node-dry-run.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/remove-type-from-node-dry-run.test.ts`. Use the same harness scaffolding as Task 1 (copy `parseResult`, `getHandler` adapted for `registerRemoveTypeFromNode`, the `beforeEach`/`afterEach`). Then:

```ts
describe('remove-type-from-node dry_run', () => {
  it('dry_run: true on non-last-type returns preview without mutation', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    createSchemaDefinition(db, { name: 'b', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'X.md',
      title: 'X', types: ['a', 'b'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ node_id: created.node_id, type: 'a', dry_run: true }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.current_types).toEqual(['a', 'b']);
    expect(result.data?.removing_type).toBe('a');
    expect(result.data?.resulting_types).toEqual(['b']);
    // Live state unchanged
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(created.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types.sort()).toEqual(['a', 'b']);
  });

  it('dry_run: true on last-type emits LAST_TYPE_REMOVAL warning', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Y.md',
      title: 'Y', types: ['a'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ node_id: created.node_id, type: 'a', dry_run: true }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.warnings.some(w => w.code === 'LAST_TYPE_REMOVAL')).toBe(true);
  });

  it('dry_run: true does not record an undo operation', async () => {
    createSchemaDefinition(db, { name: 'a', field_claims: [] });
    createSchemaDefinition(db, { name: 'b', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Z.md',
      title: 'Z', types: ['a', 'b'], fields: {}, body: '',
    });
    const handler = getHandler();
    await handler({ node_id: created.node_id, type: 'a', dry_run: true });
    const undoCount = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;
    expect(undoCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/remove-type-from-node-dry-run.test.ts`
Expected: failures because `dry_run` param is unrecognized and the non-last-type case returns the live deletion result rather than a preview.

- [ ] **Step 3: Implement**

In `src/mcp/tools/remove-type-from-node.ts`:

Add `dry_run: z.boolean().default(false)` to `paramsShape`:

```ts
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  confirm: z.boolean().default(false),
  dry_run: z.boolean().default(false),
};
```

Insert a new dry-run preview branch immediately after `wouldOrphanFields` is computed (currently around line 70) and **before** the existing last-type confirmation gate (currently around line 72-94):

```ts
if (params.dry_run) {
  const warnings: Issue[] = [];
  if (resultingTypes.length === 0) {
    warnings.push({
      code: 'LAST_TYPE_REMOVAL',
      severity: 'warning',
      message: 'Removing this type leaves the node with no types. All fields will become orphans.',
      details: { would_orphan_fields: wouldOrphanFields },
    });
  }
  return ok(
    {
      dry_run: true,
      node_id: node.node_id,
      file_path: node.file_path,
      current_types: currentTypes,
      removing_type: params.type,
      resulting_types: resultingTypes,
      would_orphan_fields: wouldOrphanFields,
    },
    warnings,
  );
}
```

The existing last-type confirmation gate stays untouched — it fires only when `dry_run: false` and `resultingTypes.length === 0` and `!confirm`. No `createOperation`/`finalizeOperation` happens on the dry-run path because the function returns before line 105.

Append to the tool description:

```ts
'Remove a type from a node, orphaning its exclusively-claimed fields. Requires confirm: true when removing the last type. Use dry_run: true to preview the removal and orphaned fields without applying.'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/remove-type-from-node-dry-run.test.ts`
Expected: all three pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: pass. The live path (no `dry_run` set) is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/remove-type-from-node.ts tests/mcp/remove-type-from-node-dry-run.test.ts
git commit -m "feat(mcp): add dry_run to remove-type-from-node"
```

---

## Task 3: `add-type-to-node` dry_run

**Files:**
- Modify: `src/mcp/tools/add-type-to-node.ts`
- Create: `tests/mcp/add-type-to-node-dry-run.test.ts`

- [ ] **Step 1: Read the existing tool and the create-node dry_run pattern**

Read `src/mcp/tools/add-type-to-node.ts` end-to-end. Then read `src/mcp/tools/create-node.ts:90-130` to see the `loadSchemaContext` + `validateProposedState` pattern; this is the model for the new branch.

- [ ] **Step 2: Write the failing test**

Create `tests/mcp/add-type-to-node-dry-run.test.ts` using the same harness as Task 1 (adapted for `registerAddTypeToNode`):

```ts
describe('add-type-to-node dry_run', () => {
  it('dry_run: true returns preview with would_add_fields', async () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', default_value: 'normal' });
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'T.md',
      title: 'T', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ node_id: created.node_id, type: 'task', dry_run: true }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.would_be_no_op).toBe(false);
    expect(result.data?.types).toEqual(expect.arrayContaining(['note', 'task']));
    expect(result.data?.would_add_fields).toEqual(expect.objectContaining({ priority: 'normal' }));

    // Live state unchanged
    const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(created.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
    expect(types).toEqual(['note']);
  });

  it('dry_run: true on already-present type returns would_be_no_op: true', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'N.md',
      title: 'N', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    const result = parseResult(await handler({ node_id: created.node_id, type: 'note', dry_run: true }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.would_be_no_op).toBe(true);
    expect(result.data?.types).toEqual(['note']);
  });

  it('dry_run: true does not record an undo operation', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'U.md',
      title: 'U', types: ['note'], fields: {}, body: '',
    });
    const handler = getHandler();
    await handler({ node_id: created.node_id, type: 'task', dry_run: true });
    const undoCount = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;
    expect(undoCount).toBe(0);
  });
});
```

You'll also need `import { createGlobalField } from '../../src/global-fields/crud.js';` at the top.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/mcp/add-type-to-node-dry-run.test.ts`
Expected: failures.

- [ ] **Step 4: Implement**

Add the imports near the top of `src/mcp/tools/add-type-to-node.ts`:

```ts
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
```

Add `dry_run: z.boolean().default(false)` to `paramsShape`:

```ts
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  dry_run: z.boolean().default(false),
};
```

Modify the already-present early-return block (currently lines 69-78) to short-circuit dry-run with the no-op shape:

```ts
if (currentTypes.includes(params.type)) {
  if (params.dry_run) {
    return ok({ dry_run: true, would_be_no_op: true, types: currentTypes });
  }
  return ok({
    node_id: node.node_id,
    file_path: node.file_path,
    types: currentTypes,
    added_fields: [],
    readopted_fields: [],
    already_present: true,
  });
}
```

After the `mergedFields` computation (currently line 105) and **before** `createOperation` (currently line 107), insert the dry-run preview branch:

```ts
if (params.dry_run) {
  const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
  const validation = validateProposedState(mergedFields, newTypes, claimsByType, globalFields);
  const wouldAddFields = populated.reduce<Record<string, unknown>>((acc, p) => {
    acc[p.field] = p.default_value;
    return acc;
  }, {});
  return ok(
    {
      dry_run: true,
      would_be_no_op: false,
      types: newTypes,
      would_add_fields: wouldAddFields,
      would_readopt_fields: readoptedFields,
    },
    validation.issues.map(adaptIssue),
  );
}
```

Append to the tool description (line 36):

```ts
'Add a type to a node, automatically populating claimed fields with defaults. The type must have a defined schema. Use list-schemas to see available types. Use dry_run: true to preview the type addition and field defaults without applying.'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-type-to-node-dry-run.test.ts`
Expected: all three pass.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/add-type-to-node.ts tests/mcp/add-type-to-node-dry-run.test.ts
git commit -m "feat(mcp): add dry_run to add-type-to-node"
```

---

## Task 4: `batch-mutate` dry_run

This is the most involved change. It introduces:
- A `DryRunRollback` sentinel error.
- Closure-captured `would_apply: WouldApplyEntry[]`.
- Undo-op gating (skip `createOperation` / `finalizeOperation`, pass `operation_id: undefined`).
- File-backup gating (skip `backupFile` calls).
- `db_only: true` on update mutations.
- `unlink_file: false` on delete ops.
- A new outer-catch branch for the sentinel that returns `ok` with the preview.
- A new failure-mid-dry-run path that returns `ok: true` with `failed_at`/`op`/`message`/partial `would_apply`.

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts`
- Create: `tests/mcp/batch-mutate-dry-run.test.ts`

- [ ] **Step 1: Re-read `src/mcp/tools/batch-mutate.ts`**

Re-read it end-to-end before editing. The control flow is non-trivial: a `db.transaction(() => { ... })` callback that throws on op error, an outer `try` that calls the txn and an outer `catch` that handles rollback restoration, all inside a `try/finally` that calls `finalizeOperation`. The dry-run additions must thread through this without disturbing the live path.

- [ ] **Step 2: Write the failing tests**

Create `tests/mcp/batch-mutate-dry-run.test.ts` using the same harness as `tests/mcp/batch-mutate-directory.test.ts` (copy its preamble verbatim — the imports, `BatchResponse` interface, `parseResult`, `getHandler`, `beforeEach`/`afterEach`). Add these imports on top of the copied preamble:

```ts
import { existsSync, statSync } from 'node:fs';
import { createGlobalField } from '../../src/global-fields/crud.js';
```

Then add the `describe` block:

```ts
describe('batch-mutate dry_run', () => {
  it('dry_run: true returns would_apply with create/update/delete entries and applies nothing', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
    // Pre-existing nodes for the update + delete ops
    const existingForUpdate = await (async () => {
      const r = parseResult(await getHandler()({
        operations: [{ op: 'create', params: { title: 'Existing', types: ['note'] } }],
      }));
      expect(r.ok).toBe(true);
      return r.data!.results[0];
    })();
    const existingForDelete = await (async () => {
      const r = parseResult(await getHandler()({
        operations: [{ op: 'create', params: { title: 'ToDelete', types: ['note'] } }],
      }));
      expect(r.ok).toBe(true);
      return r.data!.results[0];
    })();

    // Capture pre-state
    const fileMtimeBefore = statSync(join(vaultPath, existingForUpdate.file_path)).mtimeMs;
    const undoCountBefore = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;

    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'NewNote', types: ['note'] } },
        { op: 'update', params: { node_id: existingForUpdate.node_id, set_body: 'changed' } },
        { op: 'delete', params: { node_id: existingForDelete.node_id } },
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.op_count).toBe(3);
    const wouldApply = result.data?.would_apply as Array<Record<string, unknown>>;
    expect(wouldApply).toHaveLength(3);
    expect(wouldApply[0].op).toBe('create');
    expect(wouldApply[0].file_path).toBe('Notes/NewNote.md');
    expect(wouldApply[0].title).toBe('NewNote');
    expect(wouldApply[1].op).toBe('update');
    expect(wouldApply[1].body_changed).toBe(true);
    expect(wouldApply[2].op).toBe('delete');
    expect(wouldApply[2].node_id).toBe(existingForDelete.node_id);

    // Side-effect checks: no new file, existing file unchanged, deleted file present, no undo op recorded.
    expect(existsSync(join(vaultPath, 'Notes/NewNote.md'))).toBe(false);
    const fileMtimeAfter = statSync(join(vaultPath, existingForUpdate.file_path)).mtimeMs;
    expect(fileMtimeAfter).toBe(fileMtimeBefore);
    expect(existsSync(join(vaultPath, existingForDelete.file_path))).toBe(true);
    const undoCountAfter = (db.prepare('SELECT COUNT(*) as c FROM undo_operations').get() as { c: number }).c;
    expect(undoCountAfter).toBe(undoCountBefore);
  });

  it('composed [create X, update X] preview shows op 2 reflects op 1', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'Chained', types: ['note'] } },
        { op: 'update', params: { title: 'Chained', set_body: 'second op body' } },
      ],
    }));
    expect(result.ok).toBe(true);
    const wouldApply = result.data?.would_apply as Array<Record<string, unknown>>;
    expect(wouldApply[1].op).toBe('update');
    expect(wouldApply[1].body_changed).toBe(true);
  });

  it('failing op mid-dry-run returns ok: true with failed_at and partial would_apply', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [
        { op: 'create', params: { title: 'Good', types: ['note'] } },
        { op: 'create', params: { title: 'Bad', types: ['nonexistent_type'] } },
      ],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.dry_run).toBe(true);
    expect(result.data?.failed_at).toBe(1);
    expect(result.data?.op).toBe('create');
    expect(typeof result.data?.message).toBe('string');
    const wouldApply = result.data?.would_apply as Array<Record<string, unknown>>;
    expect(wouldApply).toHaveLength(1);
    expect(wouldApply[0].op).toBe('create');
  });

  it('update dry_run with no actual change → fields_changed empty, body_changed false, types_after absent', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
    const created = parseResult(await getHandler()({
      operations: [{ op: 'create', params: { title: 'Same', types: ['note'], body: 'unchanged' } }],
    })).data!.results[0];
    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [{ op: 'update', params: { node_id: created.node_id, set_body: 'unchanged', set_types: ['note'] } }],
    }));
    expect(result.ok).toBe(true);
    const entry = (result.data?.would_apply as Array<Record<string, unknown>>)[0];
    expect(entry.fields_changed).toEqual([]);
    expect(entry.body_changed).toBe(false);
    expect(entry.types_after).toBeUndefined();
  });

  it('delete dry_run with > 10 inbound refs caps referencing_nodes at 10 but reports full count', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
    createGlobalField(db, { name: 'related', field_type: 'reference_list' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'related' }], default_directory: 'Tasks' });
    const target = parseResult(await getHandler()({
      operations: [{ op: 'create', params: { title: 'Target', types: ['note'] } }],
    })).data!.results[0];
    // 12 inbound refs
    for (let i = 0; i < 12; i++) {
      const r = parseResult(await getHandler()({
        operations: [{ op: 'create', params: { title: `Ref${i}`, types: ['task'], fields: { related: ['Target'] } } }],
      }));
      expect(r.ok).toBe(true);
    }

    const handler = getHandler();
    const result = parseResult(await handler({
      dry_run: true,
      operations: [{ op: 'delete', params: { node_id: target.node_id } }],
    }));
    expect(result.ok).toBe(true);
    const entry = (result.data?.would_apply as Array<Record<string, unknown>>)[0];
    expect(entry.incoming_reference_count).toBe(12);
    expect((entry.referencing_nodes as unknown[]).length).toBe(10);
  });

  it('live path (no dry_run) regression-passes', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [], default_directory: 'Notes' });
    const handler = getHandler();
    const result = parseResult(await handler({
      operations: [{ op: 'create', params: { title: 'Live', types: ['note'] } }],
    }));
    expect(result.ok).toBe(true);
    expect(result.data?.applied).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/Live.md'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/batch-mutate-dry-run.test.ts`
Expected: failures across the board (param unrecognized, no `dry_run` in response, etc.).

- [ ] **Step 4: Implement — add `dry_run` param and `DryRunRollback` sentinel**

In `src/mcp/tools/batch-mutate.ts`:

Add `dry_run: z.boolean().default(false)` to `paramsShape`:

```ts
const paramsShape = {
  operations: z.array(operationSchema),
  dry_run: z.boolean().default(false),
};
```

Add a sentinel error class at module scope (above `registerBatchMutate`):

```ts
type WouldApplyEntry =
  | { op: 'create'; node_id: string; file_path: string; title: string }
  | { op: 'update'; node_id: string; file_path: string;
      fields_changed: string[]; types_after?: string[];
      body_changed: boolean; title_changed: boolean }
  | { op: 'delete'; node_id: string; file_path: string;
      incoming_reference_count: number;
      referencing_nodes: Array<{ node_id: string; title: string; file_path: string }> };

class DryRunRollback extends Error {
  constructor() { super('DryRunRollback'); this.name = 'DryRunRollback'; }
}
```

- [ ] **Step 5: Implement — gate undo-op creation and finalize on dry_run**

Replace:

```ts
const operation_id = createOperation(db, {
  source_tool: 'batch-mutate',
  description: `batch-mutate: ${params.operations.length} ops (${countKinds(params.operations)})`,
});
```

with:

```ts
const dryRun = params.dry_run;
const operation_id = dryRun ? undefined : createOperation(db, {
  source_tool: 'batch-mutate',
  description: `batch-mutate: ${params.operations.length} ops (${countKinds(params.operations)})`,
});
```

Replace the `finally` block:

```ts
} finally {
  finalizeOperation(db, operation_id);
}
```

with:

```ts
} finally {
  if (operation_id) finalizeOperation(db, operation_id);
}
```

- [ ] **Step 6: Implement — add `would_apply` collection and per-op preview building**

Inside the txn callback, declare a closure-captured `would_apply` array at the top:

```ts
const would_apply: WouldApplyEntry[] = [];
```

In the **create** branch, after the existing `executeMutation` call, gate the file-write side effect on `!dryRun` and push a preview entry:

```ts
const result = executeMutation(db, writeLock, vaultPath, {
  source: 'tool',
  node_id: null,
  file_path: filePath,
  title,
  types,
  fields,
  body,
  ...(dryRun ? { db_only: true } : {}),
}, syncLogger, { operation_id });
if (!dryRun && result.file_written) createdFiles.push(absPath);
results.push({ op: 'create', node_id: result.node_id, file_path: result.file_path });
if (dryRun) {
  would_apply.push({ op: 'create', node_id: result.node_id, file_path: result.file_path, title });
}
```

In the **update** branch, gate `backupFile` on `!dryRun`, set `db_only: true` on the mutation when dry-run, and push a preview entry:

```ts
if (!dryRun) {
  const bp = backupFile(absPath, tmpDir);
  if (bp) backups.push({ filePath: absPath, backupPath: bp });
}
// ... existing code that builds finalFields, finalTypes, finalBody, etc ...

const result = executeMutation(db, writeLock, vaultPath, {
  source: 'tool',
  node_id: node.node_id,
  file_path: node.file_path,
  title: opParams.set_title ?? node.title,
  types: finalTypes,
  fields: finalFields,
  body: finalBody,
  ...(dryRun ? { db_only: true } : {}),
}, syncLogger, { operation_id });
results.push({ op: 'update', node_id: result.node_id, file_path: result.file_path });

if (dryRun) {
  // Compute change-indicators by diffing against pre-update DB state we already loaded.
  const fields_changed: string[] = [];
  for (const k of new Set([...Object.keys(currentFields), ...Object.keys(finalFields)])) {
    const before = currentFields[k];
    const after = finalFields[k];
    if (JSON.stringify(before) !== JSON.stringify(after)) fields_changed.push(k);
  }
  const typesChanged = JSON.stringify([...currentTypes].sort()) !== JSON.stringify([...finalTypes].sort());
  const entry: WouldApplyEntry = {
    op: 'update',
    node_id: result.node_id,
    file_path: result.file_path,
    fields_changed,
    body_changed: finalBody !== currentBody,
    title_changed: (opParams.set_title ?? node.title) !== node.title,
  };
  if (typesChanged) entry.types_after = finalTypes;
  would_apply.push(entry);
}
```

In the **delete** branch, gate `backupFile` on `!dryRun`, change `unlink_file: true` to `unlink_file: !dryRun`, capture inbound-ref info before `executeDeletion` for the preview, and push the entry:

```ts
if (!dryRun) {
  const bp = backupFile(absPath, tmpDir);
  if (bp) backups.push({ filePath: absPath, backupPath: bp });
}

let preview_refs: { count: number; nodes: Array<{ node_id: string; title: string; file_path: string }> } | undefined;
if (dryRun) {
  const incomingCount = (db.prepare(
    'SELECT COUNT(*) as c FROM relationships WHERE target = ? OR target = ?'
  ).get(node.title, node.file_path) as { c: number }).c;
  const incomingRows = db.prepare(`
    SELECT r.source_id as node_id, n.title, n.file_path
    FROM relationships r JOIN nodes n ON n.id = r.source_id
    WHERE r.target = ? OR r.target = ?
    LIMIT 10
  `).all(node.title, node.file_path) as Array<{ node_id: string; title: string; file_path: string }>;
  preview_refs = { count: incomingCount, nodes: incomingRows };
}

executeDeletion(db, writeLock, vaultPath, {
  source: 'batch',
  node_id: node.node_id,
  file_path: node.file_path,
  unlink_file: !dryRun,
}, { operation_id });
if (!dryRun) deletedNodeIds.push(node.node_id);

results.push({ op: 'delete', node_id: node.node_id, file_path: node.file_path });
if (dryRun && preview_refs) {
  would_apply.push({
    op: 'delete',
    node_id: node.node_id,
    file_path: node.file_path,
    incoming_reference_count: preview_refs.count,
    referencing_nodes: preview_refs.nodes,
  });
}
```

- [ ] **Step 7: Implement — throw `DryRunRollback` at end of txn callback**

After the `for` loop in the txn callback, before `return results;`:

```ts
if (dryRun) throw new DryRunRollback();
return results;
```

- [ ] **Step 8: Implement — handle `DryRunRollback` in the outer catch**

Restructure the outer `try { applied = txn(); ... } catch { ... }`:

```ts
try {
  try {
    const applied = txn();
    cleanupBackups(backups.map(b => b.backupPath));
    for (const nodeId of deletedNodeIds) {
      embeddingIndexer?.removeNode(nodeId);
    }
    return ok({ applied: true, results: applied }, deprecationWarnings);
  } catch (err) {
    // dry-run paths — both successful preview (sentinel) and mid-batch failure
    if (dryRun) {
      // No file restoration needed: backups[] and createdFiles[] are empty under dry_run gating.
      if (err instanceof DryRunRollback) {
        return ok({
          dry_run: true,
          op_count: params.operations.length,
          would_apply,
        }, deprecationWarnings);
      }
      // Real op failure inside dry-run txn.
      if (batchError) {
        return ok({
          dry_run: true,
          failed_at: batchError.failed_at,
          op: batchError.op,
          message: batchError.message,
          would_apply,
        }, deprecationWarnings);
      }
      return ok({ dry_run: true, op_count: params.operations.length, would_apply }, deprecationWarnings);
    }

    // Existing live-path rollback logic — unchanged
    const rollbackFailures: string[] = [];
    for (const { filePath, backupPath } of backups) {
      try { restoreFile(backupPath, filePath); }
      catch (e) {
        const msg = `Failed to restore ${filePath}: ${e instanceof Error ? e.message : e}`;
        console.error(`[batch-mutate] ${msg}`);
        rollbackFailures.push(msg);
      }
    }
    for (const absPath of createdFiles) {
      try { unlinkSync(absPath); }
      catch (e) {
        const msg = `Failed to delete ${absPath}: ${e instanceof Error ? e.message : e}`;
        console.error(`[batch-mutate] ${msg}`);
        rollbackFailures.push(msg);
      }
    }
    if (batchError) {
      const details: Record<string, unknown> = {
        failed_at: batchError.failed_at,
        op: batchError.op,
        ...batchError.details,
      };
      if (rollbackFailures.length > 0) details.rollback_failures = rollbackFailures;
      return fail('BATCH_FAILED', batchError.message, { details, warnings: deprecationWarnings });
    }
    return fail('INTERNAL_ERROR', 'Batch operation failed', { warnings: deprecationWarnings });
  }
} finally {
  if (operation_id) finalizeOperation(db, operation_id);
}
```

The existing `would_apply` array is empty if no ops succeeded before the failure, which is correct.

- [ ] **Step 9: Update tool description**

Append to the existing description:

```ts
'Use dry_run: true to preview the entire batch atomically (composed effects via SAVEPOINT-style rollback) without applying.'
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/batch-mutate-dry-run.test.ts`
Expected: all six tests pass.

- [ ] **Step 11: Run the existing batch-mutate tests for regression**

Run: `npx vitest run tests/mcp/batch-mutate-directory.test.ts tests/integration/bulk-mutate-join-filters.test.ts`
Expected: pass — live-path behavior unchanged.

- [ ] **Step 12: Run the full suite**

Run: `npm test`
Expected: pass.

- [ ] **Step 13: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts tests/mcp/batch-mutate-dry-run.test.ts
git commit -m "feat(mcp): add dry_run to batch-mutate"
```

---

## Final verification

- [ ] **Run `npm run build`** to confirm TypeScript compiles cleanly across all four tool changes.

- [ ] **Run `npm test`** one more time end-to-end to catch any cross-test interactions.

- [ ] **Manual smoke** (optional but recommended): in a scratch session, call each of the four tools with `dry_run: true` and confirm the response shape matches the spec.
