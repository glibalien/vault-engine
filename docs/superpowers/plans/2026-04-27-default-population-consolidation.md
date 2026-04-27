# Default-Population Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two parallel default-population code paths (`validation/validate.ts` and `pipeline/populate-defaults.ts`) into one, with `validateProposedState` as the single defaulting site.

**Architecture:** `validateProposedState` already populates defaults into `coerced_state` with `source: 'defaulted'` for any non-skipping write source. Today, two callers (`add-type-to-node` and the `watcher`) duplicate this logic by pre-computing defaults *outside* the pipeline and merging them in. After this refactor, those callers stop pre-merging and read defaulted fields out of the validation result instead. A tiny pure helper, `defaultedFieldsFrom(result)`, replaces three inline `coerced_state` extraction loops.

**Tech Stack:** TypeScript, Node.js ESM, vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-04-27-default-population-consolidation-design.md`.

**Branch:** `refactor/default-population-consolidation` (create from `main`).

---

## File Structure

**Modified:**
- `src/validation/validate.ts` — add `defaultedFieldsFrom` exported helper.
- `src/pipeline/execute.ts` — replace two inline `coerced_state` extraction loops with the helper.
- `src/mcp/tools/add-type-to-node.ts` — stop pre-merging defaults; derive `added_fields` and `would_add_fields` from `validation.coerced_state`; delete the post-mutation `writeEditsLogEntries` block.
- `src/sync/watcher.ts` — delete both `populateDefaults` calls and surrounding pre-merge logic.
- `src/pipeline/index.ts` — remove the `populateDefaults` export.
- `tests/phase3/tools.test.ts` — replace one `populateDefaults` import + call with equivalent `validateProposedState` usage.

**Created:**
- `tests/validation/defaults.test.ts` — replaces `tests/pipeline/populate-defaults.test.ts`. Same scenarios, asserted via `validateProposedState` + `defaultedFieldsFrom`.
- `tests/sync/watcher-field-defaulted.test.ts` — new red-phase test that fails today and passes after Task 7.

**Deleted:**
- `src/pipeline/populate-defaults.ts`
- `tests/pipeline/populate-defaults.test.ts` (content moved to `tests/validation/defaults.test.ts`)

---

## Pre-flight: Branch setup

- [ ] **Step 0.1: Create branch from main**

```bash
git checkout main
git pull --ff-only origin main
git checkout -b refactor/default-population-consolidation
```

- [ ] **Step 0.2: Verify baseline tests pass**

```bash
npm test
```

Expected: all tests pass on `main`. If any fail, stop — investigate before refactoring.

---

## Task 1: Extract `defaultedFieldsFrom` helper (pure addition)

**Files:**
- Modify: `src/validation/validate.ts` (add export at the bottom)
- Test: `tests/validation/defaults-helper.test.ts` (new)

**Why this task is first:** Establishes the helper before any callsite swap. Pure addition — no behavior change yet.

- [ ] **Step 1.1: Write failing test for the helper**

Create `tests/validation/defaults-helper.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { ValidationResult, EffectiveField, GlobalFieldDefinition } from '../../src/validation/types.js';
import { defaultedFieldsFrom } from '../../src/validation/validate.js';

function makeEffectiveField(overrides: Partial<EffectiveField> = {}): EffectiveField {
  const gf: GlobalFieldDefinition = {
    name: 'f',
    field_type: 'string',
    required: true,
    default_value: 'g',
    overrides_allowed: { required: false, default_value: false, enum_values: false },
  } as GlobalFieldDefinition;
  return {
    field_name: 'f',
    global_field: gf,
    resolved_required: true,
    resolved_default_value: 'g',
    resolved_enum_values: null,
    resolved_order: 0,
    default_source: 'global',
    default_value_overridden: false,
    claiming_types: ['T'],
    ...overrides,
  } as EffectiveField;
}

describe('defaultedFieldsFrom', () => {
  it('returns empty when no fields are defaulted', () => {
    const result: ValidationResult = {
      valid: true,
      effective_fields: new Map(),
      coerced_state: {
        a: { field: 'a', value: 'x', source: 'provided', changed: false },
        b: { field: 'b', value: 'y', source: 'orphan', changed: false },
      },
      issues: [],
      orphan_fields: ['b'],
    };
    expect(defaultedFieldsFrom(result)).toEqual([]);
  });

  it("extracts defaulted entries with default_source from effective_fields", () => {
    const ef = makeEffectiveField({ field_name: 'priority', default_source: 'claim' });
    const result: ValidationResult = {
      valid: true,
      effective_fields: new Map([['priority', ef]]),
      coerced_state: {
        priority: { field: 'priority', value: 'high', source: 'defaulted', changed: false },
        other: { field: 'other', value: 'kept', source: 'provided', changed: false },
      },
      issues: [],
      orphan_fields: [],
    };

    const out = defaultedFieldsFrom(result);
    expect(out).toEqual([
      { field: 'priority', default_value: 'high', default_source: 'claim' },
    ]);
  });

  it("falls back to default_source 'global' when effective_fields entry is missing", () => {
    const result: ValidationResult = {
      valid: true,
      effective_fields: new Map(),
      coerced_state: {
        ghost: { field: 'ghost', value: 'g', source: 'defaulted', changed: false },
      },
      issues: [],
      orphan_fields: [],
    };
    const out = defaultedFieldsFrom(result);
    expect(out).toEqual([
      { field: 'ghost', default_value: 'g', default_source: 'global' },
    ]);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
npx vitest run tests/validation/defaults-helper.test.ts
```

Expected: FAIL with `defaultedFieldsFrom is not a function` or import error.

- [ ] **Step 1.3: Implement the helper**

Append to `src/validation/validate.ts` (after the `validateProposedState` function):

```typescript
/**
 * Extract the list of fields that were populated with defaults during validation,
 * along with their resolved default_source ('global' or 'claim'). Pure function
 * over a ValidationResult — no DB access.
 */
export function defaultedFieldsFrom(result: ValidationResult): Array<{
  field: string;
  default_value: unknown;
  default_source: 'global' | 'claim';
}> {
  const out: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }> = [];
  for (const cv of Object.values(result.coerced_state)) {
    if (cv.source !== 'defaulted') continue;
    const ef = result.effective_fields.get(cv.field);
    out.push({
      field: cv.field,
      default_value: cv.value,
      default_source: ef?.default_source ?? 'global',
    });
  }
  return out;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
npx vitest run tests/validation/defaults-helper.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/validation/validate.ts tests/validation/defaults-helper.test.ts
git commit -m "$(cat <<'EOF'
refactor(validation): add defaultedFieldsFrom helper

Pure function that extracts the defaulted-fields list from a
ValidationResult. Will replace three inline coerced_state extraction
loops in subsequent commits. No callsite changes yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Swap `execute.ts` inline loops to use the helper (pure refactor)

**Files:**
- Modify: `src/pipeline/execute.ts:146-174,226-232`

**Why this task:** Removes the two duplicated extraction loops in `execute.ts` and proves the helper is wired correctly. Behavior is identical.

- [ ] **Step 2.1: Read current state of `execute.ts:146-174`**

The current shape is:

```typescript
const defaultedFields: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }> = [];

if (mutation.source === 'tool' || mutation.source === 'normalizer' || mutation.source === 'propagation' || mutation.source === 'undo') {
  // ... tool path validation ...
  // (lines 168-174)
  for (const [, cv] of Object.entries(validation.coerced_state)) {
    if (cv.source === 'defaulted') {
      const ef = validation.effective_fields.get(cv.field);
      const source: 'global' | 'claim' = ef?.default_source ?? 'global';
      defaultedFields.push({ field: cv.field, default_value: cv.value, default_source: source });
    }
  }
} else {
  // ... watcher path ...
  // (lines 226-232)
  for (const [, cv] of Object.entries(validation.coerced_state)) {
    if (cv.source === 'defaulted') {
      const ef = validation.effective_fields.get(cv.field);
      const source: 'global' | 'claim' = ef?.default_source ?? 'global';
      defaultedFields.push({ field: cv.field, default_value: cv.value, default_source: source });
    }
  }
}
```

Both branches push the same content. Since they're mutually exclusive and the helper produces the same list either way, hoist the call to a single line *after* the if/else.

- [ ] **Step 2.2: Add the import at the top of `execute.ts`**

Find the existing import line:

```typescript
import { validateProposedState } from '../validation/validate.js';
```

Replace with:

```typescript
import { validateProposedState, defaultedFieldsFrom } from '../validation/validate.js';
```

- [ ] **Step 2.3: Replace both inline loops with the helper**

Edit `src/pipeline/execute.ts`. In the tool-path branch (currently lines 168-174), delete the for-loop block:

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

And the matching block in the watcher branch (currently lines 226-232).

After deleting both, change the `defaultedFields` declaration line (currently line 146) from:

```typescript
const defaultedFields: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }> = [];
```

…and add a new assignment AFTER the if/else block (just before "Stage 4: Compute final state"):

```typescript
const defaultedFields = defaultedFieldsFrom(validation);
```

Delete the original empty-array declaration line (line 146).

- [ ] **Step 2.4: Run the full test suite**

```bash
npm test
```

Expected: ALL tests PASS. The behavior is byte-identical; this is a pure refactor.

If any test fails, the most likely cause is a typo — diff against `main` to confirm only the two extraction loops and the declaration moved.

- [ ] **Step 2.5: Commit**

```bash
git add src/pipeline/execute.ts
git commit -m "$(cat <<'EOF'
refactor(pipeline): use defaultedFieldsFrom in execute.ts

Replaces two duplicated coerced_state extraction loops (one in the tool
branch, one in the watcher branch) with a single call to the helper
hoisted after the if/else. No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Lock-in test — `add-type-to-node` `default_source` attribution

**Files:**
- Modify: `tests/mcp/add-type-to-node-dry-run.test.ts` (rename file to `add-type-to-node.test.ts` — see step 3.1)
- OR create: `tests/mcp/add-type-to-node-defaults.test.ts` (new file)

**Why this task:** The existing dry-run test covers `would_add_fields == added_fields` equivalence (line 78 of `add-type-to-node-dry-run.test.ts`). This task adds an assertion that the `field-defaulted` edits-log row emitted by add-type-to-node carries the right `source` ('tool') and the right `default_source` ('claim' when overridden, 'global' when cancelled). Today this passes; it's a regression lock for Task 6.

For decomposition clarity, create a new file rather than extending the dry-run-specific one.

- [ ] **Step 3.1: Write the lock-in test**

Create `tests/mcp/add-type-to-node-defaults.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
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
  registerAddTypeToNode(fakeServer, db, writeLock, vaultPath);
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
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('add-type-to-node — field-defaulted edits-log emission', () => {
  it("emits field-defaulted with source='tool' and default_source='global' when no override", async () => {
    createGlobalField(db, {
      name: 'category',
      field_type: 'string',
      required: true,
      default_value: 'general',
    });
    createSchemaDefinition(db, {
      name: 'Doc',
      field_claims: [{ field: 'category' }],
    });

    // Create a node WITHOUT the type first (so add-type-to-node has work to do)
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'note.md',
      title: 'Note',
      types: [],
      fields: {},
      body: '',
    });
    const nodeId = result.node_id;

    const handler = getHandler();
    const response = parseResult(await handler({ node_id: nodeId, type: 'Doc' }));
    expect(response.ok).toBe(true);
    expect(response.data?.added_fields).toEqual(['category']);

    const row = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as { details: string };
    const details = JSON.parse(row.details);
    expect(details.source).toBe('tool');
    expect(details.field).toBe('category');
    expect(details.default_value).toBe('general');
    expect(details.default_source).toBe('global');
  });

  it("emits field-defaulted with default_source='claim' when the new type overrides", async () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      default_value: 'normal',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'Urgent',
      field_claims: [{ field: 'priority', default_value: 'high', default_value_overridden: true }],
    });

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'note.md',
      title: 'Note',
      types: [],
      fields: {},
      body: '',
    });
    const nodeId = result.node_id;

    const handler = getHandler();
    const response = parseResult(await handler({ node_id: nodeId, type: 'Urgent' }));
    expect(response.ok).toBe(true);

    const row = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted' ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as { details: string };
    const details = JSON.parse(row.details);
    expect(details.source).toBe('tool');
    expect(details.field).toBe('priority');
    expect(details.default_value).toBe('high');
    expect(details.default_source).toBe('claim');
  });

  it('does not emit field-defaulted for re-adopted orphan fields', async () => {
    createGlobalField(db, {
      name: 'tag',
      field_type: 'string',
      required: false,
    });
    createSchemaDefinition(db, {
      name: 'Tagged',
      field_claims: [{ field: 'tag' }],
    });

    // Create a node with 'tag' as orphan (no claiming type)
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'note.md',
      title: 'Note',
      types: [],
      fields: { tag: 'preexisting' },
      body: '',
    });
    const nodeId = result.node_id;

    const handler = getHandler();
    const response = parseResult(await handler({ node_id: nodeId, type: 'Tagged' }));
    expect(response.ok).toBe(true);
    expect(response.data?.readopted_fields).toEqual(['tag']);
    expect(response.data?.added_fields).toEqual([]);

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'"
    ).all(nodeId);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 3.2: Run the new test to verify it passes today**

```bash
npx vitest run tests/mcp/add-type-to-node-defaults.test.ts
```

Expected: 3 tests PASS. (This is a regression lock — current behavior is correct; we're locking it in before the refactor.)

- [ ] **Step 3.3: Commit**

```bash
git add tests/mcp/add-type-to-node-defaults.test.ts
git commit -m "$(cat <<'EOF'
test(add-type-to-node): lock-in field-defaulted emission contract

Adds three regression tests for the contract that add-type-to-node
emits a field-defaulted edits-log row with source='tool' and the
correct default_source ('global' when no override; 'claim' when the
new type overrides). Also asserts no field-defaulted row for
re-adopted orphans.

These tests pass on main; they're locked in before the upcoming
refactor of add-type-to-node so any drift is caught.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Red-phase test — watcher field-defaulted emission

**Files:**
- Create: `tests/sync/watcher-field-defaulted.test.ts`

**Why this task:** This test asserts that when the watcher writes a newly-typed file with a missing required-with-default field, an edits-log row with `source: 'watcher'` is emitted. **Today this fails** because of the pre-merge in `watcher.ts`. It will pass after Task 7.

- [ ] **Step 4.1: Write the failing test**

Create `tests/sync/watcher-field-defaulted.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { startWatcher } from '../../src/sync/watcher.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('watcher — field-defaulted emission', () => {
  let vaultPath: string;
  let dbPath: string;
  let db: Database.Database;
  let mutex: IndexMutex;
  let writeLock: WriteLockManager;
  let watcher: FSWatcher;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-watcher-defaults-test-'));
    dbPath = join(vaultPath, '.vault-engine', 'test.db');
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    // Set up a schema with a required-with-default field
    createGlobalField(db, {
      name: 'status',
      field_type: 'string',
      required: true,
      default_value: 'draft',
    });
    createSchemaDefinition(db, {
      name: 'Doc',
      field_claims: [{ field: 'status' }],
    });

    fullIndex(vaultPath, db);

    mutex = new IndexMutex();
    writeLock = new WriteLockManager();
    watcher = startWatcher(vaultPath, db, mutex, writeLock, undefined, undefined, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
    });
    await delay(100);
  });

  afterEach(async () => {
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it("emits field-defaulted with source='watcher' for a newly-typed file missing a required default", async () => {
    writeFileSync(
      join(vaultPath, 'new-doc.md'),
      '---\ntitle: New Doc\ntypes: [Doc]\n---\nbody\n',
      'utf-8',
    );
    await delay(DEBOUNCE_MS + MAX_WAIT_MS + 200);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?')
      .get('new-doc.md') as { id: string } | undefined;
    expect(node).toBeDefined();
    if (!node) return;

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'"
    ).all(node.id) as Array<{ details: string }>;
    expect(rows.length).toBeGreaterThan(0);

    const details = JSON.parse(rows[0].details);
    expect(details.source).toBe('watcher');
    expect(details.field).toBe('status');
    expect(details.default_value).toBe('draft');
    expect(details.default_source).toBe('global');
  });

  it('does not emit field-defaulted when the field is already present in the parsed file', async () => {
    writeFileSync(
      join(vaultPath, 'already-set.md'),
      '---\ntitle: Already Set\ntypes: [Doc]\nstatus: published\n---\nbody\n',
      'utf-8',
    );
    await delay(DEBOUNCE_MS + MAX_WAIT_MS + 200);

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?')
      .get('already-set.md') as { id: string } | undefined;
    expect(node).toBeDefined();
    if (!node) return;

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'field-defaulted'"
    ).all(node.id);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 4.2: Run the test to verify the first case fails**

```bash
npx vitest run tests/sync/watcher-field-defaulted.test.ts
```

Expected: First test FAILS (`expected 0 to be greater than 0` — no field-defaulted row exists). Second test PASSES.

This is the planned red phase for the watcher refactor in Task 7.

- [ ] **Step 4.3: Commit**

```bash
git add tests/sync/watcher-field-defaulted.test.ts
git commit -m "$(cat <<'EOF'
test(watcher): red-phase field-defaulted emission test

The watcher's pre-merge of defaults (in watcher.ts:281,292) silently
suppresses field-defaulted edits-log entries by making defaults look
like provided values to validate.ts.

This test asserts the corrected behavior — newly-typed file with a
missing required default emits field-defaulted with source='watcher'.
Currently the first case fails. Will pass after the upcoming watcher
refactor (Task 7).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Refactor `add-type-to-node` to read defaults from validation

**Files:**
- Modify: `src/mcp/tools/add-type-to-node.ts`

**Why this task:** Removes the pre-merge of defaults in add-type-to-node. After this, the pipeline emits `field-defaulted` automatically (because `coerced_state` now has `source: 'defaulted'` instead of values being passed through as `provided`).

- [ ] **Step 5.1: Read the current state of `add-type-to-node.ts`**

Read `src/mcp/tools/add-type-to-node.ts` to understand the existing structure. Key blocks:
- Lines 86-91: load currentFields from DB
- Line 99: `populateDefaults(db, newTypes, currentFields)` returns `{ defaults, populated }`
- Lines 102-109: re-adoption detection using `populated`
- Line 111: `mergedFields = { ...currentFields, ...defaults }`
- Lines 113-129: dry-run path
- Lines 137-164: live path with executeMutation + post-mutation writeEditsLogEntries

- [ ] **Step 5.2: Update imports**

The current top of `src/mcp/tools/add-type-to-node.ts` has these four lines (among other imports):

```typescript
import { populateDefaults } from '../../pipeline/populate-defaults.js';
import { writeEditsLogEntries } from '../../pipeline/edits-log.js';
import type { EditsLogEntry } from '../../pipeline/edits-log.js';
// ...
import { validateProposedState } from '../../validation/validate.js';
```

Make three changes:

1. Delete the `populateDefaults` import line.
2. Delete the `writeEditsLogEntries` import line.
3. Delete the `EditsLogEntry` type import line.
4. Modify the `validateProposedState` import to also pull in `defaultedFieldsFrom`:

```typescript
import { validateProposedState, defaultedFieldsFrom } from '../../validation/validate.js';
```

- [ ] **Step 5.3: Restructure the handler body**

Replace the section that today reads (around lines 86-164):

```typescript
const currentFields: Record<string, unknown> = {};
const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
  .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
for (const row of fieldRows) {
  currentFields[row.field_name] = reconstructValue(row);
}

const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

// New type set
const newTypes = [...currentTypes, params.type];

// Populate defaults via merge algorithm
const { defaults, populated } = populateDefaults(db, newTypes, currentFields);

// Detect re-adopted fields (orphan fields that are now claimed by the new type)
const readoptedFields: string[] = [];
const newClaims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
  .all(params.type) as Array<{ field: string }>;
for (const claim of newClaims) {
  if (claim.field in currentFields && !(claim.field in defaults)) {
    readoptedFields.push(claim.field);
  }
}

const mergedFields = { ...currentFields, ...defaults };

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

…with the following:

```typescript
const currentFields: Record<string, unknown> = {};
const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
  .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
for (const row of fieldRows) {
  currentFields[row.field_name] = reconstructValue(row);
}

const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

// New type set
const newTypes = [...currentTypes, params.type];

// Run validation once. validate.ts populates missing required-with-default
// fields into coerced_state with source='defaulted'.
const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
const validation = validateProposedState(currentFields, newTypes, claimsByType, globalFields);
const populated = defaultedFieldsFrom(validation);

// Detect re-adopted fields (orphan fields now claimed by the new type)
const populatedSet = new Set(populated.map(p => p.field));
const readoptedFields: string[] = [];
const newClaims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
  .all(params.type) as Array<{ field: string }>;
for (const claim of newClaims) {
  if (claim.field in currentFields && !populatedSet.has(claim.field)) {
    readoptedFields.push(claim.field);
  }
}

if (params.dry_run) {
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

- [ ] **Step 5.4: Update the live-path call to executeMutation**

Replace the `executeMutation` call and the post-mutation `writeEditsLogEntries` block (currently lines 137-164):

```typescript
try {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: node.node_id,
    file_path: node.file_path,
    title: node.title,
    types: newTypes,
    fields: mergedFields,
    body: currentBody,
  }, syncLogger, { operation_id });

  // Log field-defaulted entries for defaults populated by add-type-to-node.
  // The pipeline sees these as 'provided' since they're pre-merged, so we
  // log them here with the correct source information.
  if (populated.length > 0) {
    const entries: EditsLogEntry[] = populated.map(p => ({
      node_id: result.node_id,
      event_type: 'field-defaulted',
      details: {
        source: 'tool' as const,
        field: p.field,
        default_value: p.default_value,
        default_source: p.default_source,
        node_types: newTypes,
      },
    }));
    writeEditsLogEntries(db, entries);
  }

  return ok(
    {
      node_id: result.node_id,
      file_path: result.file_path,
      types: newTypes,
      added_fields: populated.map(p => p.field),
      readopted_fields: readoptedFields,
      already_present: false,
    },
    result.validation.issues.map(adaptIssue),
  );
}
```

…with:

```typescript
try {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: node.node_id,
    file_path: node.file_path,
    title: node.title,
    types: newTypes,
    fields: currentFields,
    body: currentBody,
  }, syncLogger, { operation_id });

  // The pipeline emits field-defaulted edits-log entries automatically
  // because validate.ts produces source='defaulted' entries in coerced_state
  // when required-with-default fields are missing.
  const addedFields = defaultedFieldsFrom(result.validation).map(p => p.field);

  return ok(
    {
      node_id: result.node_id,
      file_path: result.file_path,
      types: newTypes,
      added_fields: addedFields,
      readopted_fields: readoptedFields,
      already_present: false,
    },
    result.validation.issues.map(adaptIssue),
  );
}
```

- [ ] **Step 5.5: Run the type-check**

```bash
npm run typecheck
```

Expected: PASS. If it fails complaining about unused imports (e.g., `mergedFields` was only used in the live path), remove the unused declaration. The lint/type-check should also catch any leftover reference to `defaults`/`populateDefaults`.

- [ ] **Step 5.6: Run the relevant tests**

```bash
npx vitest run tests/mcp/add-type-to-node-defaults.test.ts tests/mcp/add-type-to-node-dry-run.test.ts tests/phase3/tools.test.ts tests/undo/integration.test.ts
```

Expected: ALL PASS. The lock-in tests from Task 3 confirm the behavior didn't drift.

- [ ] **Step 5.7: Run the full suite**

```bash
npm test
```

Expected: ALL PASS. (`tests/pipeline/populate-defaults.test.ts` still passes — `populateDefaults` is still exported.)

- [ ] **Step 5.8: Commit**

```bash
git add src/mcp/tools/add-type-to-node.ts
git commit -m "$(cat <<'EOF'
refactor(add-type-to-node): read defaults from validation result

Stop pre-merging defaults via populateDefaults. Pass currentFields
straight to executeMutation; the pipeline's validateProposedState
populates missing required-with-default fields into coerced_state with
source='defaulted', and execute.ts emits field-defaulted edits-log
entries automatically. The post-mutation writeEditsLogEntries block
is no longer needed.

The added_fields response field is now derived from
defaultedFieldsFrom(result.validation) instead of the populated array.
Re-adoption detection uses the same set arithmetic, sourced from
validation instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Refactor watcher to remove the pre-merge

**Files:**
- Modify: `src/sync/watcher.ts`

**Why this task:** Removes the only remaining production caller of `populateDefaults`. Makes the watcher's `field-defaulted` emission test from Task 4 pass.

- [ ] **Step 6.1: Read the current state of watcher.ts:260-300**

The current code (after the YAML parse) inspects `nodeId`. If the node exists and there are newly-added types, it pre-merges defaults. If the node is new, it pre-merges defaults for all types.

- [ ] **Step 6.2: Delete the pre-merge logic**

Edit `src/sync/watcher.ts`. Find this block (around lines 262-298):

```typescript
// Detect type additions and populate defaults
if (nodeId) {
  const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

  const newTypes = parsed.types.filter(t => !currentTypes.includes(t));
  if (newTypes.length > 0) {
    // Load current fields from DB for default population
    const currentFields: Record<string, unknown> = {};
    const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
      .all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
    for (const row of fieldRows) {
      currentFields[row.field_name] = reconstructValue(row);
    }

    // Merge parsed fields on top of current fields (parsed wins)
    const mergedForDefaults = { ...currentFields, ...parsedFields };

    // Populate defaults for the full new type set
    const { defaults } = populateDefaults(db, parsed.types, mergedForDefaults);

    // Add defaults for fields not already in parsed output
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in parsedFields)) {
        parsedFields[field] = value;
      }
    }
  }
} else {
  // New file: all types are "newly added"
  const { defaults } = populateDefaults(db, parsed.types, parsedFields);
  for (const [field, value] of Object.entries(defaults)) {
    if (!(field in parsedFields)) {
      parsedFields[field] = value;
    }
  }
}
```

Delete this entire block. The pipeline now defaults missing required-with-default fields itself (the watcher source has `skipDefaults=false`).

- [ ] **Step 6.3: Remove the now-unused imports**

In `src/sync/watcher.ts:13` the import line currently looks like:

```typescript
import { populateDefaults } from '../pipeline/populate-defaults.js';
```

Delete this import.

Check whether `reconstructValue` is still used elsewhere in the file:

```bash
grep -n "reconstructValue" src/sync/watcher.ts
```

If it has no other use, also delete its import. (Likely import line: `import { reconstructValue } from '../pipeline/classify-value.js';`.)

Similarly check for `nodeId` to make sure removing the if/else block didn't strand an unused declaration upstream. The `nodeId` lookup (`const nodeId = existing?.id ?? null;` at line 260) is still needed for the `executeMutation` call below it.

- [ ] **Step 6.4: Run the type-check**

```bash
npm run typecheck
```

Expected: PASS. If TypeScript complains about unused imports, fix them.

- [ ] **Step 6.5: Run the watcher tests including the new red-phase test**

```bash
npx vitest run tests/sync/
```

Expected: ALL PASS. The previously-failing first case in `tests/sync/watcher-field-defaulted.test.ts` now passes.

- [ ] **Step 6.6: Run the full suite**

```bash
npm test
```

Expected: ALL PASS.

- [ ] **Step 6.7: Commit**

```bash
git add src/sync/watcher.ts
git commit -m "$(cat <<'EOF'
refactor(watcher): remove default pre-merge

The watcher's pre-merge of defaults via populateDefaults was redundant
(validate.ts defaults missing required fields anyway, since the watcher
source has skipDefaults=false) and silently suppressed field-defaulted
edits-log entries on newly-typed files and type-additions.

After this change the watcher passes parsedFields through to
executeMutation unmodified; the pipeline defaults missing fields and
emits field-defaulted with source='watcher' automatically.

Bugfix: field-defaulted edits-log entries are now emitted consistently
on the watcher path. Verified by tests/sync/watcher-field-defaulted.test.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Delete `populate-defaults.ts` and retarget tests

**Files:**
- Delete: `src/pipeline/populate-defaults.ts`
- Modify: `src/pipeline/index.ts`
- Delete: `tests/pipeline/populate-defaults.test.ts`
- Create: `tests/validation/defaults.test.ts`
- Modify: `tests/phase3/tools.test.ts`

**Why this task:** With both production callers gone, the helper is dead code. Move the unit-test scenarios to assert against `validateProposedState` + `defaultedFieldsFrom` directly.

- [ ] **Step 7.1: Verify no remaining callers of `populateDefaults`**

```bash
grep -rn "populateDefaults\b" src/ tests/
```

Expected: only matches in `src/pipeline/populate-defaults.ts`, `src/pipeline/index.ts` (export line), `tests/pipeline/populate-defaults.test.ts`, and `tests/phase3/tools.test.ts` (line 132 area).

If any other file references it, stop — Task 5 or 6 missed a callsite.

- [ ] **Step 7.2: Create the retargeted test file**

Create `tests/validation/defaults.test.ts`:

```typescript
// tests/validation/defaults.test.ts
//
// Unit tests for default-population — focusing on correct default_source
// reporting when per-type overrides agree, disagree, or are absent.
//
// Replaces tests/pipeline/populate-defaults.test.ts; same scenarios,
// asserted via validateProposedState + defaultedFieldsFrom.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { loadSchemaContext } from '../../src/pipeline/schema-context.js';
import { validateProposedState, defaultedFieldsFrom } from '../../src/validation/validate.js';

let db: Database.Database;

function populate(types: string[], currentFields: Record<string, unknown>) {
  const { claimsByType, globalFields } = loadSchemaContext(db, types);
  const result = validateProposedState(currentFields, types, claimsByType, globalFields);
  return defaultedFieldsFrom(result);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe('default-population — default_source', () => {
  it("reports 'global' when multiple types have conflicting per-type default overrides (cancellation path)", () => {
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
      required: true,
      default_value: 'normal',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'TypeA',
      field_claims: [{ field: 'priority', default_value: 'high', default_value_overridden: true }],
    });
    createSchemaDefinition(db, {
      name: 'TypeB',
      field_claims: [{ field: 'priority', default_value: 'low', default_value_overridden: true }],
    });

    const populated = populate(['TypeA', 'TypeB'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('priority');
    expect(populated[0].default_value).toBe('normal');
    expect(populated[0].default_source).toBe('global');
  });

  it("reports 'claim' when all types agree on the same per-type default override", () => {
    createGlobalField(db, {
      name: 'status',
      field_type: 'string',
      required: true,
      default_value: 'pending',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'TypeX',
      field_claims: [{ field: 'status', default_value: 'active', default_value_overridden: true }],
    });
    createSchemaDefinition(db, {
      name: 'TypeY',
      field_claims: [{ field: 'status', default_value: 'active', default_value_overridden: true }],
    });

    const populated = populate(['TypeX', 'TypeY'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('status');
    expect(populated[0].default_value).toBe('active');
    expect(populated[0].default_source).toBe('claim');
  });

  it("reports 'global' when no type has a per-type default override", () => {
    createGlobalField(db, {
      name: 'category',
      field_type: 'string',
      required: true,
      default_value: 'general',
    });
    createSchemaDefinition(db, {
      name: 'TypeZ',
      field_claims: [{ field: 'category' }],
    });

    const populated = populate(['TypeZ'], {});

    expect(populated).toHaveLength(1);
    expect(populated[0].field).toBe('category');
    expect(populated[0].default_value).toBe('general');
    expect(populated[0].default_source).toBe('global');
  });

  it('skips fields already present in currentFields', () => {
    createGlobalField(db, {
      name: 'tag',
      field_type: 'string',
      required: true,
      default_value: 'draft',
    });
    createSchemaDefinition(db, {
      name: 'Doc',
      field_claims: [{ field: 'tag' }],
    });

    const populated = populate(['Doc'], { tag: 'published' });
    expect(populated).toHaveLength(0);
  });
});
```

- [ ] **Step 7.3: Update `tests/phase3/tools.test.ts` to drop the pre-merge**

The current test (line 122-145 area) pre-populates defaults via `populateDefaults` and passes them as `fields` to `executeMutation`. Since the pipeline now defaults missing required fields itself, the pre-merge is redundant — just pass empty fields.

Find the import line (around line 14):

```typescript
import { populateDefaults } from '../../src/pipeline/populate-defaults.js';
```

Delete this import.

Find the test body around line 132. The current code is:

```typescript
// Simulate add-type: set types to ['task'] with populated defaults
const { defaults } = populateDefaults(db, ['task'], {});
const result = executeMutation(db, writeLock, vaultPath, {
  source: 'tool',
  node_id: created.node_id,
  file_path: 'test.md',
  title: 'Test',
  types: ['task'],
  fields: { ...defaults },
  body: '',
});
```

Replace with:

```typescript
// The pipeline defaults missing required-with-default fields itself
// (skipDefaults=false for source='tool'), so no pre-merge is needed.
const result = executeMutation(db, writeLock, vaultPath, {
  source: 'tool',
  node_id: created.node_id,
  file_path: 'test.md',
  title: 'Test',
  types: ['task'],
  fields: {},
  body: '',
});
```

The downstream assertion (`SELECT value_text FROM node_fields ...`) is unchanged — the value is still in the DB after the executeMutation call, just defaulted by the pipeline rather than the caller.

- [ ] **Step 7.4: Delete `populate-defaults.ts` and the old test file**

```bash
rm src/pipeline/populate-defaults.ts tests/pipeline/populate-defaults.test.ts
```

- [ ] **Step 7.5: Remove the export in `src/pipeline/index.ts`**

Read `src/pipeline/index.ts`. Find:

```typescript
export { populateDefaults } from './populate-defaults.js';
```

Delete this line. (If it's the only line in a re-export block, leave the surrounding structure intact.)

- [ ] **Step 7.6: Type-check and confirm no orphan references**

```bash
npm run typecheck
grep -rn "populate-defaults\|populateDefaults" src/ tests/
```

Expected: type-check PASSES. The grep should return zero matches (every reference is gone).

- [ ] **Step 7.7: Run the full test suite**

```bash
npm test
```

Expected: ALL PASS. The new `tests/validation/defaults.test.ts` covers the four scenarios from the deleted file.

- [ ] **Step 7.8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(pipeline): delete populate-defaults.ts

With add-type-to-node and the watcher refactored to read defaults from
the validation result, populateDefaults has no remaining callers. The
helper, its test file, and the pipeline index export are removed.

The unit-test scenarios for default_source attribution are migrated to
tests/validation/defaults.test.ts, asserted via validateProposedState +
defaultedFieldsFrom (the same code paths used in production).

The single populateDefaults reference in tests/phase3/tools.test.ts is
replaced with the equivalent validateProposedState construction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final verification

- [ ] **Step 8.1: Run the full test suite**

```bash
npm test
```

Expected: ALL PASS.

- [ ] **Step 8.2: Build**

```bash
npm run build
```

Expected: PASS. (Build runs `npm run typecheck` chained, per CLAUDE.md.)

- [ ] **Step 8.3: Re-grep for any orphan reference**

```bash
grep -rn "populateDefaults\|populate-defaults" src/ tests/ docs/
```

Expected: only docs reference (the spec). No code references.

- [ ] **Step 8.4: Diff summary review**

```bash
git diff main --stat
```

Expected:
- `src/validation/validate.ts` — net +20 (helper added)
- `src/pipeline/execute.ts` — net negative (two loops collapsed)
- `src/mcp/tools/add-type-to-node.ts` — net negative (~40 lines removed)
- `src/sync/watcher.ts` — net negative (~30 lines removed)
- `src/pipeline/index.ts` — net -1 (export removed)
- `src/pipeline/populate-defaults.ts` — DELETED (-51 lines)
- `tests/validation/defaults.test.ts` — net +~120 (replacement)
- `tests/validation/defaults-helper.test.ts` — net +~70 (new)
- `tests/mcp/add-type-to-node-defaults.test.ts` — net +~150 (new)
- `tests/sync/watcher-field-defaulted.test.ts` — net +~90 (new)
- `tests/pipeline/populate-defaults.test.ts` — DELETED (~120 lines)
- `tests/phase3/tools.test.ts` — small modification to one assertion

Net production code: ~70 lines deleted. Net test code: ~280 added (lock-in + red phase + retargeted).

- [ ] **Step 8.5: Push the branch**

```bash
git push -u origin refactor/default-population-consolidation
```

- [ ] **Step 8.6: Stop and report to the user**

Do NOT open a PR or merge. Report the branch state and the diff summary; the user decides how to integrate (PR, direct merge, etc.).
