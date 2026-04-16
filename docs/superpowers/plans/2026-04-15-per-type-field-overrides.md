# Per-Type Field Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow schemas to override `enum_values`, `default_value`, and `required` on claimed fields, with per-property gating and multi-type resolution.

**Architecture:** Split `per_type_overrides_allowed` boolean into three `overrides_allowed_*` columns. Add `enum_values_override` + `default_value_overridden` flag to claim table. Merge logic changes from MERGE_CONFLICT errors to silent cancellation-to-global for required/default_value, and valid-for-any-type resolution for enum overrides.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), vitest, zod

**Spec:** `docs/superpowers/specs/2026-04-15-per-type-field-overrides.md`

---

### Task 1: DB Schema + Migration + Type Definitions

The foundation. Updates the SQLite table definitions for new databases, adds a migration function for existing databases, and updates the TypeScript types that every other module depends on.

**Files:**
- Modify: `src/db/schema.ts:29-61` (table definitions)
- Modify: `src/db/migrate.ts` (add new migration function)
- Modify: `src/validation/types.ts:1-60` (type definitions)
- Test: `tests/db/schema.test.ts`

- [ ] **Step 1: Write migration test**

In `tests/db/schema.test.ts`, add tests for the new migration. (Read the existing test file first to follow the established pattern.)

```typescript
// Add to existing test file
import { upgradeForOverrides } from '../../src/db/migrate.js';

describe('upgradeForOverrides', () => {
  it('adds overrides_allowed columns and renames claim columns', () => {
    // Create a DB with the old schema (has per_type_overrides_allowed)
    const db = createTestDb();

    // Insert a global field with per_type_overrides_allowed = 1
    db.prepare(`INSERT INTO global_fields (name, field_type, required, per_type_overrides_allowed) VALUES ('status', 'enum', 0, 1)`).run();

    // Insert a schema and claim with old column names
    db.prepare(`INSERT INTO schemas (name) VALUES ('task')`).run();
    db.prepare(`INSERT INTO schema_field_claims (schema_name, field, required, default_value) VALUES ('task', 'status', 1, '"open"')`).run();

    upgradeForOverrides(db);

    // Check global_fields has new columns
    const gf = db.prepare('SELECT overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values FROM global_fields WHERE name = ?').get('status') as any;
    expect(gf.overrides_allowed_required).toBe(1);
    expect(gf.overrides_allowed_default_value).toBe(1);
    expect(gf.overrides_allowed_enum_values).toBe(0);

    // Check claim columns renamed and new columns exist
    const claim = db.prepare('SELECT required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ?').get('task') as any;
    expect(claim.required_override).toBe(1);
    expect(claim.default_value_override).toBe('"open"');
    expect(claim.default_value_overridden).toBe(1);
    expect(claim.enum_values_override).toBeNull();
  });

  it('is idempotent', () => {
    const db = createTestDb();
    upgradeForOverrides(db);
    upgradeForOverrides(db); // should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL — `upgradeForOverrides` does not exist.

- [ ] **Step 3: Update `src/db/schema.ts` — new table definitions for fresh databases**

The `createSchema` function creates tables for brand-new databases. Update `global_fields` and `schema_field_claims` to use the new column layout:

```typescript
// In createSchema(), replace the global_fields CREATE TABLE (lines 29-39):
    CREATE TABLE IF NOT EXISTS global_fields (
      name TEXT PRIMARY KEY,
      field_type TEXT NOT NULL,
      enum_values TEXT,
      reference_target TEXT,
      description TEXT,
      default_value TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_required INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0,
      overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0,
      list_item_type TEXT
    );

// Replace schema_field_claims CREATE TABLE (lines 51-60):
    CREATE TABLE IF NOT EXISTS schema_field_claims (
      schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      field TEXT NOT NULL REFERENCES global_fields(name),
      label TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 1000,
      required_override INTEGER,
      default_value_override TEXT,
      default_value_overridden INTEGER NOT NULL DEFAULT 0,
      enum_values_override TEXT,
      PRIMARY KEY (schema_name, field)
    );
```

- [ ] **Step 4: Write `upgradeForOverrides` in `src/db/migrate.ts`**

```typescript
export function upgradeForOverrides(db: Database.Database): void {
  const run = db.transaction(() => {
    const gfColumns = (
      db.prepare('PRAGMA table_info(global_fields)').all() as { name: string }[]
    ).map(c => c.name);

    // --- global_fields: add new overrides_allowed columns ---
    if (!gfColumns.includes('overrides_allowed_required')) {
      db.prepare('ALTER TABLE global_fields ADD COLUMN overrides_allowed_required INTEGER NOT NULL DEFAULT 0').run();
      db.prepare('ALTER TABLE global_fields ADD COLUMN overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0').run();
      db.prepare('ALTER TABLE global_fields ADD COLUMN overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0').run();

      // Migrate from per_type_overrides_allowed
      if (gfColumns.includes('per_type_overrides_allowed')) {
        db.prepare(`
          UPDATE global_fields
          SET overrides_allowed_required = per_type_overrides_allowed,
              overrides_allowed_default_value = per_type_overrides_allowed,
              overrides_allowed_enum_values = 0
        `).run();
        db.prepare('ALTER TABLE global_fields DROP COLUMN per_type_overrides_allowed').run();
      }
    }

    // --- schema_field_claims: rename + add columns ---
    const sfcColumns = (
      db.prepare('PRAGMA table_info(schema_field_claims)').all() as { name: string }[]
    ).map(c => c.name);

    if (sfcColumns.includes('required') && !sfcColumns.includes('required_override')) {
      db.prepare('ALTER TABLE schema_field_claims RENAME COLUMN required TO required_override').run();
    }
    if (sfcColumns.includes('default_value') && !sfcColumns.includes('default_value_override')) {
      db.prepare('ALTER TABLE schema_field_claims RENAME COLUMN default_value TO default_value_override').run();
    }
    if (!sfcColumns.includes('default_value_overridden')) {
      db.prepare('ALTER TABLE schema_field_claims ADD COLUMN default_value_overridden INTEGER NOT NULL DEFAULT 0').run();
      db.prepare('UPDATE schema_field_claims SET default_value_overridden = 1 WHERE default_value_override IS NOT NULL').run();
    }
    if (!sfcColumns.includes('enum_values_override')) {
      db.prepare('ALTER TABLE schema_field_claims ADD COLUMN enum_values_override TEXT').run();
    }
  });

  run();
}
```

- [ ] **Step 5: Update TypeScript types in `src/validation/types.ts`**

```typescript
// Replace GlobalFieldDefinition (lines 3-13):
export interface OverridesAllowed {
  required: boolean;
  default_value: boolean;
  enum_values: boolean;
}

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

// Replace FieldClaim (lines 17-25):
export type Override<T> = { kind: 'inherit' } | { kind: 'override'; value: T };

export interface FieldClaim {
  schema_name: string;
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required_override: boolean | null;          // null = inherit
  default_value_override: Override<unknown>;   // discriminated union
  enum_values_override: string[] | null;       // null = inherit
}

// Add to EffectiveField (after line 34):
export interface PerTypeEnumValues {
  type: string;
  values: string[] | null;  // null = no enum constraint
}

// Update EffectiveField:
export interface EffectiveField {
  field: string;
  global_field: GlobalFieldDefinition;
  resolved_label: string | null;
  resolved_description: string | null;
  resolved_order: number;
  resolved_required: boolean;
  resolved_default_value: unknown;
  claiming_types: string[];
  per_type_enum_values?: PerTypeEnumValues[];  // populated when any claim has enum_values_override
}
```

- [ ] **Step 6: Run tests to verify migration passes, compile to verify types**

Run: `npx vitest run tests/db/schema.test.ts && npx tsc --noEmit 2>&1 | head -40`

Expected: Migration test passes. TypeScript will show compilation errors in downstream files — that's expected and intentional. The errors are our TODO list for subsequent tasks.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/validation/types.ts tests/db/schema.test.ts
git commit -m "feat: foundation for per-type overrides — DB schema, migration, types"
```

---

### Task 2: Global Field CRUD

Update the global field read/write layer to use the new `overrides_allowed` object instead of the single boolean.

**Files:**
- Modify: `src/global-fields/crud.ts:9-105,119-176,180-246,362-410` (types, row mapping, create, update, rename)
- Test: `tests/global-fields/crud.test.ts`

- [ ] **Step 1: Write failing tests for overrides_allowed object**

Add to `tests/global-fields/crud.test.ts`. (Read existing file first for patterns.)

```typescript
describe('overrides_allowed', () => {
  it('createGlobalField — defaults all overrides to false', () => {
    const field = createGlobalField(db, { name: 'priority', field_type: 'string' });
    expect(field.overrides_allowed).toEqual({ required: false, default_value: false, enum_values: false });
  });

  it('createGlobalField — accepts overrides_allowed object', () => {
    const field = createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['open', 'closed'],
      overrides_allowed: { required: true, default_value: true, enum_values: false },
    });
    expect(field.overrides_allowed).toEqual({ required: true, default_value: true, enum_values: false });
  });

  it('updateGlobalField — updates individual override flags', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open'] });
    updateGlobalField(db, 'status', { overrides_allowed: { enum_values: true } });
    const field = getGlobalField(db, 'status')!;
    expect(field.overrides_allowed.enum_values).toBe(true);
    expect(field.overrides_allowed.required).toBe(false); // unchanged
  });

  it('renameGlobalField — preserves overrides_allowed', () => {
    createGlobalField(db, {
      name: 'old_name', field_type: 'string',
      overrides_allowed: { required: true, default_value: true, enum_values: true },
    });
    renameGlobalField(db, 'old_name', 'new_name');
    const field = getGlobalField(db, 'new_name')!;
    expect(field.overrides_allowed).toEqual({ required: true, default_value: true, enum_values: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/global-fields/crud.test.ts`
Expected: FAIL — `overrides_allowed` not recognized.

- [ ] **Step 3: Update `src/global-fields/crud.ts`**

Replace `per_type_overrides_allowed` throughout:

```typescript
// Update CreateGlobalFieldInput (line 18):
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
// Remove: per_type_overrides_allowed?: boolean;

// Update UpdateGlobalFieldInput (line 29):
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
// Remove: per_type_overrides_allowed?: boolean;

// Update GlobalFieldRow (lines 81-91):
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

// Update rowToDefinition (lines 93-105):
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

// Update createGlobalField INSERT (lines 153-166):
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

// Update updateGlobalField non-type-change path (replace lines 235-238):
    if (input.overrides_allowed !== undefined) {
      if (input.overrides_allowed.required !== undefined) {
        updates.push('overrides_allowed_required = ?');
        params.push(input.overrides_allowed.required ? 1 : 0);
      }
      if (input.overrides_allowed.default_value !== undefined) {
        updates.push('overrides_allowed_default_value = ?');
        params.push(input.overrides_allowed.default_value ? 1 : 0);
      }
      if (input.overrides_allowed.enum_values !== undefined) {
        updates.push('overrides_allowed_enum_values = ?');
        params.push(input.overrides_allowed.enum_values ? 1 : 0);
      }
    }

// Update renameGlobalField INSERT (lines 375-388):
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

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/global-fields/crud.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/global-fields/crud.ts tests/global-fields/crud.test.ts
git commit -m "feat: update global field CRUD for overrides_allowed object"
```

---

### Task 3: Schema CRUD — Claim Validation + Storage

Update `ClaimInput`, `validateClaims`, and `insertClaims` to handle the new override properties and per-property gating.

**Files:**
- Modify: `src/schema/crud.ts:16-119` (ClaimInput, validateClaims, insertClaims)
- Test: `tests/schema/crud.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/schema/crud.test.ts`:

```typescript
describe('per-type override claim validation', () => {
  it('rejects enum_values_override when overrides_allowed.enum_values is false', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
    expect(() =>
      createSchemaDefinition(db, {
        name: 'task',
        field_claims: [{ field: 'status', enum_values_override: ['active', 'done'] }],
      })
    ).toThrow(/does not allow.*enum_values/);
  });

  it('accepts enum_values_override when overrides_allowed.enum_values is true', () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['open', 'closed'],
      overrides_allowed: { enum_values: true },
    });
    const schema = createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status', enum_values_override: ['active', 'done'] }],
    });
    expect(schema.name).toBe('task');
  });

  it('rejects enum_values_override on structurally incompatible field type', () => {
    createGlobalField(db, {
      name: 'count', field_type: 'number',
      overrides_allowed: { enum_values: true },
    });
    expect(() =>
      createSchemaDefinition(db, {
        name: 'task',
        field_claims: [{ field: 'count', enum_values_override: ['one', 'two'] }],
      })
    ).toThrow(/structurally incompatible/);
  });

  it('accepts enum_values_override on list<enum> field', () => {
    createGlobalField(db, {
      name: 'tags', field_type: 'list', list_item_type: 'enum', enum_values: ['a', 'b'],
      overrides_allowed: { enum_values: true },
    });
    const schema = createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'tags', enum_values_override: ['x', 'y'] }],
    });
    expect(schema.name).toBe('task');
  });

  it('stores default_value_override: null as override-to-null (not inherit)', () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['open'], default_value: 'open',
      overrides_allowed: { default_value: true },
    });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status', default_value_override: null, default_value_overridden: true }],
    });

    // Read back from DB
    const row = db.prepare('SELECT default_value_override, default_value_overridden FROM schema_field_claims WHERE schema_name = ? AND field = ?')
      .get('task', 'status') as any;
    expect(row.default_value_overridden).toBe(1);
    expect(row.default_value_override).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema/crud.test.ts`
Expected: FAIL — new properties not recognized.

- [ ] **Step 3: Update `ClaimInput` in `src/schema/crud.ts`**

```typescript
export interface ClaimInput {
  field: string;
  label?: string;
  description?: string;
  sort_order?: number;
  required?: boolean;                        // maps to required_override column
  default_value?: unknown;                   // maps to default_value_override column
  default_value_overridden?: boolean;        // true when default_value key is present (even if null)
  enum_values_override?: string[];           // maps to enum_values_override column
}
```

- [ ] **Step 4: Update `validateClaims` in `src/schema/crud.ts`**

```typescript
interface GlobalFieldRow {
  name: string;
  field_type: string;
  list_item_type: string | null;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
}

function validateClaims(db: Database.Database, claims: ClaimInput[]): void {
  for (const claim of claims) {
    const gf = db
      .prepare(`SELECT name, field_type, list_item_type, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values FROM global_fields WHERE name = ?`)
      .get(claim.field) as GlobalFieldRow | undefined;

    if (!gf) {
      throw new Error(
        `Global field '${claim.field}' does not exist. Create it first with create-global-field.`,
      );
    }

    // Per-property override gating
    if (claim.required !== undefined && gf.overrides_allowed_required !== 1) {
      throw new Error(
        `Field '${claim.field}' does not allow required overrides. Set overrides_allowed.required = true on the global field.`,
      );
    }
    if ((claim.default_value !== undefined || claim.default_value_overridden) && gf.overrides_allowed_default_value !== 1) {
      throw new Error(
        `Field '${claim.field}' does not allow default_value overrides. Set overrides_allowed.default_value = true on the global field.`,
      );
    }
    if (claim.enum_values_override !== undefined && gf.overrides_allowed_enum_values !== 1) {
      throw new Error(
        `Field '${claim.field}' does not allow enum_values overrides. Set overrides_allowed.enum_values = true on the global field.`,
      );
    }

    // Structural compatibility check for enum_values_override
    if (claim.enum_values_override !== undefined) {
      const isEnumCompatible =
        gf.field_type === 'enum' ||
        (gf.field_type === 'list' && gf.list_item_type === 'enum');
      if (!isEnumCompatible) {
        throw new Error(
          `Field '${claim.field}' (${gf.field_type}${gf.list_item_type ? `<${gf.list_item_type}>` : ''}) is structurally incompatible with enum_values_override. Only enum and list<enum> fields support enum overrides.`,
        );
      }
    }
  }
}
```

- [ ] **Step 5: Update `insertClaims` in `src/schema/crud.ts`**

```typescript
function insertClaims(db: Database.Database, schemaName: string, claims: ClaimInput[]): void {
  const stmt = db.prepare(`
    INSERT INTO schema_field_claims (schema_name, field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const claim of claims) {
    const requiredInt =
      claim.required === undefined ? null : claim.required ? 1 : 0;

    // Discriminated union: default_value_overridden distinguishes inherit from override-to-null
    const overridden = claim.default_value_overridden ?? (claim.default_value !== undefined);
    const defaultValueJson = overridden
      ? (claim.default_value !== undefined && claim.default_value !== null ? JSON.stringify(claim.default_value) : null)
      : null;

    const enumOverrideJson = claim.enum_values_override
      ? JSON.stringify(claim.enum_values_override)
      : null;

    stmt.run(
      schemaName,
      claim.field,
      claim.label ?? null,
      claim.description ?? null,
      claim.sort_order ?? null,
      requiredInt,
      defaultValueJson,
      overridden ? 1 : 0,
      enumOverrideJson,
    );
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/schema/crud.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/schema/crud.ts tests/schema/crud.test.ts
git commit -m "feat: schema CRUD with per-property override gating and enum_values_override"
```

---

### Task 4: Schema Context Loader

Update `loadSchemaContext` to read the new columns and build the new `FieldClaim` shape.

**Files:**
- Modify: `src/pipeline/schema-context.ts:19-57`

- [ ] **Step 1: Update `loadSchemaContext`**

```typescript
export function loadSchemaContext(db: Database.Database, types: string[]): SchemaContext {
  const claimsByType = new Map<string, FieldClaim[]>();

  for (const typeName of types) {
    const rows = db.prepare('SELECT * FROM schema_field_claims WHERE schema_name = ?').all(typeName) as Array<{
      schema_name: string;
      field: string;
      label: string | null;
      description: string | null;
      sort_order: number | null;
      required_override: number | null;
      default_value_override: string | null;
      default_value_overridden: number;
      enum_values_override: string | null;
    }>;

    if (rows.length > 0) {
      claimsByType.set(typeName, rows.map(r => ({
        schema_name: r.schema_name,
        field: r.field,
        label: r.label,
        description: r.description,
        sort_order: r.sort_order ?? 1000,
        required_override: r.required_override !== null ? r.required_override === 1 : null,
        default_value_override: r.default_value_overridden === 1
          ? { kind: 'override' as const, value: r.default_value_override !== null ? JSON.parse(r.default_value_override) : null }
          : { kind: 'inherit' as const },
        enum_values_override: r.enum_values_override !== null ? JSON.parse(r.enum_values_override) : null,
      })));
    }
  }

  const globalFields = new Map<string, GlobalFieldDefinition>();
  const allFieldNames = new Set<string>();
  for (const claims of claimsByType.values()) {
    for (const c of claims) allFieldNames.add(c.field);
  }
  for (const name of allFieldNames) {
    const gf = getGlobalField(db, name);
    if (gf) globalFields.set(name, gf);
  }

  return { claimsByType, globalFields };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Compilation errors should be reduced (context loader now matches types). Remaining errors will be in merge.ts, validate.ts, tools, etc.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/schema-context.ts
git commit -m "feat: schema context loader reads new override columns"
```

---

### Task 5: Merge Logic — Cancellation + Enum Resolution

The core algorithm change. Required/default_value conflicts cancel to global instead of MERGE_CONFLICT. Per-type enum validation info is surfaced.

**Files:**
- Modify: `src/validation/merge.ts:1-157`
- Test: `tests/validation/merge.test.ts:1-277`

- [ ] **Step 1: Update merge test helpers and rewrite conflict tests**

In `tests/validation/merge.test.ts`, update the helpers and rewrite tests for the new behavior:

```typescript
// Update makeGlobal helper:
function makeGlobal(overrides: Partial<GlobalFieldDefinition> & { name: string }): GlobalFieldDefinition {
  return {
    field_type: 'string',
    enum_values: null,
    reference_target: null,
    description: null,
    default_value: null,
    required: false,
    overrides_allowed: { required: false, default_value: false, enum_values: false },
    list_item_type: null,
    ...overrides,
  };
}

// Update makeClaim helper:
function makeClaim(overrides: Partial<FieldClaim> & { schema_name: string; field: string }): FieldClaim {
  return {
    label: null,
    description: null,
    sort_order: 1000,
    required_override: null,
    default_value_override: { kind: 'inherit' },
    enum_values_override: null,
    ...overrides,
  };
}
```

Then rewrite the conflict tests to expect cancellation-to-global instead of `ok: false`:

```typescript
  it('required disagreement — cancels to global default (not MERGE_CONFLICT)', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', required: true, overrides_allowed: { required: true, default_value: false, enum_values: false } })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', required_override: true })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', required_override: false })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cancellation: falls back to global required (true)
    expect(result.effective_fields.get('status')!.resolved_required).toBe(true);
  });

  it('default_value disagreement — cancels to global default', () => {
    const globals = new Map([
      ['status', makeGlobal({
        name: 'status', default_value: 'global_default',
        overrides_allowed: { required: false, default_value: true, enum_values: false },
      })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', default_value_override: { kind: 'override', value: 'open' } })]],
      ['project', [makeClaim({ schema_name: 'project', field: 'status', default_value_override: { kind: 'override', value: 'active' } })]],
    ]);

    const result = mergeFieldClaims(['task', 'project'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.resolved_default_value).toBe('global_default');
  });

  it('default_value_override: null — overrides global default to nothing', () => {
    const globals = new Map([
      ['status', makeGlobal({
        name: 'status', default_value: 'open',
        overrides_allowed: { required: false, default_value: true, enum_values: false },
      })],
    ]);
    const claims = new Map([
      ['note', [makeClaim({ schema_name: 'note', field: 'status', default_value_override: { kind: 'override', value: null } })]],
    ]);

    const result = mergeFieldClaims(['note'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.resolved_default_value).toBeNull();
  });
```

Add new enum override tests:

```typescript
  it('enum_values_override — single type replaces global values', () => {
    const globals = new Map([
      ['status', makeGlobal({
        name: 'status', field_type: 'enum', enum_values: ['open', 'closed'],
        overrides_allowed: { required: false, default_value: false, enum_values: true },
      })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status', enum_values_override: ['active', 'done'] })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('status')!;
    expect(ef.per_type_enum_values).toEqual([
      { type: 'task', values: ['active', 'done'] },
    ]);
  });

  it('enum_values_override — multi-type, each has own values', () => {
    const globals = new Map([
      ['subtype', makeGlobal({
        name: 'subtype', field_type: 'list', list_item_type: 'enum',
        enum_values: ['a', 'b', 'c'],
        overrides_allowed: { required: false, default_value: false, enum_values: true },
      })],
    ]);
    const claims = new Map([
      ['note', [makeClaim({ schema_name: 'note', field: 'subtype', enum_values_override: ['spec', 'bug'] })]],
      ['person', [makeClaim({ schema_name: 'person', field: 'subtype', enum_values_override: ['Author', 'Athlete'] })]],
    ]);

    const result = mergeFieldClaims(['note', 'person'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('subtype')!;
    expect(ef.per_type_enum_values).toEqual([
      { type: 'note', values: ['spec', 'bug'] },
      { type: 'person', values: ['Author', 'Athlete'] },
    ]);
  });

  it('enum_values_override — mixed: one overrides, one inherits global', () => {
    const globals = new Map([
      ['subtype', makeGlobal({
        name: 'subtype', field_type: 'enum', enum_values: ['a', 'b'],
        overrides_allowed: { required: false, default_value: false, enum_values: true },
      })],
    ]);
    const claims = new Map([
      ['note', [makeClaim({ schema_name: 'note', field: 'subtype', enum_values_override: ['spec', 'bug'] })]],
      ['person', [makeClaim({ schema_name: 'person', field: 'subtype' })]],  // no override
    ]);

    const result = mergeFieldClaims(['note', 'person'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ef = result.effective_fields.get('subtype')!;
    expect(ef.per_type_enum_values).toEqual([
      { type: 'note', values: ['spec', 'bug'] },
      { type: 'person', values: ['a', 'b'] },  // inherits global
    ]);
  });

  it('no enum overrides — per_type_enum_values is undefined', () => {
    const globals = new Map([
      ['status', makeGlobal({ name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] })],
    ]);
    const claims = new Map([
      ['task', [makeClaim({ schema_name: 'task', field: 'status' })]],
    ]);

    const result = mergeFieldClaims(['task'], claims, globals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.per_type_enum_values).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/validation/merge.test.ts`
Expected: FAIL — old helpers don't match new types.

- [ ] **Step 3: Rewrite `src/validation/merge.ts`**

```typescript
// src/validation/merge.ts

import type {
  GlobalFieldDefinition,
  FieldClaim,
  EffectiveField,
  EffectiveFieldSet,
  ConflictedField,
  ConflictedFieldSet,
  MergeConflict,
  MergeResult,
  PerTypeEnumValues,
} from './types.js';

/**
 * Merge field claims from multiple types into an effective field set.
 * Pure function — no DB dependency.
 */
export function mergeFieldClaims(
  types: string[],
  claimsByType: Map<string, FieldClaim[]>,
  globalFields: Map<string, GlobalFieldDefinition>,
): MergeResult {
  const effectiveFields: EffectiveFieldSet = new Map();

  // Track per-field: ordered list of (type, claim) pairs
  const fieldClaims = new Map<string, Array<{ type: string; claim: FieldClaim }>>();

  // Step 1: Collect claims in type-order
  for (const type of types) {
    const claims = claimsByType.get(type);
    if (!claims) continue;

    for (const claim of claims) {
      if (!globalFields.has(claim.field)) continue;

      let entries = fieldClaims.get(claim.field);
      if (!entries) {
        entries = [];
        fieldClaims.set(claim.field, entries);
      }
      entries.push({ type, claim });
    }
  }

  // Step 2 & 3: Build effective fields
  for (const [fieldName, claimEntries] of fieldClaims) {
    const globalField = globalFields.get(fieldName)!;
    const claimingTypes = claimEntries.map(e => e.type);

    // Presentation metadata: first-defined wins
    let resolvedLabel: string | null = null;
    let resolvedDescription: string | null = null;
    let resolvedOrder = 1000;

    for (const { claim } of claimEntries) {
      if (resolvedLabel === null && claim.label !== null) {
        resolvedLabel = claim.label;
      }
      if (resolvedDescription === null && claim.description !== null) {
        resolvedDescription = claim.description;
      }
    }
    for (const { claim } of claimEntries) {
      if (claim.sort_order !== 1000) {
        resolvedOrder = claim.sort_order;
        break;
      }
    }

    // --- Resolve required: cancellation on conflict ---
    let resolvedRequired = globalField.required;
    const requiredOverrides = claimEntries.filter(e => e.claim.required_override !== null);
    if (requiredOverrides.length > 0) {
      const values = requiredOverrides.map(e => e.claim.required_override);
      const allAgree = values.every(v => v === values[0]);
      resolvedRequired = allAgree ? values[0]! : globalField.required;
    }

    // --- Resolve default_value: cancellation on conflict ---
    let resolvedDefaultValue = globalField.default_value;
    const defaultOverrides = claimEntries.filter(e => e.claim.default_value_override.kind === 'override');
    if (defaultOverrides.length > 0) {
      const first = JSON.stringify((defaultOverrides[0].claim.default_value_override as { kind: 'override'; value: unknown }).value);
      const allAgree = defaultOverrides.every(e =>
        JSON.stringify((e.claim.default_value_override as { kind: 'override'; value: unknown }).value) === first
      );
      resolvedDefaultValue = allAgree
        ? (defaultOverrides[0].claim.default_value_override as { kind: 'override'; value: unknown }).value
        : globalField.default_value;
    }

    // --- Resolve enum_values: per-type values ---
    let perTypeEnumValues: PerTypeEnumValues[] | undefined;
    const hasAnyEnumOverride = claimEntries.some(e => e.claim.enum_values_override !== null);
    if (hasAnyEnumOverride) {
      perTypeEnumValues = claimEntries.map(e => ({
        type: e.type,
        values: e.claim.enum_values_override ?? globalField.enum_values,
      }));
    }

    effectiveFields.set(fieldName, {
      field: fieldName,
      global_field: globalField,
      resolved_label: resolvedLabel,
      resolved_description: resolvedDescription,
      resolved_order: resolvedOrder,
      resolved_required: resolvedRequired,
      resolved_default_value: resolvedDefaultValue,
      claiming_types: claimingTypes,
      per_type_enum_values: perTypeEnumValues,
    });
  }

  return { ok: true, effective_fields: effectiveFields };
}
```

Note: The `ok: false` path with `MergeConflict` is removed. The function always returns `ok: true`. The `MergeResult` type union is simplified but the `ok: false` branch can be retained for future use — or removed. For now, keep the type as-is but the function always returns the `ok: true` branch.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/validation/merge.test.ts`
Expected: PASS. Update any remaining tests from the old file that reference `per_type_overrides_allowed` or expect `ok: false` for override conflicts.

- [ ] **Step 5: Commit**

```bash
git add src/validation/merge.ts tests/validation/merge.test.ts
git commit -m "feat: merge logic — cancellation-to-global + per-type enum resolution"
```

---

### Task 6: Validation Pipeline Integration

Update `validate.ts` to use per-type enum values for coercion and ENUM_MISMATCH details.

**Files:**
- Modify: `src/validation/validate.ts:116-170`
- Test: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write failing tests for per-type enum validation**

Add to `tests/validation/validate.test.ts`. (Read existing file first.)

```typescript
describe('per-type enum override validation', () => {
  it('accepts value valid for one type but not another (valid-for-any-type)', () => {
    const globals = new Map([
      ['subtype', makeGlobal({
        name: 'subtype', field_type: 'enum', enum_values: ['a', 'b'],
        overrides_allowed: { required: false, default_value: false, enum_values: true },
      })],
    ]);
    const claims = new Map([
      ['note', [makeClaim({ schema_name: 'note', field: 'subtype', enum_values_override: ['spec', 'bug'] })]],
      ['person', [makeClaim({ schema_name: 'person', field: 'subtype', enum_values_override: ['Author'] })]],
    ]);

    const result = validateProposedState(
      { subtype: 'spec' }, ['note', 'person'], claims, globals,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects value not valid for any type', () => {
    const globals = new Map([
      ['subtype', makeGlobal({
        name: 'subtype', field_type: 'enum', enum_values: ['a', 'b'],
        overrides_allowed: { required: false, default_value: false, enum_values: true },
      })],
    ]);
    const claims = new Map([
      ['note', [makeClaim({ schema_name: 'note', field: 'subtype', enum_values_override: ['spec', 'bug'] })]],
      ['person', [makeClaim({ schema_name: 'person', field: 'subtype', enum_values_override: ['Author'] })]],
    ]);

    const result = validateProposedState(
      { subtype: 'unknown' }, ['note', 'person'], claims, globals,
    );
    expect(result.valid).toBe(false);
    const issue = result.issues.find(i => i.code === 'ENUM_MISMATCH')!;
    // allowed_values should be deduplicated union from all types
    expect((issue.details as any).allowed_values).toEqual(
      expect.arrayContaining(['spec', 'bug', 'Author']),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: FAIL — validate doesn't know about per_type_enum_values.

- [ ] **Step 3: Update enum validation in `src/validation/validate.ts`**

In the validation loop for effective fields (around line 116), add per-type enum handling:

```typescript
    // ── Step 3: Validate and coerce provided fields ──────────────────
    // Determine effective enum values for this field
    if (ef.per_type_enum_values) {
      // Per-type enum validation: valid-for-any-type
      let accepted = false;
      let lastFailure: CoercionFailure | null = null;

      for (const pte of ef.per_type_enum_values) {
        const r = coerceValue(value, ef.global_field.field_type, {
          enum_values: pte.values ?? undefined,
          list_item_type: ef.global_field.list_item_type ?? undefined,
        });
        if (r.ok) {
          const entry: CoercedValue = {
            field: fieldName,
            value: r.value,
            source: 'provided',
            changed: r.changed,
          };
          if (r.changed) {
            entry.original = value;
            if (r.code) entry.coercion_code = r.code;
          }
          coerced_state[fieldName] = entry;
          accepted = true;
          break;
        }
        lastFailure = r as CoercionFailure;
      }

      if (!accepted && lastFailure) {
        // Collect all effective enum values across all types for closestMatches
        const allValues = new Set<string>();
        for (const pte of ef.per_type_enum_values) {
          if (pte.values) pte.values.forEach(v => allValues.add(v));
        }
        const deduped = Array.from(allValues);
        const matches = closestMatches(String(value), deduped);

        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'ENUM_MISMATCH',
          message: lastFailure.reason,
          details: {
            provided: value,
            allowed_values: deduped,
            closest_match: matches[0] ?? null,
          },
        });
      }
      continue;
    }

    // Standard coercion (no per-type enum overrides)
    const result = coerceValue(value, ef.global_field.field_type, {
      enum_values: ef.global_field.enum_values ?? undefined,
      list_item_type: ef.global_field.list_item_type ?? undefined,
    });
    // ... rest of existing code
```

Note: Import `closestMatches` from `coerce.ts` — it needs to be exported. If not currently exported, add `export` to the function declaration in `coerce.ts`.

- [ ] **Step 4: Export `closestMatches` from `src/validation/coerce.ts`**

Change line 174 from:
```typescript
function closestMatches(value: string, candidates: string[], max = 3): string[] {
```
to:
```typescript
export function closestMatches(value: string, candidates: string[], max = 3): string[] {
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/validation/validate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/validation/validate.ts src/validation/coerce.ts tests/validation/validate.test.ts
git commit -m "feat: per-type enum validation with valid-for-any-type resolution"
```

---

### Task 7: MCP Tools — Global Field Tools

Update `create-global-field`, `update-global-field`, and `describe-global-field` for the new `overrides_allowed` object.

**Files:**
- Modify: `src/mcp/tools/create-global-field.ts:23`
- Modify: `src/mcp/tools/update-global-field.ts:26`
- Modify: `src/mcp/tools/describe-global-field.ts:6-16,52-65`

- [ ] **Step 1: Update `src/mcp/tools/create-global-field.ts`**

Replace line 23:
```typescript
      // Remove: per_type_overrides_allowed: z.boolean().optional()...
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
```

- [ ] **Step 2: Update `src/mcp/tools/update-global-field.ts`**

Replace line 26:
```typescript
      // Remove: per_type_overrides_allowed: z.boolean().optional()...
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
```

- [ ] **Step 3: Update `src/mcp/tools/describe-global-field.ts`**

Update `GlobalFieldRow` interface (lines 6-16):
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

Update response (line 60):
```typescript
      // Remove: per_type_overrides_allowed: Boolean(row.per_type_overrides_allowed),
      overrides_allowed: {
        required: Boolean(row.overrides_allowed_required),
        default_value: Boolean(row.overrides_allowed_default_value),
        enum_values: Boolean(row.overrides_allowed_enum_values),
      },
```

- [ ] **Step 4: Run tool tests**

Run: `npx vitest run tests/mcp/tools.test.ts tests/phase2/tools.test.ts`
Expected: PASS (or update tests that reference `per_type_overrides_allowed`)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/create-global-field.ts src/mcp/tools/update-global-field.ts src/mcp/tools/describe-global-field.ts
git commit -m "feat: MCP global field tools with overrides_allowed object"
```

---

### Task 8: MCP Tools — Schema Tools + Validate-Node

Update `create-schema`, `update-schema`, `describe-schema`, and `validate-node` for the new claim shape.

**Files:**
- Modify: `src/mcp/tools/create-schema.ts:8-15`
- Modify: `src/mcp/tools/update-schema.ts:11-18,35-62`
- Modify: `src/mcp/tools/describe-schema.ts:15-85`
- Modify: `src/mcp/tools/validate-node.ts:70-92`

- [ ] **Step 1: Update `fieldClaimSchema` in `create-schema.ts` and `update-schema.ts`**

Both files share the same zod schema. Update in both:

```typescript
const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
  default_value_overridden: z.boolean().optional().describe('Set true when default_value key is present, even if null (override-to-null)'),
  enum_values_override: z.array(z.string()).optional().describe('Per-type enum values (replaces global enum_values for this type)'),
});
```

- [ ] **Step 2: Update `update-schema.ts` snapshot + diff**

Update the old claims snapshot (lines 35-48) to read new columns:

```typescript
        if (rest.field_claims && ctx?.writeLock && ctx?.vaultPath) {
          const rows = db.prepare('SELECT field, sort_order, label, description, required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ?')
            .all(name) as Array<{ field: string; sort_order: number; label: string | null; description: string | null; required_override: number | null; default_value_override: string | null; default_value_overridden: number; enum_values_override: string | null }>;
          oldClaims = rows.map(r => ({
            field: r.field,
            sort_order: r.sort_order,
            label: r.label ?? undefined,
            description: r.description ?? undefined,
            required: r.required_override !== null ? r.required_override === 1 : null,
            default_value: r.default_value_overridden ? (r.default_value_override !== null ? JSON.parse(r.default_value_override) : null) : undefined,
            enum_values_override: r.enum_values_override ? JSON.parse(r.enum_values_override) : undefined,
          }));
        }
```

And the new claims mapping (lines 55-62):

```typescript
          const newClaims = rest.field_claims.map(c => ({
            field: c.field,
            sort_order: c.sort_order,
            label: c.label,
            description: c.description,
            required: c.required ?? null,
            default_value: c.default_value_overridden ? c.default_value : (c.default_value ?? null),
            enum_values_override: c.enum_values_override ?? undefined,
          }));
```

- [ ] **Step 3: Update `describe-schema.ts`**

Update `ClaimRow` (lines 15-22):
```typescript
interface ClaimRow {
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number | null;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
}
```

Update the SQL query (line 60):
```typescript
      const claims = db.prepare(
        'SELECT field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ? ORDER BY sort_order ASC, field ASC'
      ).all(name) as ClaimRow[];
```

Update the claims mapping (lines 65-85):
```typescript
      const field_claims = claims.map(claim => {
        const gf = globalFieldStmt.get(claim.field) as GlobalFieldRow | undefined;

        // Resolve effective values for this type
        const effectiveEnumValues = claim.enum_values_override
          ? JSON.parse(claim.enum_values_override)
          : (gf?.enum_values ? JSON.parse(gf.enum_values) : null);
        const effectiveDefault = claim.default_value_overridden
          ? (claim.default_value_override !== null ? JSON.parse(claim.default_value_override) : null)
          : (gf?.default_value ? JSON.parse(gf.default_value) : null);
        const effectiveRequired = claim.required_override !== null
          ? Boolean(claim.required_override)
          : (gf ? Boolean(gf.required) : false);

        return {
          field: claim.field,
          label: claim.label,
          description: claim.description,
          sort_order: claim.sort_order,
          required_override: claim.required_override === null ? null : Boolean(claim.required_override),
          default_value_override: claim.default_value_overridden
            ? (claim.default_value_override !== null ? JSON.parse(claim.default_value_override) : null)
            : undefined,
          default_value_overridden: Boolean(claim.default_value_overridden),
          enum_values_override: claim.enum_values_override ? JSON.parse(claim.enum_values_override) : null,
          resolved: {
            enum_values: effectiveEnumValues,
            default_value: effectiveDefault,
            required: effectiveRequired,
          },
          global_field: gf ? {
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
          } : null,
        };
      });
```

Update `GlobalFieldRow` (lines 24-34) to use new column names:
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

- [ ] **Step 4: Update `validate-node.ts` inline claim loading (lines 70-92)**

```typescript
        for (const typeName of types) {
          const rows = db.prepare('SELECT * FROM schema_field_claims WHERE schema_name = ?').all(typeName) as Array<{
            schema_name: string;
            field: string;
            label: string | null;
            description: string | null;
            sort_order: number | null;
            required_override: number | null;
            default_value_override: string | null;
            default_value_overridden: number;
            enum_values_override: string | null;
          }>;
          if (rows.length > 0) {
            claimsByType.set(typeName, rows.map(r => ({
              schema_name: r.schema_name,
              field: r.field,
              label: r.label,
              description: r.description,
              sort_order: r.sort_order ?? 1000,
              required_override: r.required_override !== null ? r.required_override === 1 : null,
              default_value_override: r.default_value_overridden === 1
                ? { kind: 'override' as const, value: r.default_value_override !== null ? JSON.parse(r.default_value_override) : null }
                : { kind: 'inherit' as const },
              enum_values_override: r.enum_values_override !== null ? JSON.parse(r.enum_values_override) : null,
            })));
          }
        }
```

- [ ] **Step 5: Run MCP tool tests**

Run: `npx vitest run tests/mcp/tools.test.ts tests/phase2/tools.test.ts tests/phase3/tools.test.ts`
Expected: PASS (update any tests referencing old column names)

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/create-schema.ts src/mcp/tools/update-schema.ts src/mcp/tools/describe-schema.ts src/mcp/tools/validate-node.ts
git commit -m "feat: MCP schema + validate-node tools with override slots"
```

---

### Task 9: YAML Rendering

Update the schema and field YAML renderers to use the new column names and surface the new override properties.

**Files:**
- Modify: `src/schema/render.ts:40-114`

- [ ] **Step 1: Update `renderSchemaFile` claim loading SQL (lines 40-55)**

```typescript
    const claims = db.prepare(`
      SELECT sfc.*, gf.field_type, gf.enum_values, gf.reference_target, gf.description as gf_description,
             gf.default_value as gf_default_value, gf.required as gf_required,
             gf.overrides_allowed_required, gf.overrides_allowed_default_value, gf.overrides_allowed_enum_values,
             gf.list_item_type
      FROM schema_field_claims sfc
      JOIN global_fields gf ON gf.name = sfc.field
      WHERE sfc.schema_name = ?
      ORDER BY sfc.sort_order, sfc.field
    `).all(schemaName) as Array<{
      field: string; sort_order: number; label: string | null; description: string | null;
      required_override: number | null; default_value_override: string | null;
      default_value_overridden: number; enum_values_override: string | null;
      field_type: string; enum_values: string | null; reference_target: string | null;
      gf_description: string | null; gf_default_value: string | null; gf_required: number;
      overrides_allowed_required: number; overrides_allowed_default_value: number;
      overrides_allowed_enum_values: number; list_item_type: string | null;
    }>;
```

- [ ] **Step 2: Update claim YAML rendering (lines 64-78)**

```typescript
  data.field_claims = claims.map(c => {
    const claim: Record<string, unknown> = { field: c.field };
    if (c.sort_order !== 1000) claim.sort_order = c.sort_order;
    if (c.required_override !== null) claim.required_override = c.required_override === 1;
    if (c.default_value_overridden) {
      claim.default_value_override = c.default_value_override !== null ? JSON.parse(c.default_value_override) : null;
    }
    if (c.enum_values_override) claim.enum_values_override = JSON.parse(c.enum_values_override);

    const gf: Record<string, unknown> = { field_type: c.field_type };
    if (c.enum_values) gf.enum_values = JSON.parse(c.enum_values);
    if (c.list_item_type) gf.list_item_type = c.list_item_type;
    if (c.reference_target) gf.reference_target = c.reference_target;
    if (c.gf_required) gf.required = false;
    claim.global_field = gf;

    return claim;
  });
```

- [ ] **Step 3: Update `renderFieldsFile` (lines 87-114)**

Replace the `per_type_overrides_allowed` rendering (line 107):

```typescript
      // Replace: if (f.per_type_overrides_allowed) entry.per_type_overrides_allowed = true;
      const hasOverrides = f.overrides_allowed_required || f.overrides_allowed_default_value || f.overrides_allowed_enum_values;
      if (hasOverrides) {
        entry.overrides_allowed = {
          ...(f.overrides_allowed_required ? { required: true } : {}),
          ...(f.overrides_allowed_default_value ? { default_value: true } : {}),
          ...(f.overrides_allowed_enum_values ? { enum_values: true } : {}),
        };
      }
```

- [ ] **Step 4: Run schema rendering tests**

Run: `npx vitest run tests/phase3/schema-render.test.ts`
Expected: PASS (update assertions that reference `per_type_overrides_allowed`)

- [ ] **Step 5: Commit**

```bash
git add src/schema/render.ts
git commit -m "feat: YAML rendering for overrides_allowed object and claim overrides"
```

---

### Task 10: Propagation + Populate-Defaults

Update `diffClaims` for new override properties and `populateDefaults` for the new `FieldClaim` shape.

**Files:**
- Modify: `src/schema/propagate.ts:35-68,149-157`
- Modify: `src/pipeline/populate-defaults.ts:43-57`

- [ ] **Step 1: Update `diffClaims` in `src/schema/propagate.ts`**

Update the diff function signature and comparison (lines 35-68):

```typescript
export function diffClaims(
  oldClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown; enum_values_override?: string[] }>,
  newClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown; enum_values_override?: string[] }>,
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
```

- [ ] **Step 2: Update `populateDefaults` default source detection (lines 43-57)**

```typescript
      // Determine source: if any claim has a non-inherit default, it's from a claim
      let source: 'global' | 'claim' = 'global';
      for (const claims of claimsByType.values()) {
        for (const c of claims) {
          if (c.field === fieldName && c.default_value_override.kind === 'override') {
            source = 'claim';
            break;
          }
        }
        if (source === 'claim') break;
      }
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/schema/propagate.ts src/pipeline/populate-defaults.ts
git commit -m "feat: propagation and populate-defaults updated for override types"
```

---

### Task 11: Integration Tests + Round-Trip Tests

Dedicated tests for the discriminated union round-trip, DB round-trip, and override removal.

**Files:**
- Create: `tests/validation/overrides.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField, getGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition } from '../../src/schema/crud.js';
import { loadSchemaContext } from '../../src/pipeline/schema-context.js';
import { mergeFieldClaims } from '../../src/validation/merge.js';
import { validateProposedState } from '../../src/validation/validate.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('default_value_override: null round-trip', () => {
  it('DB round-trip: override-to-null survives CRUD cycle', () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['open', 'closed'],
      default_value: 'open',
      overrides_allowed: { default_value: true },
    });

    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'status', default_value_overridden: true }],
    });

    // Load back and check
    const ctx = loadSchemaContext(db, ['note']);
    const claim = ctx.claimsByType.get('note')![0];
    expect(claim.default_value_override).toEqual({ kind: 'override', value: null });

    // Merge should produce null default (not global)
    const result = mergeFieldClaims(['note'], ctx.claimsByType, ctx.globalFields);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective_fields.get('status')!.resolved_default_value).toBeNull();
  });

  it('override removal: update-schema omitting override reverts to global', () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['open', 'closed'],
      default_value: 'open',
      overrides_allowed: { default_value: true },
    });

    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'status', default_value_overridden: true }],
    });

    // Update without the override → should revert to inherit
    updateSchemaDefinition(db, 'note', {
      field_claims: [{ field: 'status' }],
    });

    const ctx = loadSchemaContext(db, ['note']);
    const claim = ctx.claimsByType.get('note')![0];
    expect(claim.default_value_override).toEqual({ kind: 'inherit' });

    const result = mergeFieldClaims(['note'], ctx.claimsByType, ctx.globalFields);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Now should use global default
    expect(result.effective_fields.get('status')!.resolved_default_value).toBe('open');
  });
});

describe('enum_values_override end-to-end', () => {
  it('list<enum> field with per-type overrides validates correctly', () => {
    createGlobalField(db, {
      name: 'subtype', field_type: 'list', list_item_type: 'enum',
      enum_values: ['a', 'b', 'c'],
      overrides_allowed: { enum_values: true },
    });

    createSchemaDefinition(db, {
      name: 'note',
      field_claims: [{ field: 'subtype', enum_values_override: ['spec', 'bug'] }],
    });
    createSchemaDefinition(db, {
      name: 'person',
      field_claims: [{ field: 'subtype', enum_values_override: ['Author', 'Athlete'] }],
    });

    const ctx = loadSchemaContext(db, ['note', 'person']);
    const result = validateProposedState(
      { subtype: ['spec'] }, ['note', 'person'], ctx.claimsByType, ctx.globalFields,
    );
    expect(result.valid).toBe(true);

    const badResult = validateProposedState(
      { subtype: ['unknown'] }, ['note', 'person'], ctx.claimsByType, ctx.globalFields,
    );
    expect(badResult.valid).toBe(false);
  });
});

describe('migration from per_type_overrides_allowed', () => {
  it('existing true flag maps to required + default_value allowed, enum_values not', () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['open'],
      overrides_allowed: { required: true, default_value: true },
    });
    const field = getGlobalField(db, 'status')!;
    expect(field.overrides_allowed).toEqual({ required: true, default_value: true, enum_values: false });
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/validation/overrides.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite for regressions**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/validation/overrides.test.ts
git commit -m "test: integration tests for per-type overrides — round-trip, enum validation, migration"
```

---

### Task 12: Wire Migration into Startup + Final Cleanup

Call the migration at startup and fix any remaining compilation errors or test failures.

**Files:**
- Modify: `src/db/connection.ts` or wherever migrations are called at startup
- Modify: `src/sync/normalizer.ts` (uses mergeFieldClaims)

- [ ] **Step 1: Find and read the startup migration call site**

Search for where `upgradeToPhase2`, `upgradeToPhase3`, etc. are called. Add `upgradeForOverrides` in sequence.

- [ ] **Step 2: Wire `upgradeForOverrides` into startup**

Add after the existing migration calls:

```typescript
import { upgradeForOverrides } from './migrate.js';
// ... after other upgrades:
upgradeForOverrides(db);
```

- [ ] **Step 3: Fix normalizer import**

`src/sync/normalizer.ts` uses `mergeFieldClaims` and accesses `partial_fields`. Update it to handle the simplified merge result (which now always returns `ok: true`):

The normalizer already handles both branches:
```typescript
const effectiveFields = mergeResult.ok ? mergeResult.effective_fields : mergeResult.partial_fields;
```
Since merge now always returns `ok: true`, this continues to work. No change needed unless there are compilation errors from the type changes.

- [ ] **Step 4: Run full test suite + type check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: No compilation errors, all tests PASS.

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat: wire overrides migration into startup, final cleanup"
```

---

## Post-Implementation Notes

After all tasks pass, the override mechanism is ready. The follow-on work from the spec (migrating `subtype` to `list<enum>` and updating schemas with overrides) is done via MCP tool calls, not code changes.

The `MergeResult` type still has the `ok: false` branch in the union. It can be cleaned up in a separate commit if desired, but leaving it is harmless and preserves the option to add future conflict types.
