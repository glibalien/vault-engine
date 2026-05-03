# MCP App Visualization Foundations Part 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `_meta.ui` rendering hints to global fields, audit `Issue.field` consistency for direct `Issue` constructions in tool handlers, and codify the iframe-write safety policy as a documented bundle-author contract (already inside the spec — no separate code).

**Architecture:** New `ui_hints TEXT NULL` column on `global_fields`, JSON-serialized blob with a closed-key vocabulary (`widget`, `label`, `help`, `order`). New optional `ui` param on `create-global-field` and `update-global-field`. Surfaced via `describe-global-field` (top-level key, always present, possibly null) and `describe-schema` (per-claim key). Per-type override is forward-compatible shape only — the v1 per-claim `ui` value is always equal to the global-field `ui`. The audit task is mostly verification; FIELD_OPERATOR_MISMATCH already populates `field`. No watcher / render / pipeline changes.

**Tech Stack:** TypeScript (ESM), better-sqlite3, vitest, zod schemas in `@modelcontextprotocol/sdk`, JSON-as-TEXT column convention.

**Spec:** `docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md`

---

## File map

**New files:**
- `src/global-fields/ui-hints.ts` — `UiHints` type, validator, widget enum, normalize-helper.
- `tests/global-fields/ui-hints.test.ts` — validator + round-trip tests.
- `tests/mcp/issue-field-audit.test.ts` — table-driven assertion that per-field `IssueCode`s populate `field`.

**Modified files:**
- `src/db/migrate.ts` — new `addUiHints(db)` migration.
- `src/index.ts` — wire `addUiHints` into the migration sequence.
- `src/validation/types.ts` — extend `GlobalFieldDefinition` with `ui_hints: UiHints | null` (or import from `ui-hints.ts`).
- `src/global-fields/crud.ts` — accept `ui` in `CreateGlobalFieldInput` / `UpdateGlobalFieldInput`; serialize on write, parse on read; replace-not-merge update semantics; carry `ui_hints` through `renameGlobalField`.
- `src/undo/global-field-snapshot.ts` — add `'ui_hints'` to `GLOBAL_FIELD_COLUMNS` so undo captures it.
- `src/mcp/tools/create-global-field.ts` — zod schema `ui` param; pass through.
- `src/mcp/tools/update-global-field.ts` — zod schema `ui` param; pass through.
- `src/mcp/tools/describe-global-field.ts` — read + return `ui` (always present in response).
- `src/mcp/tools/describe-schema.ts` — return `ui` per claim (always present).
- `tests/global-fields/crud.test.ts` — extend with at least one round-trip case for `ui` (sanity).

**Untouched:** watcher, indexer, embedder, pipeline, render-to-vault (`_fields.yaml`), reconciler, normalizer, search.

---

## Task 1: Add `ui_hints` column migration

**Files:**
- Modify: `src/db/migrate.ts` (add new exported function `addUiHints`)
- Modify: `src/index.ts` (call `addUiHints(db)` in the migration sequence)
- Test: `tests/global-fields/ui-hints.test.ts` (new)

- [ ] **Step 1: Write the failing migration test**

Create `tests/global-fields/ui-hints.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';

describe('addUiHints migration', () => {
  it('adds ui_hints column to global_fields', () => {
    const db = new Database(':memory:');
    createSchema(db);
    addUiHints(db);
    const cols = (db.prepare('PRAGMA table_info(global_fields)').all() as Array<{ name: string }>)
      .map(c => c.name);
    expect(cols).toContain('ui_hints');
  });

  it('is idempotent — running twice does not throw', () => {
    const db = new Database(':memory:');
    createSchema(db);
    addUiHints(db);
    expect(() => addUiHints(db)).not.toThrow();
  });

  it('leaves existing rows with NULL ui_hints', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(
      `INSERT INTO global_fields (name, field_type) VALUES ('status', 'string')`
    ).run();
    addUiHints(db);
    const row = db.prepare(`SELECT ui_hints FROM global_fields WHERE name = 'status'`).get() as { ui_hints: string | null };
    expect(row.ui_hints).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: FAIL — `addUiHints` does not exist on the module.

- [ ] **Step 3: Implement `addUiHints` migration**

Append to `src/db/migrate.ts`:

```typescript
/**
 * Migration: add `ui_hints` column to `global_fields` (2026-05-03).
 *
 * Stores UI rendering hints (widget / label / help / order) as a
 * JSON-serialized object, or NULL when no hints are set. Existing rows stay
 * NULL — bundles fall back to the documented inference table.
 *
 * Spec: docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md
 *
 * Idempotent — safe to run on a database that already has the column.
 */
export function addUiHints(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = (db.prepare('PRAGMA table_info(global_fields)').all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes('ui_hints')) {
      db.prepare('ALTER TABLE global_fields ADD COLUMN ui_hints TEXT').run();
    }
  });
  run();
}
```

- [ ] **Step 4: Wire into the migration sequence**

In `src/index.ts`, update the named import on line 12 and add the call after `addGlobalFieldUndoSnapshots(db);` on line 64.

Change:

```typescript
  addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addGlobalFieldUndoSnapshots,
} from './db/migrate.js';
```

to:

```typescript
  addUndoTables, addNodeTypesSortOrder, addSchemaUndoSnapshots, addGlobalFieldUndoSnapshots,
  addUiHints,
} from './db/migrate.js';
```

And add a line after `addGlobalFieldUndoSnapshots(db);`:

```typescript
addUiHints(db);
```

- [ ] **Step 5: Run test to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: PASS — all three test cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrate.ts src/index.ts tests/global-fields/ui-hints.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add ui_hints column to global_fields

New migration adds ui_hints TEXT NULL for storing UI rendering hints
(widget/label/help/order) on global field definitions. Idempotent;
existing rows stay NULL.

Spec: docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md
EOF
)"
```

---

## Task 2: `UiHints` type + validator module

**Files:**
- Create: `src/global-fields/ui-hints.ts`
- Test: `tests/global-fields/ui-hints.test.ts` (extend the existing file)

- [ ] **Step 1: Append validator tests**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { validateUiHints, normalizeUiHints, UI_WIDGETS } from '../../src/global-fields/ui-hints.js';

describe('UiHints validator', () => {
  it('accepts a fully-populated valid hint object', () => {
    const result = validateUiHints({ widget: 'enum', label: 'Status', help: 'Workflow state', order: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ widget: 'enum', label: 'Status', help: 'Workflow state', order: 10 });
    }
  });

  it('accepts an empty object as valid', () => {
    const result = validateUiHints({});
    expect(result.ok).toBe(true);
  });

  it('accepts a partial object (subset of keys)', () => {
    const result = validateUiHints({ label: 'Title only' });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown keys', () => {
    const result = validateUiHints({ widget: 'text', made_up: 'nope' } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown key/i);
  });

  it('rejects out-of-enum widget', () => {
    const result = validateUiHints({ widget: 'rainbow' } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/widget/i);
  });

  it('rejects label longer than 80 chars', () => {
    const result = validateUiHints({ label: 'x'.repeat(81) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/label/i);
  });

  it('rejects help longer than 280 chars', () => {
    const result = validateUiHints({ help: 'x'.repeat(281) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/help/i);
  });

  it('rejects non-integer order', () => {
    const result = validateUiHints({ order: 1.5 } as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it('accepts negative integer order', () => {
    const result = validateUiHints({ order: -10 });
    expect(result.ok).toBe(true);
  });

  it('exposes the eight valid widgets', () => {
    expect(UI_WIDGETS).toEqual(['text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags']);
  });

  it('normalizes empty object to null', () => {
    expect(normalizeUiHints({})).toBeNull();
  });

  it('normalizes null to null', () => {
    expect(normalizeUiHints(null)).toBeNull();
  });

  it('returns a populated object as-is', () => {
    expect(normalizeUiHints({ label: 'X' })).toEqual({ label: 'X' });
  });
});
```

- [ ] **Step 2: Run test to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: FAIL — `validateUiHints`, `normalizeUiHints`, `UI_WIDGETS` undefined.

- [ ] **Step 3: Create the validator module**

Create `src/global-fields/ui-hints.ts`:

```typescript
// src/global-fields/ui-hints.ts
//
// UiHints — closed-vocabulary rendering hints stored on global fields.
// Spec: docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md

export const UI_WIDGETS = [
  'text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags',
] as const;

export type UiWidget = (typeof UI_WIDGETS)[number];

export interface UiHints {
  widget?: UiWidget;
  label?: string;
  help?: string;
  order?: number;
}

const ALLOWED_KEYS = new Set<string>(['widget', 'label', 'help', 'order']);
const LABEL_MAX = 80;
const HELP_MAX = 280;

export type ValidateResult =
  | { ok: true; value: UiHints }
  | { ok: false; reason: string };

export function validateUiHints(input: unknown): ValidateResult {
  if (input === null || input === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'ui must be an object' };
  }

  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: `ui has unknown key '${key}' (allowed: ${[...ALLOWED_KEYS].join(', ')})` };
    }
  }

  const out: UiHints = {};

  if ('widget' in obj) {
    const w = obj.widget;
    if (typeof w !== 'string' || !(UI_WIDGETS as readonly string[]).includes(w)) {
      return { ok: false, reason: `ui.widget must be one of ${UI_WIDGETS.join(', ')}` };
    }
    out.widget = w as UiWidget;
  }

  if ('label' in obj) {
    const l = obj.label;
    if (typeof l !== 'string') return { ok: false, reason: 'ui.label must be a string' };
    if (l.length > LABEL_MAX) return { ok: false, reason: `ui.label must be ≤ ${LABEL_MAX} chars` };
    out.label = l;
  }

  if ('help' in obj) {
    const h = obj.help;
    if (typeof h !== 'string') return { ok: false, reason: 'ui.help must be a string' };
    if (h.length > HELP_MAX) return { ok: false, reason: `ui.help must be ≤ ${HELP_MAX} chars` };
    out.help = h;
  }

  if ('order' in obj) {
    const o = obj.order;
    if (typeof o !== 'number' || !Number.isFinite(o) || !Number.isInteger(o)) {
      return { ok: false, reason: 'ui.order must be a finite integer' };
    }
    out.order = o;
  }

  return { ok: true, value: out };
}

/**
 * Convert an authored UiHints input into the value to persist:
 *   - null / undefined / empty object → null (clear hints)
 *   - non-empty object → the object as-is
 *
 * Caller is responsible for running validateUiHints first.
 */
export function normalizeUiHints(value: UiHints | null | undefined): UiHints | null {
  if (value === null || value === undefined) return null;
  if (Object.keys(value).length === 0) return null;
  return value;
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: PASS — all validator tests pass plus the migration tests from Task 1.

- [ ] **Step 5: Commit**

```bash
git add src/global-fields/ui-hints.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(global-fields): add UiHints validator with closed-key vocabulary"
```

---

## Task 3: Extend `GlobalFieldDefinition` with `ui_hints`

**Files:**
- Modify: `src/validation/types.ts:9-19` (the `GlobalFieldDefinition` interface)

- [ ] **Step 1: Add `ui_hints` to the type**

In `src/validation/types.ts`, modify the `GlobalFieldDefinition` interface:

Replace:

```typescript
export interface GlobalFieldDefinition {
  name: string;
  field_type: FieldType;
  enum_values: string[] | null;
  reference_target: string | null;
  description: string | null;
  default_value: unknown;
  required: boolean;
  overrides_allowed: OverridesAllowed;
  list_item_type: FieldType | null;
}
```

with:

```typescript
import type { UiHints } from '../global-fields/ui-hints.js';

export interface GlobalFieldDefinition {
  name: string;
  field_type: FieldType;
  enum_values: string[] | null;
  reference_target: string | null;
  description: string | null;
  default_value: unknown;
  required: boolean;
  overrides_allowed: OverridesAllowed;
  list_item_type: FieldType | null;
  ui_hints: UiHints | null;
}
```

(Place the `import type` line near the top of the file alongside the existing imports, not inside the interface.)

- [ ] **Step 2: Build to confirm typecheck still passes**

Run: `npm run build`
Expected: TS errors at every place that constructs a `GlobalFieldDefinition` without `ui_hints` (mainly `src/global-fields/crud.ts` `rowToDefinition` and `renameGlobalField`'s INSERT). Those are fixed in the next task — leave for now.

- [ ] **Step 3: Commit**

```bash
git add src/validation/types.ts
git commit -m "types: add ui_hints to GlobalFieldDefinition"
```

(Build is intentionally broken between this commit and Task 4; that's OK because each task is small and the next commit immediately repairs it.)

---

## Task 4: CRUD layer — read + create

**Files:**
- Modify: `src/global-fields/crud.ts`

- [ ] **Step 1: Add a failing round-trip test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { createGlobalField, getGlobalField, updateGlobalField } from '../../src/global-fields/crud.js';
import { addUiHints } from '../../src/db/migrate.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  createSchema(db);
  addUiHints(db);
  return db;
}

describe('CRUD round-trip for ui_hints', () => {
  it('createGlobalField persists ui hints', () => {
    const db = setupDb();
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'done'],
      ui: { widget: 'enum', label: 'Status', order: 10 },
    });
    const def = getGlobalField(db, 'status');
    expect(def?.ui_hints).toEqual({ widget: 'enum', label: 'Status', order: 10 });
  });

  it('createGlobalField with no ui leaves ui_hints null', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'note', field_type: 'string' });
    const def = getGlobalField(db, 'note');
    expect(def?.ui_hints).toBeNull();
  });

  it('createGlobalField with ui: {} stores null', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'note', field_type: 'string', ui: {} });
    const def = getGlobalField(db, 'note');
    expect(def?.ui_hints).toBeNull();
  });

  it('createGlobalField rejects invalid ui', () => {
    const db = setupDb();
    expect(() => createGlobalField(db, {
      name: 'bad',
      field_type: 'string',
      ui: { widget: 'rainbow' } as unknown as Record<string, unknown>,
    })).toThrow(/widget/);
  });
});
```

- [ ] **Step 2: Run test to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: FAIL — `CreateGlobalFieldInput` doesn't accept `ui`; `getGlobalField` doesn't return `ui_hints`.

- [ ] **Step 3: Update `CreateGlobalFieldInput` shape**

In `src/global-fields/crud.ts`, modify `CreateGlobalFieldInput` (lines 9-19):

Replace:

```typescript
export interface CreateGlobalFieldInput {
  name: string;
  field_type: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
}
```

with:

```typescript
import type { UiHints } from './ui-hints.js';
import { validateUiHints, normalizeUiHints } from './ui-hints.js';

export interface CreateGlobalFieldInput {
  name: string;
  field_type: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
  ui?: UiHints | null;
}
```

(Place the imports at the top of the file alongside the existing `coerceValue` import.)

- [ ] **Step 4: Update `GlobalFieldRow` and `rowToDefinition`**

Modify the row interface (lines 99-111) and `rowToDefinition` (lines 113-129).

Replace:

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
}

function rowToDefinition(row: GlobalFieldRow): GlobalFieldDefinition {
  return {
    name: row.name,
    field_type: row.field_type as FieldType,
    enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
    reference_target: row.reference_target,
    description: row.description,
    default_value: row.default_value !== null ? JSON.parse(row.default_value) : null,
    required: row.required === 1,
    overrides_allowed: {
      required: row.overrides_allowed_required === 1,
      default_value: row.overrides_allowed_default_value === 1,
      enum_values: row.overrides_allowed_enum_values === 1,
    },
    list_item_type: row.list_item_type as FieldType | null,
  };
}
```

with:

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
  ui_hints: string | null;
}

function rowToDefinition(row: GlobalFieldRow): GlobalFieldDefinition {
  return {
    name: row.name,
    field_type: row.field_type as FieldType,
    enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
    reference_target: row.reference_target,
    description: row.description,
    default_value: row.default_value !== null ? JSON.parse(row.default_value) : null,
    required: row.required === 1,
    overrides_allowed: {
      required: row.overrides_allowed_required === 1,
      default_value: row.overrides_allowed_default_value === 1,
      enum_values: row.overrides_allowed_enum_values === 1,
    },
    list_item_type: row.list_item_type as FieldType | null,
    ui_hints: row.ui_hints !== null ? JSON.parse(row.ui_hints) as UiHints : null,
  };
}
```

- [ ] **Step 5: Update `createGlobalField` INSERT**

In `src/global-fields/crud.ts`, modify the body of `createGlobalField` (lines 145-202):

After the existing validations (the three `Validate ...` blocks ending at the `if (input.list_item_type === 'list')` check), add the `ui` validation + serialization:

```typescript
  // Validate + normalize ui hints
  let uiHintsJson: string | null = null;
  if (input.ui !== undefined) {
    const validated = validateUiHints(input.ui);
    if (!validated.ok) {
      throw new Error(validated.reason);
    }
    const normalized = normalizeUiHints(validated.value);
    uiHintsJson = normalized !== null ? JSON.stringify(normalized) : null;
  }
```

Then update the INSERT to include the new column. Replace:

```typescript
  try {
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.field_type,
      enumValues,
      input.reference_target ?? null,
      input.description ?? null,
      defaultValue,
      input.required ? 1 : 0,
      input.overrides_allowed?.required ? 1 : 0,
      input.overrides_allowed?.default_value ? 1 : 0,
      input.overrides_allowed?.enum_values ? 1 : 0,
      input.list_item_type ?? null,
    );
```

with:

```typescript
  try {
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type, ui_hints)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.field_type,
      enumValues,
      input.reference_target ?? null,
      input.description ?? null,
      defaultValue,
      input.required ? 1 : 0,
      input.overrides_allowed?.required ? 1 : 0,
      input.overrides_allowed?.default_value ? 1 : 0,
      input.overrides_allowed?.enum_values ? 1 : 0,
      input.list_item_type ?? null,
      uiHintsJson,
    );
```

- [ ] **Step 6: Run test to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: PASS — all four CRUD round-trip tests pass.

- [ ] **Step 7: Run the full crud test suite to confirm no regression**

Run: `npx vitest run tests/global-fields/`
Expected: PASS — both `crud.test.ts` and `ui-hints.test.ts` pass.

- [ ] **Step 8: Commit**

```bash
git add src/global-fields/crud.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(global-fields): create + read ui_hints round-trip"
```

---

## Task 5: CRUD layer — `updateGlobalField` (replace-not-merge)

**Files:**
- Modify: `src/global-fields/crud.ts:206-405` (the `updateGlobalField` function)

- [ ] **Step 1: Add failing update tests**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
describe('updateGlobalField ui semantics', () => {
  it('absent ui key leaves stored hints intact', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A', help: 'B' } });
    updateGlobalField(db, 'f', { description: 'no ui change' });
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'A', help: 'B' });
  });

  it('ui: null clears stored hints', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });
    updateGlobalField(db, 'f', { ui: null });
    expect(getGlobalField(db, 'f')?.ui_hints).toBeNull();
  });

  it('ui: {} clears stored hints', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });
    updateGlobalField(db, 'f', { ui: {} });
    expect(getGlobalField(db, 'f')?.ui_hints).toBeNull();
  });

  it('replace-not-merge: previous keys not in new object are dropped', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A', help: 'B' } });
    updateGlobalField(db, 'f', { ui: { label: 'X' } });
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'X' });
  });

  it('rejects invalid ui on update', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string' });
    expect(() => updateGlobalField(db, 'f', {
      ui: { widget: 'rainbow' } as unknown as Record<string, unknown>,
    })).toThrow(/widget/);
  });
});
```

- [ ] **Step 2: Run test to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "updateGlobalField ui semantics"`
Expected: FAIL — `UpdateGlobalFieldInput` lacks `ui`; updates ignore it.

- [ ] **Step 3: Extend `UpdateGlobalFieldInput`**

In `src/global-fields/crud.ts:21-32`, replace:

```typescript
export interface UpdateGlobalFieldInput {
  field_type?: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
  confirm?: boolean;
  discard_uncoercible?: boolean;
}
```

with:

```typescript
export interface UpdateGlobalFieldInput {
  field_type?: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
  ui?: UiHints | null;
  confirm?: boolean;
  discard_uncoercible?: boolean;
}
```

- [ ] **Step 4: Wire `ui` into the non-type-change branch**

In `src/global-fields/crud.ts`, inside `updateGlobalField`, find the non-type-change branch — the section that builds the `updates`/`params` arrays for `UPDATE global_fields SET ...`. Add a `ui` handler. After the `if (input.overrides_allowed !== undefined)` block (before the `if (updates.length > 0)` check), add:

```typescript
    if (input.ui !== undefined) {
      const validated = validateUiHints(input.ui);
      if (!validated.ok) {
        throw new Error(validated.reason);
      }
      const normalized = normalizeUiHints(validated.value);
      updates.push('ui_hints = ?');
      params.push(normalized !== null ? JSON.stringify(normalized) : null);
    }
```

This implements **replace-not-merge** because the column is overwritten with the new value (or NULL); previous JSON content is not read.

The type-change branch (the `// Type change path` block) does not need to handle `ui` because in v1 the only thing that triggers a type-change is `field_type` differing; `ui` updates flow through the non-type-change branch when `field_type` is omitted or unchanged.

If the caller sends both `field_type` (type change) AND `ui`, the type-change path's `applyTx` already rebuilds the `gfUpdates`/`gfParams` arrays — extend that block too. Find this region inside the `applyTx`:

```typescript
    if (input.reference_target !== undefined) {
      gfUpdates.push('reference_target = ?');
      gfParams.push(input.reference_target);
    }
```

Add immediately after it:

```typescript
    if (input.ui !== undefined) {
      const validated = validateUiHints(input.ui);
      if (!validated.ok) {
        throw new Error(validated.reason);
      }
      const normalized = normalizeUiHints(validated.value);
      gfUpdates.push('ui_hints = ?');
      gfParams.push(normalized !== null ? JSON.stringify(normalized) : null);
    }
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts`
Expected: PASS — all `updateGlobalField` cases pass.

- [ ] **Step 6: Run full crud test to confirm no regression**

Run: `npx vitest run tests/global-fields/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/global-fields/crud.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(global-fields): support ui hints on updateGlobalField (replace-not-merge)"
```

---

## Task 6: Carry `ui_hints` through `renameGlobalField`

**Files:**
- Modify: `src/global-fields/crud.ts:409-458` (the `renameGlobalField` function)

- [ ] **Step 1: Add a failing rename test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { renameGlobalField } from '../../src/global-fields/crud.js';

describe('renameGlobalField preserves ui hints', () => {
  it('carries ui_hints from old name to new name', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'old', field_type: 'string', ui: { label: 'L', order: 5 } });
    renameGlobalField(db, 'old', 'newname');
    expect(getGlobalField(db, 'old')).toBeNull();
    const renamed = getGlobalField(db, 'newname');
    expect(renamed?.ui_hints).toEqual({ label: 'L', order: 5 });
  });

  it('null ui_hints stays null after rename', () => {
    const db = setupDb();
    createGlobalField(db, { name: 'old', field_type: 'string' });
    renameGlobalField(db, 'old', 'newname');
    expect(getGlobalField(db, 'newname')?.ui_hints).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "renameGlobalField"`
Expected: FAIL — the INSERT in `renameGlobalField` doesn't include `ui_hints`, so it's lost (becomes NULL).

- [ ] **Step 3: Update `renameGlobalField` INSERT**

In `src/global-fields/crud.ts:419-436`, replace the INSERT block:

```typescript
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newName,
      current.field_type,
      current.enum_values ? JSON.stringify(current.enum_values) : null,
      current.reference_target,
      current.description,
      current.default_value !== null ? JSON.stringify(current.default_value) : null,
      current.required ? 1 : 0,
      current.overrides_allowed.required ? 1 : 0,
      current.overrides_allowed.default_value ? 1 : 0,
      current.overrides_allowed.enum_values ? 1 : 0,
      current.list_item_type,
    );
```

with:

```typescript
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type, ui_hints)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newName,
      current.field_type,
      current.enum_values ? JSON.stringify(current.enum_values) : null,
      current.reference_target,
      current.description,
      current.default_value !== null ? JSON.stringify(current.default_value) : null,
      current.required ? 1 : 0,
      current.overrides_allowed.required ? 1 : 0,
      current.overrides_allowed.default_value ? 1 : 0,
      current.overrides_allowed.enum_values ? 1 : 0,
      current.list_item_type,
      current.ui_hints !== null ? JSON.stringify(current.ui_hints) : null,
    );
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "renameGlobalField"`
Expected: PASS — both rename cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/global-fields/crud.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(global-fields): carry ui_hints through renameGlobalField"
```

---

## Task 7: Add `ui_hints` to undo snapshot column list

**Files:**
- Modify: `src/undo/global-field-snapshot.ts:8-20` (the `GLOBAL_FIELD_COLUMNS` constant)

- [ ] **Step 1: Add a failing undo test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { captureGlobalFieldSnapshot, restoreGlobalFieldSnapshot } from '../../src/undo/global-field-snapshot.js';
import { addUndoTables, addGlobalFieldUndoSnapshots } from '../../src/db/migrate.js';

function setupDbWithUndo(): Database.Database {
  const db = new Database(':memory:');
  createSchema(db);
  addUiHints(db);
  addUndoTables(db);
  addGlobalFieldUndoSnapshots(db);
  return db;
}

describe('undo snapshot captures ui_hints', () => {
  it('restores ui_hints after a destructive update', () => {
    const db = setupDbWithUndo();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'Original', order: 1 } });

    const op = createOperation(db, { source_tool: 'test', description: 'update ui' });
    captureGlobalFieldSnapshot(db, op, 'f');
    updateGlobalField(db, 'f', { ui: { label: 'Changed', order: 99 } });
    finalizeOperation(db, op);

    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'Changed', order: 99 });

    restoreGlobalFieldSnapshot(db, op, 'f');
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'Original', order: 1 });
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "undo snapshot"`
Expected: FAIL — `ui_hints` is not in `GLOBAL_FIELD_COLUMNS`, so snapshot capture omits it; restore inserts NULL into `ui_hints`.

- [ ] **Step 3: Add `ui_hints` to `GLOBAL_FIELD_COLUMNS`**

In `src/undo/global-field-snapshot.ts:8-20`, replace:

```typescript
export const GLOBAL_FIELD_COLUMNS = [
  'name',
  'field_type',
  'enum_values',
  'reference_target',
  'description',
  'default_value',
  'required',
  'overrides_allowed_required',
  'overrides_allowed_default_value',
  'overrides_allowed_enum_values',
  'list_item_type',
] as const;
```

with:

```typescript
export const GLOBAL_FIELD_COLUMNS = [
  'name',
  'field_type',
  'enum_values',
  'reference_target',
  'description',
  'default_value',
  'required',
  'overrides_allowed_required',
  'overrides_allowed_default_value',
  'overrides_allowed_enum_values',
  'list_item_type',
  'ui_hints',
] as const;
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "undo snapshot"`
Expected: PASS.

- [ ] **Step 5: Run the existing global-field undo test to confirm no regression**

Run: `npx vitest run tests/mcp/global-field-undo.test.ts`
Expected: PASS — existing undo behavior preserved (the new column has NULL for these test fixtures, which round-trips fine).

- [ ] **Step 6: Commit**

```bash
git add src/undo/global-field-snapshot.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(undo): include ui_hints in global field snapshot capture"
```

---

## Task 8: MCP tool — `create-global-field` accepts `ui`

**Files:**
- Modify: `src/mcp/tools/create-global-field.ts`

- [ ] **Step 1: Add a failing tool-level test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateGlobalField } from '../../src/mcp/tools/create-global-field.js';

interface ToolEnvelope { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

function callCreateGlobalField(server: McpServer, params: Record<string, unknown>): ToolEnvelope {
  // Walk the registered tool list to find the registered handler.
  // The Mcp SDK exposes this via internals; if not stable, replace this helper
  // with the same approach used by tests/mcp/global-field-undo.test.ts.
  const tool = (server as unknown as { _registeredTools?: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools?.get('create-global-field');
  if (!tool) throw new Error('create-global-field not registered');
  return tool.callback(params).then((res: { content: Array<{ type: string; text: string }> }) => JSON.parse(res.content[0].text)) as unknown as ToolEnvelope;
}
```

If the helper above doesn't match the project convention, use the existing `callTool` helper from `tests/mcp/global-field-undo.test.ts`. Inspect that file (`tests/mcp/global-field-undo.test.ts:1-60`) and copy the helper signature.

Then add the actual test:

```typescript
describe('create-global-field MCP tool accepts ui', () => {
  it('passes ui through to createGlobalField', async () => {
    const db = setupDb();
    const server = new McpServer({ name: 'test', version: '0' });
    registerCreateGlobalField(server, db);
    const env = await callCreateGlobalField(server, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'done'],
      ui: { widget: 'enum', label: 'Status' },
    });
    expect(env.ok).toBe(true);
    expect(getGlobalField(db, 'status')?.ui_hints).toEqual({ widget: 'enum', label: 'Status' });
  });

  it('rejects invalid ui at the MCP layer', async () => {
    const db = setupDb();
    const server = new McpServer({ name: 'test', version: '0' });
    registerCreateGlobalField(server, db);
    const env = await callCreateGlobalField(server, {
      name: 'bad',
      field_type: 'string',
      ui: { widget: 'rainbow' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('INVALID_PARAMS');
  });
});
```

(If the project uses `tests/helpers/` for an existing `callTool`, prefer that.)

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "create-global-field MCP"`
Expected: FAIL — zod schema doesn't include `ui`; the tool drops it.

- [ ] **Step 3: Add `ui` to the zod schema**

In `src/mcp/tools/create-global-field.ts:16-30`, replace the params object passed to `server.tool(...)`:

```typescript
    {
      name: z.string().describe('Unique field name'),
      field_type: fieldTypeEnum.describe('Field type'),
      enum_values: z.array(z.string()).optional().describe('Allowed values (required when field_type is enum)'),
      reference_target: z.string().optional().describe('Target schema type for reference fields'),
      description: z.string().optional().describe('Human-readable description'),
      default_value: z.unknown().optional().describe('Default value for this field'),
      required: z.boolean().optional().describe('Whether this field is required by default'),
      list_item_type: fieldTypeEnum.optional().describe('Item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
    },
```

with:

```typescript
    {
      name: z.string().describe('Unique field name'),
      field_type: fieldTypeEnum.describe('Field type'),
      enum_values: z.array(z.string()).optional().describe('Allowed values (required when field_type is enum)'),
      reference_target: z.string().optional().describe('Target schema type for reference fields'),
      description: z.string().optional().describe('Human-readable description'),
      default_value: z.unknown().optional().describe('Default value for this field'),
      required: z.boolean().optional().describe('Whether this field is required by default'),
      list_item_type: fieldTypeEnum.optional().describe('Item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      ui: z.object({
        widget: z.enum(['text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags']).optional(),
        label: z.string().max(80).optional(),
        help: z.string().max(280).optional(),
        order: z.number().int().optional(),
      }).nullable().optional().describe('UI rendering hints (widget/label/help/order). Pass null or {} to clear.'),
    },
```

The handler body already passes `params` straight to `createGlobalField`, which now accepts `ui`. No body change is needed because `params.ui` is forwarded transparently.

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "create-global-field MCP"`
Expected: PASS.

- [ ] **Step 5: Run all related tests**

Run: `npx vitest run tests/global-fields/ tests/mcp/global-field-undo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/create-global-field.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(mcp): create-global-field accepts ui hints"
```

---

## Task 9: MCP tool — `update-global-field` accepts `ui`

**Files:**
- Modify: `src/mcp/tools/update-global-field.ts`

- [ ] **Step 1: Add a failing tool-level test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { registerUpdateGlobalField } from '../../src/mcp/tools/update-global-field.js';

describe('update-global-field MCP tool accepts ui', () => {
  it('updates ui hints on an existing field', async () => {
    const db = setupDbWithUndo();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });

    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateGlobalField(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('update-global-field')!;
    const res = await tool.callback({ name: 'f', ui: { label: 'B', order: 7 } });
    const env = JSON.parse(res.content[0].text);
    expect(env.ok).toBe(true);
    expect(getGlobalField(db, 'f')?.ui_hints).toEqual({ label: 'B', order: 7 });
  });

  it('clears ui hints with ui: null', async () => {
    const db = setupDbWithUndo();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { label: 'A' } });
    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateGlobalField(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('update-global-field')!;
    const res = await tool.callback({ name: 'f', ui: null });
    const env = JSON.parse(res.content[0].text);
    expect(env.ok).toBe(true);
    expect(getGlobalField(db, 'f')?.ui_hints).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "update-global-field MCP"`
Expected: FAIL — zod doesn't accept `ui`.

- [ ] **Step 3: Add `ui` to the zod schema**

In `src/mcp/tools/update-global-field.ts:19-35`, replace the params object:

```typescript
    {
      name: z.string().describe('Field name to update'),
      field_type: fieldTypeEnum.optional().describe('New field type (triggers type-change flow if different)'),
      enum_values: z.array(z.string()).optional().describe('New allowed values for enum fields'),
      reference_target: z.string().optional().describe('New target schema type for reference fields'),
      description: z.string().optional().describe('New description'),
      default_value: z.unknown().optional().describe('New default value'),
      required: z.boolean().optional().describe('New required flag'),
      list_item_type: fieldTypeEnum.optional().describe('New item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      confirm: z.boolean().optional().describe('Set true to apply a type change (otherwise previews impact)'),
      discard_uncoercible: z.boolean().optional().describe('When applying a type change with uncoercible values, set true to delete those values. Default: refuse the change with CONFIRMATION_REQUIRED.'),
    },
```

with:

```typescript
    {
      name: z.string().describe('Field name to update'),
      field_type: fieldTypeEnum.optional().describe('New field type (triggers type-change flow if different)'),
      enum_values: z.array(z.string()).optional().describe('New allowed values for enum fields'),
      reference_target: z.string().optional().describe('New target schema type for reference fields'),
      description: z.string().optional().describe('New description'),
      default_value: z.unknown().optional().describe('New default value'),
      required: z.boolean().optional().describe('New required flag'),
      list_item_type: fieldTypeEnum.optional().describe('New item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      ui: z.object({
        widget: z.enum(['text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags']).optional(),
        label: z.string().max(80).optional(),
        help: z.string().max(280).optional(),
        order: z.number().int().optional(),
      }).nullable().optional().describe('UI rendering hints. Pass null or {} to clear; absent key = no change; populated object = REPLACE existing hints (no merge).'),
      confirm: z.boolean().optional().describe('Set true to apply a type change (otherwise previews impact)'),
      discard_uncoercible: z.boolean().optional().describe('When applying a type change with uncoercible values, set true to delete those values. Default: refuse the change with CONFIRMATION_REQUIRED.'),
    },
```

The handler body destructures into `name, ...rest` and forwards `rest` to `updateGlobalField`. `ui` flows through unchanged.

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "update-global-field MCP"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/update-global-field.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(mcp): update-global-field accepts ui hints (replace-not-merge)"
```

---

## Task 10: MCP tool — `describe-global-field` returns `ui`

**Files:**
- Modify: `src/mcp/tools/describe-global-field.ts`

- [ ] **Step 1: Add a failing test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { registerDescribeGlobalField } from '../../src/mcp/tools/describe-global-field.js';

describe('describe-global-field returns ui', () => {
  it('returns ui blob when set', async () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string', ui: { widget: 'textarea', label: 'F' } });
    const server = new McpServer({ name: 'test', version: '0' });
    registerDescribeGlobalField(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('describe-global-field')!;
    const res = await tool.callback({ name: 'f' });
    const env = JSON.parse(res.content[0].text);
    expect(env.ok).toBe(true);
    expect(env.data.ui).toEqual({ widget: 'textarea', label: 'F' });
  });

  it('returns ui as null when unset (always present in shape)', async () => {
    const db = setupDb();
    createGlobalField(db, { name: 'f', field_type: 'string' });
    const server = new McpServer({ name: 'test', version: '0' });
    registerDescribeGlobalField(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('describe-global-field')!;
    const res = await tool.callback({ name: 'f' });
    const env = JSON.parse(res.content[0].text);
    expect(env.ok).toBe(true);
    expect('ui' in env.data).toBe(true);
    expect(env.data.ui).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "describe-global-field returns ui"`
Expected: FAIL — response shape lacks `ui`.

- [ ] **Step 3: Update describe-global-field**

In `src/mcp/tools/describe-global-field.ts`, modify the `GlobalFieldRow` interface and the `ok({...})` shape.

Replace lines 6-18:

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
}
```

with:

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
  ui_hints: string | null;
}
```

Then update the `ok({...})` block (lines 54-71). Replace:

```typescript
      return ok({
        name: row.name,
        field_type: row.field_type,
        enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
        reference_target: row.reference_target,
        description: row.description,
        default_value: row.default_value ? JSON.parse(row.default_value) : null,
        required: Boolean(row.required),
        overrides_allowed: {
          required: Boolean(row.overrides_allowed_required),
          default_value: Boolean(row.overrides_allowed_default_value),
          enum_values: Boolean(row.overrides_allowed_enum_values),
        },
        list_item_type: row.list_item_type,
        claimed_by_types,
        node_count: nodeCountRow.count,
        orphan_count: orphanRow.count,
      });
```

with:

```typescript
      return ok({
        name: row.name,
        field_type: row.field_type,
        enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
        reference_target: row.reference_target,
        description: row.description,
        default_value: row.default_value ? JSON.parse(row.default_value) : null,
        required: Boolean(row.required),
        overrides_allowed: {
          required: Boolean(row.overrides_allowed_required),
          default_value: Boolean(row.overrides_allowed_default_value),
          enum_values: Boolean(row.overrides_allowed_enum_values),
        },
        list_item_type: row.list_item_type,
        ui: row.ui_hints !== null ? JSON.parse(row.ui_hints) : null,
        claimed_by_types,
        node_count: nodeCountRow.count,
        orphan_count: orphanRow.count,
      });
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "describe-global-field returns ui"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/describe-global-field.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(mcp): describe-global-field returns ui (always present)"
```

---

## Task 11: MCP tool — `describe-schema` returns `ui` per claim

**Files:**
- Modify: `src/mcp/tools/describe-schema.ts`

- [ ] **Step 1: Add a failing test**

Append to `tests/global-fields/ui-hints.test.ts`:

```typescript
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';

describe('describe-schema returns ui per claim', () => {
  it('includes ui (always present, possibly null) on each claim', async () => {
    const db = setupDb();
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'], ui: { widget: 'enum', label: 'Status', order: 5 } });
    createGlobalField(db, { name: 'note', field_type: 'string' });
    db.prepare('INSERT INTO schemas (name) VALUES (?)').run('task');
    db.prepare('INSERT INTO schema_field_claims (schema_name, field) VALUES (?, ?), (?, ?)')
      .run('task', 'status', 'task', 'note');

    const server = new McpServer({ name: 'test', version: '0' });
    registerDescribeSchema(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('describe-schema')!;
    const res = await tool.callback({ name: 'task' });
    const env = JSON.parse(res.content[0].text);

    expect(env.ok).toBe(true);
    const fieldsByName = new Map((env.data.fields as Array<Record<string, unknown>>).map(f => [f.name, f]));

    const status = fieldsByName.get('status') as Record<string, unknown>;
    expect('ui' in status).toBe(true);
    expect(status.ui).toEqual({ widget: 'enum', label: 'Status', order: 5 });

    const note = fieldsByName.get('note') as Record<string, unknown>;
    expect('ui' in note).toBe(true);
    expect(note.ui).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "describe-schema returns ui"`
Expected: FAIL — claims don't include `ui`.

- [ ] **Step 3: Update describe-schema**

In `src/mcp/tools/describe-schema.ts`, extend `GlobalFieldRow` (lines 26-38) to include `ui_hints: string | null;` and update the per-claim mapping (around lines 73-133).

Replace the `GlobalFieldRow` interface:

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
}
```

with:

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
  ui_hints: string | null;
}
```

Then inside the claim mapping (`const fields = claims.map(claim => { ... });`), find the section that builds the `field` record. Right after the existing optional-field assignments and before the `if (wantOverrides)` block, add:

```typescript
        // ui hints (always present in shape; null when unset).
        // v1: per-claim ui equals the global-field ui (no per-type override).
        field.ui = gf?.ui_hints ? JSON.parse(gf.ui_hints) : null;
```

(That line goes right before `if (wantOverrides) {` inside the `claims.map`.)

If the wantOverrides block also exposes the global_field blob, update it to include `ui_hints`. Inside `if (wantOverrides) { ... }` find the `field.global_field = gf ? { ... } : null;` assignment and add a line for `ui_hints` to mirror the new column. Replace:

```typescript
          field.global_field = gf ? {
            field_type: gf.field_type,
            enum_values: gf.enum_values ? JSON.parse(gf.enum_values) : null,
            reference_target: gf.reference_target,
            description: gf.description,
            default_value: gf.default_value ? JSON.parse(gf.default_value) : null,
            required: Boolean(gf.required),
            overrides_allowed: {
              required: Boolean(gf.overrides_allowed_required),
              default_value: Boolean(gf.overrides_allowed_default_value),
              enum_values: Boolean(gf.overrides_allowed_enum_values),
            },
            list_item_type: gf.list_item_type,
          } : null;
```

with:

```typescript
          field.global_field = gf ? {
            field_type: gf.field_type,
            enum_values: gf.enum_values ? JSON.parse(gf.enum_values) : null,
            reference_target: gf.reference_target,
            description: gf.description,
            default_value: gf.default_value ? JSON.parse(gf.default_value) : null,
            required: Boolean(gf.required),
            overrides_allowed: {
              required: Boolean(gf.overrides_allowed_required),
              default_value: Boolean(gf.overrides_allowed_default_value),
              enum_values: Boolean(gf.overrides_allowed_enum_values),
            },
            list_item_type: gf.list_item_type,
            ui_hints: gf.ui_hints ? JSON.parse(gf.ui_hints) : null,
          } : null;
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/global-fields/ui-hints.test.ts -t "describe-schema returns ui"`
Expected: PASS.

- [ ] **Step 5: Run existing describe-schema test to confirm no regression**

Run: `npx vitest run tests/mcp/describe-schema-compact.test.ts`
Expected: PASS — extra `ui` key on each field is additive; existing assertions about other keys still hold.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/describe-schema.ts tests/global-fields/ui-hints.test.ts
git commit -m "feat(mcp): describe-schema returns ui per claim (always present)"
```

---

## Task 12: Full build + integration verification

**Files:**
- Run-only

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: PASS — typecheck clean.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 3: Cross-check the dry-run defaults table from spec §3**

The spec includes an audit table of `dry_run` defaults. Spot-check by inspecting each tool file:

- `src/mcp/tools/create-node.ts` — confirm `dry_run` defaults to `false`.
- `src/mcp/tools/update-node.ts` — confirm single-node default is `false`, query mode default is `true`.
- `src/mcp/tools/delete-node.ts` — confirm default `false`.
- `src/mcp/tools/add-type-to-node.ts` — confirm default `false`.
- `src/mcp/tools/remove-type-from-node.ts` — confirm default `false`.
- `src/mcp/tools/rename-node.ts` — confirm default `false` (or absent — no dry-run support).
- `src/mcp/tools/batch-mutate.ts` — confirm default `true`.
- `src/mcp/tools/update-schema.ts` — confirm default `true`.
- `src/mcp/tools/update-global-field.ts` — `confirm` flag defaults to absent (preview by default for type-change); confirms the spec.

If any tool's default differs from the spec table, **stop** and update the spec inline (committing as a separate fixup). Do not silently change tool defaults.

- [ ] **Step 4: Commit verification note**

If verifications all pass and the spec table is accurate, no commit needed; advance to Task 13.

If the spec table required correction, commit the spec fixup:

```bash
git add docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md
git commit -m "docs(specs): correct dry-run-default audit table"
```

---

## Task 13: `Issue.field` audit — verification + table-driven test

**Files:**
- Create: `tests/mcp/issue-field-audit.test.ts`

- [ ] **Step 1: Inspect direct `Issue` constructions**

Run a grep to enumerate every direct `Issue` construction outside of `adaptIssue`:

```bash
grep -rn ": Issue\b\|: Issue\[\]\|: Issue |\| Issue =\|Issue<" src/mcp/tools/ --include="*.ts" | grep -v "errors.ts\|title-warnings.ts" | head -30
```

For each match, open the file at the line number and verify:

- If the `code` is per-field (`FIELD_OPERATOR_MISMATCH` and any other per-field code in the contract table), confirm `field: <fieldName>` is set on the Issue object.
- If the `code` is non-per-field (everything else listed in the contract table), confirm `field` is **not** set.

The expected outcome is "no code changes needed." `FIELD_OPERATOR_MISMATCH` is the only per-field direct-construction `IssueCode` and it already sets `field` (`src/mcp/tools/query-nodes.ts:218`). Other constructed codes are all non-per-field.

If any direct construction is found that violates the contract, fix it in this task (small inline edit per site).

- [ ] **Step 2: Write the audit assertion test**

Create `tests/mcp/issue-field-audit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

/**
 * Audit test for the §2.5 Issue.field contract.
 *
 * The contract from the spec
 * (docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md):
 *
 *   - Per-field IssueCodes MUST set issue.field.
 *   - Non-per-field IssueCodes MUST leave issue.field unset.
 *
 * `ValidationIssue.field` is required by type, so the validation path is
 * covered by typecheck. This test focuses on direct Issue constructions
 * inside tool handlers — currently FIELD_OPERATOR_MISMATCH is the only
 * per-field direct-construction code.
 */
describe('Issue.field contract (audit)', () => {
  it('FIELD_OPERATOR_MISMATCH populates issue.field', async () => {
    const db = new Database(':memory:');
    createSchema(db);
    addUiHints(db);
    // status is a list-typed field; using `eq` on a list is a mismatch.
    createGlobalField(db, { name: 'status', field_type: 'list', list_item_type: 'string' });

    const server = new McpServer({ name: 'test', version: '0' });
    registerQueryNodes(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('query-nodes')!;
    const res = await tool.callback({ fields: { status: { eq: 'open' } } });
    const env = JSON.parse(res.content[0].text) as {
      ok: true; data: unknown; warnings: Array<{ code: string; field?: string }>;
    };

    const mismatch = env.warnings.find(w => w.code === 'FIELD_OPERATOR_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch!.field).toBe('status');
  });

  it('CROSS_NODE_FILTER_UNRESOLVED leaves issue.field unset (query-level, not per-field)', async () => {
    const db = new Database(':memory:');
    createSchema(db);
    addUiHints(db);
    createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
    // Insert a node with an unresolved relationship so the warning fires.
    db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('n1', 'a.md', 'A');
    db.prepare(`
      INSERT INTO relationships (source_id, target, rel_type, resolved_target_id)
      VALUES (?, ?, ?, NULL)
    `).run('n1', 'unresolved', 'project');

    const server = new McpServer({ name: 'test', version: '0' });
    registerQueryNodes(server, db);
    const tool = (server as unknown as { _registeredTools: Map<string, { callback: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> })._registeredTools.get('query-nodes')!;
    const res = await tool.callback({
      join_filters: [{ rel_type: 'project', target: { types: ['project'] } }],
    });
    const env = JSON.parse(res.content[0].text) as {
      ok: true; data: unknown; warnings: Array<{ code: string; field?: string }>;
    };

    const cross = env.warnings.find(w => w.code === 'CROSS_NODE_FILTER_UNRESOLVED');
    expect(cross).toBeDefined();
    expect(cross!.field).toBeUndefined();
  });
});
```

(If the second test's setup doesn't match the project's actual fixture conventions, adapt by mirroring `tests/integration/cross-node-query.test.ts`.)

- [ ] **Step 3: Run the audit test**

Run: `npx vitest run tests/mcp/issue-field-audit.test.ts`
Expected: PASS — the existing code already complies with the contract.

If a test fails, fix the offending Issue construction at its source (set `field` for per-field codes; remove `field` for non-per-field codes). Re-run.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/issue-field-audit.test.ts
git commit -m "test(mcp): pin Issue.field contract for per-field warnings"
```

---

## Task 14: Final verification

**Files:**
- Run-only

- [ ] **Step 1: Run the full build + test suite**

Run: `npm run build && npm test`
Expected: All pass.

- [ ] **Step 2: Manual smoke against vault-new.db (optional, recommended for production deploy)**

If the engine is running under systemd:

```bash
# Stop the systemd unit so the migration runs on a non-live DB.
# (Coordinate with user — this implies a brief outage of the live engine.)
sudo systemctl stop vault-engine-new
node dist/index.js --once-migrate-only   # if such a flag exists; otherwise the next start does it
sudo systemctl start vault-engine-new
```

Verify in a SQL session:

```bash
sqlite3 ~/Documents/archbrain/Notes/.vault-engine/vault-new.db "PRAGMA table_info(global_fields);" | grep ui_hints
```

Expected: a row showing `ui_hints | TEXT | 0 | | 0`.

- [ ] **Step 3: End-of-feature commit (if any housekeeping changes accrued)**

If the previous tasks left untracked or modified files unrelated to the feature, decide whether to include them or stash. Otherwise skip.

---

## Done criteria

- All 14 tasks committed.
- `npm run build && npm test` passes from the main branch tip.
- Spec acceptance gate (§"Acceptance gate" in the spec doc) is satisfied.
- The two near-term bundles (status enum dropdown, inline title rename) can be sketched against this implementation:
    - **Status dropdown** uses `describe-schema(name='task')` to discover the `status` claim's `ui` and `enum_values`, renders a dropdown, and writes via `update-node({fields:{status:newValue}})`. UI hints minimal (probably only `enum_values` is consulted since `widget=enum` is inferred from `field_type=enum`).
    - **Inline title rename** uses `rename-node` directly, no UI hints needed (titles aren't fields).
