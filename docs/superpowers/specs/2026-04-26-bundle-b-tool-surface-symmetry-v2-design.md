# Bundle B v2 — Tool Surface Symmetry (Design)

**Status:** spec
**Date:** 2026-04-26
**Predecessor postmortem:** `docs/superpowers/specs/2026-04-25-bundle-b-postmortem.md`
**Decisions adopted from postmortem:** all seven recommendations + the rename-case clarification (see §0)

## §0 — Scope, decisions, non-goals

### In scope (three symmetry items)

1. **Closed-union `Issue.code`** — narrow `Issue.code` from `string` to a closed `IssueCode` union covering every code currently emitted across `src/mcp/tools/`, `src/validation/`, and `src/pipeline/`. Wire-format invariant.
2. **`op_index` on `batch-mutate` warnings** — add optional `op_index?: number` to `Issue`, ship a `tagOpIndex` helper, tag the two existing per-op surfacing sites in `batch-mutate.ts`. No new surfacing.
3. **Global-field undo** — make the four global-field tool handlers participate in the undo system, with capture/restore symmetry across four cases (`was_new`, `was_deleted`, `was_renamed_from`, update). Includes file re-rendering on restore, fresh `global_field_count` migration, and shared column-list constants for capture/restore symmetry.

### Out of scope (filed separately, per postmortem rec #3)

- **Latent bug #1** — `batch-mutate.create` doesn't call `sanitizeFilename` / `checkTitleSafety`. Separate fix; v2 does not bundle.
- **Latent bug #2** — `update-node` query mode silently drops already-present types in `add_types`. Separate fix.
- **Latent bug #3** — `update-global-field` (type-change confirmed) silently deletes uncoercible values. Separate design decision.
- **Surfacing executeMutation/executeDeletion warnings** through `batch-mutate`'s response. Adjacent to `op_index` but a new surface; separate PR.

### Documented, not fixed (per postmortem rec #4)

- **Undo atomicity gap.** `restoreOperation` in `src/undo/restore.ts:98-174` is **not** wrapped in `db.transaction`. Per-snapshot restore is internally atomic, but the loop across multiple snapshots within one `operation_id` is not. A multi-snapshot undo where snapshot N's restore throws leaves snapshots 1..N-1 restored with `markUndone` (line 160) never firing — operation_id stays `'active'` with partial-state semantics. Bundle B v2's global-field restore inherits this gap; it does **not** worsen atomicity. A separate ticket should track wrapping `restoreOperation` (with FS I/O hoisted post-commit).

## §1 — Closed-union `Issue.code`

### Current state

`Issue` at `src/mcp/tools/errors.ts:18-24`:

```ts
export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;
}
```

`code: string` is open. The adjacent failure-envelope union `ErrorCode` (lines 4-16) is already closed. The validation-side union `ValidationIssue.IssueCode` exists at `src/validation/types.ts:97-104`.

### Codes emitted today (verified by grep on `code: '<UPPER_SNAKE>'` in `src/`)

Tool / pipeline / validation warnings: `CROSS_NODE_FILTER_UNRESOLVED, DEPRECATED_PARAM, ENUM_MISMATCH, FIELD_OPERATOR_MISMATCH, FRONTMATTER_IN_BODY, INVALID_PARAMS, LAST_TYPE_REMOVAL, NOT_FOUND, PENDING_REFERENCES, REQUIRED_MISSING, RESULT_TRUNCATED, TITLE_FILENAME_SANITIZED, TITLE_WIKILINK_UNSAFE, TYPE_OP_CONFLICT`.

Validation-side: `REQUIRED_MISSING, ENUM_MISMATCH, TYPE_MISMATCH, COERCION_FAILED, LIST_ITEM_COERCION_FAILED, MERGE_CONFLICT, INTERNAL_CONSISTENCY`.

(Build step verifies the final list — a fresh grep at implementation time may surface additions.)

### Design

1. In `src/mcp/tools/errors.ts`, define a single closed `IssueCode` union — superset of the warning codes and the emitted-validation codes.
2. Retype `Issue.code: IssueCode`.
3. `adaptIssue()` continues to bridge `ValidationIssue` and `ToolIssue`. Both incoming code types must be subsets of `IssueCode` — the function compiles cleanly with no widening.
4. Mechanical sweep of every site that constructs an `Issue` literal or pushes to a `warnings: Issue[]` array. The compiler flags drift.

### What does **not** change

- Wire format (string literals shipped on the wire are unchanged).
- Severity model.
- `ErrorCode` (already closed; not re-litigated).
- Code names (no renames).

### Implication carried forward to §2

`Issue` gains the additional optional field `op_index?: number` in §2, on the same struct.

## §2 — `op_index` on batch-mutate warnings

### Current state

`batch-mutate` (`src/mcp/tools/batch-mutate.ts`) surfaces per-op signals in two places:

- **Success / dry-run path:** `deprecationWarnings: Array<{severity, code, message}>` pushed inside the `for (let i = 0; ...)` loop when an op uses the deprecated `path` alias (lines 145-150). Currently pushed without an op identifier.
- **Error path:** `err.validation.issues.map(adaptIssue)` lands in `error.details.issues` (line 352). The enclosing `batchError` already records `failed_at: i`, but each `Issue` itself isn't tagged.

`executeMutation`/`executeDeletion` may emit additional warnings (e.g., `TITLE_FILENAME_SANITIZED`); `batch-mutate` does **not** currently extract or surface them. That surfacing is out of scope (§0).

### Design

1. Add `op_index?: number` (optional, additive) to `Issue` in `src/mcp/tools/errors.ts`.
2. Add `tagOpIndex(issues: Issue[], opIndex: number): Issue[]` in the same file. Returns a fresh array of fresh objects with `op_index` stamped — no input mutation.
3. Wire two sites in `batch-mutate.ts`:
   - DEPRECATED_PARAM push (line 145-150): set `op_index: i` directly on the literal (single-element case; helper unnecessary).
   - Error-path validation-issue mapping (line 352): wrap with `tagOpIndex(..., i)` so each issue carries the failing op's index.
4. No envelope-shape changes. Single-mode (non-batch) tools never set `op_index` — backward-compatible by virtue of the field being optional.

### Tests

In `tests/mcp/batch-mutate.test.ts` (or split file as the test layout dictates):

- **success path tagging** — batch with two `create` ops, op 1 uses deprecated `path`. Assert response top-level `warnings[0]` has `code: 'DEPRECATED_PARAM'` and `op_index: 1`.
- **error path tagging** — batch where op 2 throws a validation error. Assert `error.details.issues[*].op_index === 1`.
- **non-batch tools unaffected** — pick one single-mode tool test (e.g., `create-node`) and assert that emitted warnings have `op_index === undefined`.

### Non-goal restated

`executeMutation`/`executeDeletion` warnings are **not** routed into batch-mutate's response by this change. The helper and field exist for future use; surfacing is a separate PR.

## §3 — Global-field undo

### Files touched (new + modified)

- **New** — `src/undo/global-field-snapshot.ts` (capture + restore module)
- **New** — `tests/undo/global-field-snapshot.test.ts` (unit + integration coverage of all four cases)
- **New** — `tests/db/global-field-undo-migration.test.ts` (mirrors `undo-tables-migration.test.ts`)
- **Modified** — `src/db/migrate.ts` (new `addGlobalFieldUndoSnapshots` function)
- **Modified** — `src/undo/types.ts` (`UndoOperationRow.global_field_count: number`)
- **Modified** — `src/undo/restore.ts` (new global-field pass before schema pass in `restoreOperation`; `RestoreOptions`/`RestoreManyParams` gain `syncLogger?: SyncLogger`)
- **Modified** — `src/mcp/tools/undo-operations.ts` (accept and forward `syncLogger` to `restoreMany`)
- **Modified** — `src/undo/schema-snapshot.ts` (extract shared column-list constant for `schema_field_claims` capture/restore — symmetry refactor per postmortem rec #6)
- **Modified** — `src/mcp/tools/list-undo-history.ts` (projection adds `global_field_count`)
- **Modified** — `src/mcp/tools/create-global-field.ts` (operation lifecycle)
- **Modified** — `src/mcp/tools/delete-global-field.ts` (operation lifecycle)
- **Modified** — `src/mcp/tools/rename-global-field.ts` (operation lifecycle)
- **Modified** — `src/mcp/tools/update-global-field.ts` (operation lifecycle, gated by `willMutate`)

### Verified codebase facts (re-stated for spec audit)

- `Issue` interface: `src/mcp/tools/errors.ts` (postmortem-confirmed, NOT `src/mcp/errors.ts`).
- `global_fields` columns: `name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type` (`src/db/schema.ts:30-42`, `src/db/migrate.ts:152-162`).
- `schema_field_claims` columns: `schema_name, field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override` (`src/db/schema.ts:54-66`).
- `FieldType` values: `'string' | 'number' | 'date' | 'boolean' | 'reference' | 'enum' | 'list'` (`src/validation/types.ts:23`).
- `rename-global-field` params: `old_name, new_name` (not `from`/`to`).
- `update-global-field` type-change confirm flag: `confirm` (not `confirm_type_change`).
- `list-global-fields` returns `data` as a flat array of fields.
- `describe-schema` returns `{ fields: [...] }`.
- `undo-operations` defaults `dry_run: true` — round-trip tests must pass `dry_run: false`.
- Schema files in `.schemas/` are `.yaml`. Fields catalog is `.schemas/_fields.yaml`.
- Render helpers: `renderFieldsFile(db, vaultPath)`, `renderSchemaFile(db, vaultPath, schemaName)`, `rerenderNodesWithField(db, writeLock, vaultPath, fieldName, undefined, syncLogger)`.
- Schema undo's render call lives at `src/undo/schema-snapshot.ts:176`.
- `undo_operations` columns today: `operation_id, timestamp, source_tool, description, node_count, schema_count, status` (no `global_field_count` — fresh column).
- `restoreOperation` is not wrapped in `db.transaction` (`src/undo/restore.ts:135-161`). Atomicity gap acknowledged in §0.
- The four global-field tool handlers do **not** currently touch the undo system. v2 wires them from scratch.

### §3.1 — Migration: `addGlobalFieldUndoSnapshots`

New function in `src/db/migrate.ts`, idempotent, mirrors `addSchemaUndoSnapshots` (`migrate.ts:389-417`). Wrapped in a `db.transaction`. Per the migration-ordering rule, all `CREATE INDEX` lives in this migration, not in `createSchema`.

```sql
-- 1. New column on undo_operations (gated)
ALTER TABLE undo_operations ADD COLUMN global_field_count INTEGER NOT NULL DEFAULT 0;
-- (only if not already present — PRAGMA table_info gate)

-- 2. Parent snapshot table
CREATE TABLE IF NOT EXISTS undo_global_field_snapshots (
  operation_id                       TEXT NOT NULL,
  field_name                         TEXT NOT NULL,
  was_new                            INTEGER NOT NULL DEFAULT 0,
  was_deleted                        INTEGER NOT NULL DEFAULT 0,
  renamed_to                         TEXT,                       -- NULL except for rename
  -- captured global_fields columns (NULL when was_new=1)
  field_type                         TEXT,
  enum_values                        TEXT,
  reference_target                   TEXT,
  description                        TEXT,
  default_value                      TEXT,
  required                           INTEGER,
  overrides_allowed_required         INTEGER,
  overrides_allowed_default_value    INTEGER,
  overrides_allowed_enum_values      INTEGER,
  list_item_type                     TEXT,
  PRIMARY KEY (operation_id, field_name),
  FOREIGN KEY (operation_id) REFERENCES undo_operations(operation_id) ON DELETE CASCADE
);

-- 3. Cascade table — single-table-with-discriminator (postmortem-aligned shape)
CREATE TABLE IF NOT EXISTS undo_global_field_value_snapshots (
  operation_id              TEXT NOT NULL,
  field_name                TEXT NOT NULL,
  kind                      TEXT NOT NULL CHECK (kind IN ('claim','node_field')),
  -- claim-side columns (kind = 'claim'):
  schema_name               TEXT,
  label                     TEXT,
  description               TEXT,
  sort_order                INTEGER,
  required_override         INTEGER,
  default_value_override    TEXT,
  default_value_overridden  INTEGER,
  enum_values_override      TEXT,
  -- node-field-side columns (kind = 'node_field'):
  node_id                   TEXT,
  value_text                TEXT,
  value_number              REAL,
  value_date                TEXT,
  value_json                TEXT,
  value_raw_text            TEXT,
  FOREIGN KEY (operation_id, field_name)
    REFERENCES undo_global_field_snapshots(operation_id, field_name)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_undo_gf_snapshots_op
  ON undo_global_field_snapshots(operation_id);
```

The `kind` discriminator column splits population: `kind='claim'` rows populate the claim-side columns and leave node-field-side NULL; `kind='node_field'` rows populate the node-field-side columns and leave claim-side NULL. CHECK enforces the discriminator's value space; population correctness is enforced by capture-side code (no DB-level CHECK on cross-column nullness — application invariant only).

Cleanup is implicit: deleting an `undo_operations` row cascades to the parent snapshot, which cascades to the value-snapshot rows. No orphan sweep needed beyond the existing 24h sweep on `undo_operations`.

### §3.2 — Capture/restore module: `src/undo/global-field-snapshot.ts`

#### Public surface

```ts
export interface GlobalFieldCaptureOptions {
  was_new?: boolean;
  was_deleted?: boolean;
  renamed_to?: string;        // present iff this is a rename capture
  capture_node_fields?: boolean;  // set by update-handler for type-change path
}

export function captureGlobalFieldSnapshot(
  db: Database.Database,
  operation_id: string,
  field_name: string,
  opts?: GlobalFieldCaptureOptions,
): void;

export function restoreGlobalFieldSnapshot(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger: SyncLogger | undefined,
  operation_id: string,
  field_name: string,
): void;
```

#### Capture dispatch (called BEFORE the mutation, with `INSERT OR IGNORE` for handler-shared op_id idempotency)

| Case | Parent row data | Cascade rows |
|------|-----------------|--------------|
| `was_new` | marker (all column data NULL) | none |
| `was_deleted` | captured `global_fields` row at `field_name` | one `kind='claim'` row per `schema_field_claims` row pointing to `field_name`. **No** `node_field` cascade — `deleteGlobalField` preserves `node_fields` rows as orphans. |
| `renamed_to=newName` | captured `global_fields` row at the **old** name (which is `field_name` at capture time) | none — restore handles via `UPDATE schema_field_claims SET field=?` and `UPDATE node_fields SET field_name=?` |
| update | captured `global_fields` row at `field_name` | if `capture_node_fields` is true: one `kind='node_field'` row per `node_fields` row for `field_name` |

#### Restore dispatch (each branch ends with file re-rendering)

The order of operations within each branch: **DB writes first, file rendering last**. File rendering reads from DB and is invoked once the DB state matches the desired post-restore shape.

- **`was_new=1`** (undo a create):
  - `DELETE FROM schema_field_claims WHERE field=?` (defensive — should be empty since claims don't form before the field exists, but covers oddly-ordered ops in one batch).
  - `DELETE FROM global_fields WHERE name=?`.
  - File rendering: `renderFieldsFile(db, vaultPath)`. No claiming-schema render needed; no node render needed (no claims, no values).

- **`was_deleted=1`** (undo a delete):
  - `INSERT INTO global_fields (...)` from captured columns.
  - For each cascade `kind='claim'` row: `INSERT INTO schema_field_claims (schema_name, field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override) VALUES (?, ?, ...)` (the `field` is `field_name`).
  - File rendering: `renderFieldsFile`. For every `schema_name` in the cascade rows: `renderSchemaFile(db, vaultPath, schema_name)`. `rerenderNodesWithField(db, writeLock, vaultPath, field_name, undefined, syncLogger)` — orphan `node_fields` rows are now claimed again.

- **`renamed_to=newName`** (undo a rename):
  - Identify the schemas currently claiming the field at `newName` (capture for re-rendering): `SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = newName`.
  - `INSERT INTO global_fields (...)` at `field_name` (the old name) from captured row.
  - `UPDATE schema_field_claims SET field=field_name WHERE field=newName`.
  - `UPDATE node_fields SET field_name=field_name WHERE field_name=newName`.
  - `DELETE FROM global_fields WHERE name=newName`.
  - File rendering: `renderFieldsFile`. For every captured-claiming `schema_name`: `renderSchemaFile`. `rerenderNodesWithField(..., field_name, ...)` — node `.md` files reflect the restored field name.

- **update** (no special flags):
  - `INSERT OR REPLACE INTO global_fields (...)` from captured row at `field_name`.
  - If cascade `kind='node_field'` rows exist (type-change case): `DELETE FROM node_fields WHERE field_name=?`, then `INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'frontmatter')` for each cascade row.
  - File rendering: `renderFieldsFile`. For every schema currently claiming the field: `renderSchemaFile`. `rerenderNodesWithField(..., field_name, ...)`.

#### Shared column-list constants (postmortem rec #6)

In `global-field-snapshot.ts`:

```ts
const GLOBAL_FIELD_CAPTURED_COLS = [
  'field_type', 'enum_values', 'reference_target', 'description',
  'default_value', 'required',
  'overrides_allowed_required', 'overrides_allowed_default_value',
  'overrides_allowed_enum_values',
  'list_item_type',
] as const;

const CLAIM_CASCADE_COLS = [
  'schema_name', 'label', 'description', 'sort_order',
  'required_override', 'default_value_override',
  'default_value_overridden', 'enum_values_override',
] as const;

const NODE_FIELD_CASCADE_COLS = [
  'node_id', 'value_text', 'value_number', 'value_date',
  'value_json', 'value_raw_text',
] as const;
```

Both capture (SELECT/INSERT) and restore (SELECT/INSERT) statements derive their column list from these constants. A future migration adding a column makes both paths fail to compile/run loudly together rather than silently diverging.

#### Symmetry refactor in `schema-snapshot.ts`

Apply the same pattern to the existing `schema_field_claims` capture/restore in `src/undo/schema-snapshot.ts:74-93` (capture) and `155-173` (restore). Currently the SELECT and INSERT enumerations agree by hand-discipline; replace with a single `SCHEMA_CLAIM_COLS` constant.

### §3.3 — Restore orchestration update (`src/undo/restore.ts`)

In `restoreOperation`, add a global-field pass **before** the existing schema pass. Justification: `schema_field_claims.field` is a FK to `global_fields(name)`, so global_fields rows must exist before claim restoration. Within a single operation_id touching both, restore must mirror the original create-order.

```ts
const gfSnaps = db.prepare(
  'SELECT field_name FROM undo_global_field_snapshots WHERE operation_id = ?'
).all(operation_id) as Array<{ field_name: string }>;

if (!opts.dry_run) {
  // Global-field pass (outermost: schema and node restores depend on field defs)
  for (const s of gfSnaps) {
    restoreGlobalFieldSnapshot(db, writeLock, vaultPath, syncLogger, operation_id, s.field_name);
  }
  // Schema pass (existing)
  for (const snap of schemaSnaps) {
    restoreSchemaSnapshot(db, vaultPath, operation_id, snap.schema_name);
  }
  // Node passes (existing buckets) ...
}
```

Inherits the same atomicity properties as the existing schema/node passes (best-effort; throw partway leaves partial state). Documented in §0.

**Conflict detection semantics:** global-field undo follows the schema-undo precedent (`src/undo/restore.ts:120-126`): no per-field conflict detection. Re-updates between the operation and the undo overwrite without warning. For the type-change update branch specifically, `DELETE FROM node_fields WHERE field_name=?` followed by re-INSERT of cascade rows is last-write-wins — any new `node_fields` rows written for the field after the captured mutation (e.g., by a watcher syncing a new `.md`) are lost. Node-level conflict detection (the existing `detectConflicts`) covers nodes individually but not global-field-mediated value changes. This is an accepted limitation, consistent with schema undo.

`syncLogger` plumbing (concrete): `restoreOperation` does not currently take a `SyncLogger`. v2 adds `syncLogger?: SyncLogger` to `RestoreOptions` and `RestoreManyParams` in `src/undo/restore.ts`. `restoreMany` forwards it into each `restoreOperation` call. `restoreOperation` passes it into `restoreGlobalFieldSnapshot`. `registerUndoOperations` in `src/mcp/tools/undo-operations.ts` takes a new `syncLogger?: SyncLogger` parameter and forwards it into `restoreMany`'s params. The MCP server-init site (where `registerUndoOperations` is called) already has access to `syncLogger` — wire it from there. `restoreSchemaSnapshot` and node restores do not need it (they don't call `rerenderNodesWithField`); the parameter is undefined-safe at every layer.

### §3.4 — Tool handler wiring (4 handlers)

Each handler gains the canonical lifecycle established by the schema handlers (`src/mcp/tools/create-schema.ts`, `delete-schema.ts`, `update-schema.ts`):

1. `createOperation` upfront.
2. Inside `try`, wrap `captureGlobalFieldSnapshot` + the crud call in a `db.transaction`. Run the transaction.
3. After the transaction: `UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?`.
4. File rendering (existing logic preserved).
5. Return `ok({ ...result, operation_id })`.
6. `catch`: `fail('INVALID_PARAMS', ...)`.
7. `finally`: `finalizeOperation(db, operation_id)`.

#### `create-global-field`

```ts
const operation_id = createOperation(db, {
  source_tool: 'create-global-field',
  description: `create-global-field: ${name}`,
});
try {
  let result: ReturnType<typeof createGlobalField> | undefined;
  const tx = db.transaction(() => {
    captureGlobalFieldSnapshot(db, operation_id, name, { was_new: true });
    result = createGlobalField(db, params);
  });
  tx();

  db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(operation_id);

  if (ctx?.vaultPath) renderFieldsFile(db, ctx.vaultPath);
  return ok({ ...result!, operation_id });
} catch (err) {
  return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
} finally {
  finalizeOperation(db, operation_id);
}
```

#### `delete-global-field`

`claimingSchemas` must be snapshotted **before** the transaction (the delete clears `schema_field_claims`, so a post-tx read finds nothing). Capture-inside-tx covers the snapshot for restore; `claimingSchemas` here is for the immediate post-mutation file re-rendering.

```ts
const operation_id = createOperation(db, {
  source_tool: 'delete-global-field',
  description: `delete-global-field: ${name}`,
});
try {
  const claimingSchemas = ctx?.vaultPath
    ? (db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
        .all(name) as Array<{ schema_name: string }>).map(r => r.schema_name)
    : [];

  let result: ReturnType<typeof deleteGlobalField> | undefined;
  const tx = db.transaction(() => {
    captureGlobalFieldSnapshot(db, operation_id, name, { was_deleted: true });
    result = deleteGlobalField(db, name);
  });
  tx();

  db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(operation_id);

  if (ctx?.vaultPath) {
    renderFieldsFile(db, ctx.vaultPath);
    for (const schema of claimingSchemas) renderSchemaFile(db, ctx.vaultPath, schema);
  }
  return ok({ ...result!, operation_id });
} catch (err) {
  return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
} finally {
  finalizeOperation(db, operation_id);
}
```

#### `rename-global-field`

```ts
const operation_id = createOperation(db, {
  source_tool: 'rename-global-field',
  description: `rename-global-field: ${old_name} → ${new_name}`,
});
try {
  let result: ReturnType<typeof renameGlobalField> | undefined;
  const tx = db.transaction(() => {
    captureGlobalFieldSnapshot(db, operation_id, old_name, { renamed_to: new_name });
    result = renameGlobalField(db, old_name, new_name);
  });
  tx();

  db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(operation_id);

  let nodes_rerendered = 0;
  if (ctx?.writeLock && ctx?.vaultPath) {
    nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, new_name, undefined, ctx.syncLogger);
  }
  return ok({ ...result!, nodes_rerendered, operation_id });
} catch (err) {
  return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
} finally {
  finalizeOperation(db, operation_id);
}
```

`renameGlobalField` already wraps its own work in `db.transaction` (`src/global-fields/crud.ts:391-429`). Wrapping `capture + crud` in an outer transaction nests cleanly in `better-sqlite3` (transactions are flattened).

#### `update-global-field`

Type-change without `confirm:true` previews only — no mutation, no operation. Compute `willMutate` upfront from a pre-read of the current row (`getGlobalField` is cheap; `updateGlobalField` re-reads internally — a redundant DB read that's acceptable for clarity).

```ts
const current = getGlobalField(db, name);
if (!current) return fail('INVALID_PARAMS', `Global field '${name}' not found`);
const isTypeChange = rest.field_type !== undefined && rest.field_type !== current.field_type;
const willMutate = !isTypeChange || rest.confirm === true;

let operation_id: string | undefined;
if (willMutate) {
  operation_id = createOperation(db, {
    source_tool: 'update-global-field',
    description: isTypeChange
      ? `update-global-field: ${name} (type-change ${current.field_type} → ${rest.field_type})`
      : `update-global-field: ${name}`,
  });
}

try {
  let result: ReturnType<typeof updateGlobalField> | undefined;
  if (operation_id !== undefined) {
    const op_id = operation_id;
    const tx = db.transaction(() => {
      captureGlobalFieldSnapshot(db, op_id, name, { capture_node_fields: isTypeChange });
      result = updateGlobalField(db, name, rest);
    });
    tx();
    db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(op_id);
  } else {
    // Preview path — no mutation, no operation, no capture
    result = updateGlobalField(db, name, rest);
  }

  // ... existing re-rendering logic (preserved unchanged) ...

  return ok({ ...result!, ...(operation_id ? { operation_id } : {}) });
} catch (err) {
  return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
} finally {
  if (operation_id !== undefined) finalizeOperation(db, operation_id);
}
```

### §3.5 — Per-handler `global_field_count` increment

**Pattern verified in codebase:** `schema_count` is **not** set by `finalizeOperation`. Each schema handler issues a direct `UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?` after the successful mutation (`src/mcp/tools/create-schema.ts:52`, `delete-schema.ts:31`, `update-schema.ts:137`). `finalizeOperation` only computes `node_count` from `undo_snapshots`.

Each global-field handler (the four wired in §3.4) follows the same pattern: after the successful crud call, before the response, issue:

```ts
db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(operation_id);
```

Each call mutates one global field, so the hardcoded `= 1` is correct. `finalizeOperation` is **not** modified.

### §3.6 — `list-undo-history` + `UndoOperationRow`

In `src/undo/types.ts`:

```ts
export interface UndoOperationRow {
  operation_id: string;
  timestamp: number;
  source_tool: string;
  description: string;
  node_count: number;
  schema_count: number;
  global_field_count: number;   // NEW
  status: 'active' | 'undone' | 'expired';
}
```

In `src/mcp/tools/list-undo-history.ts:34-42`, the projection adds:

```ts
operations: result.operations.map(o => ({
  operation_id: o.operation_id,
  timestamp: new Date(o.timestamp).toISOString(),
  source_tool: o.source_tool,
  description: o.description,
  node_count: o.node_count,
  schema_count: o.schema_count,
  global_field_count: o.global_field_count,   // NEW
  status: o.status,
})),
```

The migration's `DEFAULT 0` makes the projection backward-safe for pre-v2 rows.

### §3.7 — Tests

Per postmortem rec #5: every undo round-trip test asserts on `.md` and `.yaml` file contents, not just DB state. All undo round-trip tests pass `dry_run: false` to `undo-operations` (postmortem-noted default).

#### `tests/undo/global-field-snapshot.test.ts`

Mirror `tests/undo/schema-snapshot.test.ts` structure.

1. **was_new round-trip**
   - tool-call `create-global-field` { name: 'priority', field_type: 'string' }
   - assert response `data.operation_id` present
   - tool-call `undo-operations` { operation_ids: [op_id], dry_run: false }
   - assert `getGlobalField(db, 'priority')` is null
   - assert `.schemas/_fields.yaml` does not contain `priority`

2. **was_deleted round-trip**
   - precondition: field 'status' exists, schema 'task' has claim on 'status'
   - tool-call `delete-global-field` { name: 'status' }
   - assert claim removed, field removed, `.schemas/_fields.yaml` and `.schemas/task.yaml` reflect deletion
   - tool-call `undo-operations` { operation_ids: [op_id], dry_run: false }
   - assert field re-exists, claim re-exists, `.schemas/_fields.yaml` contains `status`, `.schemas/task.yaml` contains `status` claim

3. **was_renamed_from round-trip**
   - precondition: field 'priority' exists, schema 'task' claims it, node 'task-1' has `priority: high`
   - tool-call `rename-global-field` { old_name: 'priority', new_name: 'urgency' }
   - assert all references switched to 'urgency' in DB and files
   - tool-call `undo-operations` { operation_ids: [op_id], dry_run: false }
   - assert all references back to 'priority' in DB AND in `.schemas/_fields.yaml`, `.schemas/task.yaml`, and `task-1.md` frontmatter

4. **update non-type-change round-trip**
   - precondition: field 'status' exists with description 'old desc'
   - tool-call `update-global-field` { name: 'status', description: 'new desc' }
   - tool-call `undo-operations` { operation_ids: [op_id], dry_run: false }
   - assert description in DB is 'old desc', `.schemas/_fields.yaml` shows 'old desc'

5. **update type-change round-trip**
   - precondition: field 'priority' is `string`, three nodes set it to '1', '2', 'urgent'. Schema 'task' claims 'priority'.
   - tool-call `update-global-field` { name: 'priority', field_type: 'number', confirm: true }
   - assert: post-mutation, '1' and '2' coerced to numbers, 'urgent' deleted from `node_fields` (uncoercible), `edits_log` row written
   - tool-call `undo-operations` { operation_ids: [op_id], dry_run: false }
   - assert: field_type back to 'string', all three node_fields rows back with original string values, `.md` files for each node show original values

6. **operation lifecycle visible via list-undo-history**
   - tool-call `create-global-field` (or any of the four)
   - tool-call `list-undo-history`
   - assert: top operation has `source_tool: 'create-global-field'`, `global_field_count: 1`, `node_count: 0`, `schema_count: 0`

7. **idempotent capture (INSERT OR IGNORE)**
   - call `captureGlobalFieldSnapshot(db, op_id, 'foo', {was_new: true})` twice
   - assert: `SELECT COUNT(*) FROM undo_global_field_snapshots WHERE operation_id=? AND field_name='foo'` is 1

8. **cascade FK cleanup**
   - capture `was_deleted` with multiple claim cascade rows
   - delete the `undo_operations` row
   - assert: parent snapshot row gone, all cascade rows gone

9. **global-field restore precedes schema restore in same op**
   - construct an operation_id with both a global-field snapshot (was_deleted) and a schema snapshot (the claim depended on the field)
   - run `restoreOperation`
   - assert: completes without FK errors, both restored

#### `tests/db/global-field-undo-migration.test.ts`

Mirror `tests/db/undo-tables-migration.test.ts`.

- Fresh DB → migration creates `undo_global_field_snapshots`, `undo_global_field_value_snapshots`, adds `global_field_count` column.
- Idempotent: second invocation is a no-op.
- Pre-existing DB without the column → ALTER adds it with DEFAULT 0; existing rows have `global_field_count = 0`.
- FK CASCADE: delete an `undo_operations` row, observe parent + cascade tables clear.

#### Per-handler smoke tests

No dedicated per-handler test files exist for the global-field tools today (handler-level coverage is sparse compared to the schema tools, which use combined files like `tests/mcp/create-delete-schema.test.ts`). v2 introduces handler smoke tests inline within `tests/undo/global-field-snapshot.test.ts` (the round-trip cases above already cover each tool path); a separate combined `tests/mcp/global-fields-handlers.test.ts` is **not** required unless implementer judgment determines the round-trip tests don't sufficiently exercise the lifecycle plumbing in isolation.

Smoke assertions to include in the round-trip tests above (rather than a separate file):

- Each tool call's response carries `data.operation_id` (a non-empty string).
- `update-global-field` preview path (type-change without `confirm: true`) returns **without** `operation_id` and creates **no** row in `undo_operations`.

## §4 — Build sequence (planning hand-off)

The `superpowers:writing-plans` skill takes over from here. This section is a recommended ordering for the implementation plan, not a binding sequence:

1. §1 (closed-union `Issue.code`) — smallest, mechanical, lands first to clear the `Issue` struct for §2's optional-field addition.
2. §2 (`op_index` + `tagOpIndex`) — additive, two wiring sites in `batch-mutate.ts`.
3. §3.1 — migration + `tests/db/global-field-undo-migration.test.ts`.
4. §3.2 — capture/restore module + symmetry refactor in `schema-snapshot.ts` + module-level tests in `tests/undo/global-field-snapshot.test.ts`.
5. §3.3 + §3.6 — restore orchestration update (with `syncLogger` plumb-through), `list-undo-history` projection, `UndoOperationRow` type.
6. §3.4 — wire each of the four global-field handlers (`create`, `delete`, `rename`, `update`). One task per handler. The §3.5 `global_field_count = 1` UPDATE lands inside each handler in its own task, not separately.
7. §3.7 round-trip tests — co-developed with each handler in step 6, all in `tests/undo/global-field-snapshot.test.ts`.

Per postmortem process notes: do **not** skip per-task spec review on the four handler wirings even though the pattern is identical. Holistic review at the end remains a safety net, not a substitute.
