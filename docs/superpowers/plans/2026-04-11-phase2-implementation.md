# Phase 2 Implementation Plan — Schema System and Field Pool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a validated schema system and global field pool — DB-only, no write path — with 10 new MCP tools, 4 enriched tools, and a pure-function validation engine.

**Architecture:** Global fields are the source of truth for field shape (DB rows). Schemas claim fields from the pool and layer presentation metadata. The validation engine is a pure function module; conformance facts are query-time joins, never materialized. The indexer is unchanged.

**Tech Stack:** TypeScript (ESM), better-sqlite3, vitest, zod (MCP param validation), @modelcontextprotocol/sdk

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `src/db/migrate.ts` | Phase 2 upgrade migration (ALTER TABLE + CREATE TABLE) |
| `src/validation/types.ts` | Shared types: `GlobalFieldDefinition`, `FieldClaim`, `EffectiveField`, `MergeConflict`, `CoercedValue`, `ValidationIssue`, `ValidationResult` |
| `src/validation/coerce.ts` | Pure coercion functions: value coercion per field type |
| `src/validation/merge.ts` | Pure merge algorithm: multi-type field claim merging |
| `src/validation/validate.ts` | Pure validation engine: orchestrates merge + coercion |
| `src/validation/conformance.ts` | Cheap-join conformance queries (steps 1-2 of merge for get-node) |
| `src/global-fields/crud.ts` | Global field CRUD operations (create, update, rename, delete) |
| `src/schema/crud.ts` | Schema CRUD operations (create, update, delete) |
| `src/discovery/list-field-values.ts` | Distinct value query logic |
| `src/discovery/infer-field-type.ts` | Field type inference from observed data |
| `src/mcp/tools/create-global-field.ts` | MCP tool handler |
| `src/mcp/tools/update-global-field.ts` | MCP tool handler |
| `src/mcp/tools/rename-global-field.ts` | MCP tool handler |
| `src/mcp/tools/delete-global-field.ts` | MCP tool handler |
| `src/mcp/tools/create-schema.ts` | MCP tool handler |
| `src/mcp/tools/update-schema.ts` | MCP tool handler |
| `src/mcp/tools/delete-schema.ts` | MCP tool handler |
| `src/mcp/tools/validate-node.ts` | MCP tool handler |
| `src/mcp/tools/infer-field-type.ts` | MCP tool handler |
| `src/mcp/tools/list-field-values.ts` | MCP tool handler |
| `tests/validation/coerce.test.ts` | Coercion unit tests |
| `tests/validation/merge.test.ts` | Merge algorithm unit tests |
| `tests/validation/validate.test.ts` | Full validation engine tests |
| `tests/global-fields/crud.test.ts` | Global field CRUD integration tests |
| `tests/schema/crud.test.ts` | Schema CRUD integration tests |
| `tests/discovery/list-field-values.test.ts` | Discovery tool tests |
| `tests/discovery/infer-field-type.test.ts` | Inference tool tests |
| `tests/phase2/tools.test.ts` | MCP tool response shape tests |
| `tests/phase2/conformance.test.ts` | Cross-tool schemaless consistency + query-count discipline |
| `tests/phase2/end-to-end.test.ts` | Full Phase 2 integration test |

### Modified files

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add Phase 2 columns to CREATE TABLE for fresh installs; add `schema_field_claims` table |
| `src/mcp/tools/index.ts` | Register 10 new tool handlers |
| `src/mcp/tools/get-node.ts` | Add `conformance` block to response |
| `src/mcp/tools/describe-schema.ts` | Add field_claims from join table, global field inline, node_count, field_coverage, orphan_field_names |
| `src/mcp/tools/describe-global-field.ts` | Add claimed_by_types, node_count, orphan_count; include new columns |
| `src/mcp/tools/list-types.ts` | Add has_schema, claim_count |
| `src/mcp/tools/errors.ts` | No change needed — existing `toolResult`/`toolErrorResult` suffice |
| `tests/db/schema.test.ts` | Add tests for Phase 2 tables/columns |

---

## Task 1: DB Migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrate.ts`
- Modify: `tests/db/schema.test.ts`

- [ ] **Step 1: Write failing tests for Phase 2 schema additions**

Add to `tests/db/schema.test.ts`:

```typescript
it('creates schema_field_claims table', () => {
  const db = createTestDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_field_claims'"
  ).all();
  expect(tables).toHaveLength(1);
});

it('global_fields has Phase 2 columns', () => {
  const db = createTestDb();
  const cols = db.prepare('PRAGMA table_info(global_fields)').all() as Array<{ name: string }>;
  const names = cols.map(c => c.name);
  expect(names).toContain('required');
  expect(names).toContain('per_type_overrides_allowed');
  expect(names).toContain('list_item_type');
});

it('schema_field_claims cascades on schema delete', () => {
  const db = createTestDb();
  db.prepare("INSERT INTO global_fields (name, field_type) VALUES ('due_date', 'date')").run();
  db.prepare("INSERT INTO schemas (name, field_claims) VALUES ('task', '[]')").run();
  db.prepare("INSERT INTO schema_field_claims (schema_name, field) VALUES ('task', 'due_date')").run();

  db.prepare("DELETE FROM schemas WHERE name = 'task'").run();
  const claims = db.prepare("SELECT * FROM schema_field_claims WHERE schema_name = 'task'").all();
  expect(claims).toHaveLength(0);
});

it('schema_field_claims has index on field column', () => {
  const db = createTestDb();
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='schema_field_claims'"
  ).all() as Array<{ name: string }>;
  const names = indexes.map(i => i.name);
  expect(names).toContain('idx_sfc_field');
});

it('upgrade migration adds Phase 2 columns to existing DB', () => {
  const db = createTestDb();
  // createTestDb already includes Phase 2 columns, so this tests idempotency
  upgradeToPhase2(db);
  const cols = db.prepare('PRAGMA table_info(global_fields)').all() as Array<{ name: string }>;
  const names = cols.map(c => c.name);
  expect(names).toContain('required');
  expect(names).toContain('per_type_overrides_allowed');
  expect(names).toContain('list_item_type');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/db/schema.test.ts`
Expected: FAIL — `schema_field_claims` table doesn't exist, columns missing, `upgradeToPhase2` not found

- [ ] **Step 3: Update `src/db/schema.ts` with Phase 2 additions for fresh installs**

Add Phase 2 columns to the `global_fields` CREATE TABLE and add the `schema_field_claims` table:

```typescript
// In the CREATE TABLE IF NOT EXISTS global_fields block, add after default_value:
//   required INTEGER NOT NULL DEFAULT 0,
//   per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0,
//   list_item_type TEXT

// After the schemas table, add:
/*
    CREATE TABLE IF NOT EXISTS schema_field_claims (
      schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      field TEXT NOT NULL REFERENCES global_fields(name),
      label TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 1000,
      required INTEGER,
      default_value TEXT,
      PRIMARY KEY (schema_name, field)
    );
    CREATE INDEX IF NOT EXISTS idx_sfc_field ON schema_field_claims(field);
*/
```

- [ ] **Step 4: Create `src/db/migrate.ts` for existing DB upgrades**

```typescript
import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table) as { count: number };
  return row.count > 0;
}

export function upgradeToPhase2(db: Database.Database): void {
  const txn = db.transaction(() => {
    if (!hasColumn(db, 'global_fields', 'required')) {
      db.exec('ALTER TABLE global_fields ADD COLUMN required INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(db, 'global_fields', 'per_type_overrides_allowed')) {
      db.exec('ALTER TABLE global_fields ADD COLUMN per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(db, 'global_fields', 'list_item_type')) {
      db.exec('ALTER TABLE global_fields ADD COLUMN list_item_type TEXT');
    }

    if (!tableExists(db, 'schema_field_claims')) {
      db.exec(`
        CREATE TABLE schema_field_claims (
          schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
          field TEXT NOT NULL REFERENCES global_fields(name),
          label TEXT,
          description TEXT,
          sort_order INTEGER DEFAULT 1000,
          required INTEGER,
          default_value TEXT,
          PRIMARY KEY (schema_name, field)
        );
        CREATE INDEX idx_sfc_field ON schema_field_claims(field);
      `);
    }
  });
  txn();
}
```

- [ ] **Step 5: Update test import and run tests**

Add `import { upgradeToPhase2 } from '../../src/db/migrate.js';` to the test file.

Run: `npm test -- tests/db/schema.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts tests/db/schema.test.ts
git commit -m "feat: Phase 2 DB migration — global_fields columns + schema_field_claims table"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/validation/types.ts`

- [ ] **Step 1: Create the shared type definitions**

```typescript
// src/validation/types.ts

export interface GlobalFieldDefinition {
  name: string;
  field_type: FieldType;
  enum_values: string[] | null;
  reference_target: string | null;
  description: string | null;
  default_value: unknown;
  required: boolean;
  per_type_overrides_allowed: boolean;
  list_item_type: FieldType | null;
}

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'enum' | 'list';

export interface FieldClaim {
  schema_name: string;
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required: boolean | null;
  default_value: unknown;
}

export interface EffectiveField {
  field: string;
  global_field: GlobalFieldDefinition;
  resolved_label: string | null;
  resolved_description: string | null;
  resolved_order: number;
  resolved_required: boolean;
  resolved_default_value: unknown;
  claiming_types: string[];
}

export type EffectiveFieldSet = Map<string, EffectiveField>;

export interface MergeConflict {
  field: string;
  property: 'required' | 'default_value';
  conflicting_claims: Array<{ type: string; value: unknown }>;
}

export type MergeResult =
  | { ok: true; effective_fields: EffectiveFieldSet }
  | { ok: false; conflicts: MergeConflict[]; partial_fields: EffectiveFieldSet };

export interface CoercedValue {
  field: string;
  value: unknown;
  original?: unknown;
  source: 'provided' | 'defaulted' | 'orphan';
  changed: boolean;
}

export interface ValidationIssue {
  field: string;
  severity: 'error';
  code: IssueCode;
  message: string;
  details?: unknown;
}

export type IssueCode =
  | 'REQUIRED_MISSING'
  | 'ENUM_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'COERCION_FAILED'
  | 'LIST_ITEM_COERCION_FAILED'
  | 'MERGE_CONFLICT'
  | 'INTERNAL_CONSISTENCY';

export interface ValidationResult {
  valid: boolean;
  effective_fields: EffectiveFieldSet;
  coerced_state: Record<string, CoercedValue>;
  issues: ValidationIssue[];
  orphan_fields: string[];
}

export interface ConformanceResult {
  claimed_fields: Array<{ field: string; claiming_types: string[] }>;
  orphan_fields: string[];
  unfilled_claims: Array<{ field: string; claiming_types: string[]; required: boolean }>;
  types_with_schemas: string[];
  types_without_schemas: string[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/validation/types.ts
git commit -m "feat: Phase 2 shared types — validation, merge, conformance interfaces"
```

---

## Task 3: Coercion Engine

**Files:**
- Create: `src/validation/coerce.ts`
- Create: `tests/validation/coerce.test.ts`

- [ ] **Step 1: Write failing coercion tests**

Create `tests/validation/coerce.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { coerceValue } from '../../src/validation/coerce.js';

describe('coerceValue', () => {
  describe('string to number', () => {
    it('coerces clean numeric string', () => {
      const r = coerceValue('42', 'number');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(42);
    });

    it('coerces float string', () => {
      const r = coerceValue('3.14', 'number');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(3.14);
    });

    it('coerces negative', () => {
      const r = coerceValue('-7', 'number');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(-7);
    });

    it('rejects trailing junk', () => {
      expect(coerceValue('42 dollars', 'number').ok).toBe(false);
    });

    it('rejects Infinity', () => {
      expect(coerceValue('Infinity', 'number').ok).toBe(false);
    });

    it('rejects -Infinity', () => {
      expect(coerceValue('-Infinity', 'number').ok).toBe(false);
    });

    it('rejects empty string', () => {
      expect(coerceValue('', 'number').ok).toBe(false);
    });

    it('rejects NaN string', () => {
      expect(coerceValue('NaN', 'number').ok).toBe(false);
    });
  });

  describe('string to date', () => {
    it('accepts date-only', () => {
      const r = coerceValue('2026-04-11', 'date');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('2026-04-11');
    });

    it('accepts date-time', () => {
      const r = coerceValue('2026-04-11T14:30:00', 'date');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('2026-04-11T14:30:00');
    });

    it('accepts date-time with timezone', () => {
      const r = coerceValue('2026-04-11T14:30:00Z', 'date');
      expect(r.ok).toBe(true);
    });

    it('rejects invalid date', () => {
      expect(coerceValue('not-a-date', 'date').ok).toBe(false);
    });

    it('rejects impossible date', () => {
      expect(coerceValue('2026-13-01', 'date').ok).toBe(false);
    });
  });

  describe('string to boolean', () => {
    it.each([
      ['true', true], ['True', true], ['TRUE', true],
      ['false', false], ['False', false], ['FALSE', false],
      ['yes', true], ['Yes', true], ['YES', true],
      ['no', false], ['No', false], ['NO', false],
    ])('coerces "%s" to %s', (input, expected) => {
      const r = coerceValue(input, 'boolean');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(expected);
    });

    it('rejects "1"', () => {
      expect(coerceValue('1', 'boolean').ok).toBe(false);
    });

    it('rejects "0"', () => {
      expect(coerceValue('0', 'boolean').ok).toBe(false);
    });

    it('rejects arbitrary string', () => {
      expect(coerceValue('maybe', 'boolean').ok).toBe(false);
    });
  });

  describe('string to enum', () => {
    const enumValues = ['open', 'closed', 'in-progress'];

    it('matches exact', () => {
      const r = coerceValue('open', 'enum', { enum_values: enumValues });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('open');
    });

    it('matches case-insensitive', () => {
      const r = coerceValue('OPEN', 'enum', { enum_values: enumValues });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('open');
    });

    it('trims whitespace', () => {
      const r = coerceValue('  open  ', 'enum', { enum_values: enumValues });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('open');
    });

    it('coerces non-string via String()', () => {
      const r = coerceValue(42, 'enum', { enum_values: ['42', '99'] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('42');
    });

    it('rejects non-matching', () => {
      const r = coerceValue('invalid', 'enum', { enum_values: enumValues });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.closest_matches).toBeDefined();
    });
  });

  describe('string to reference', () => {
    it('wraps bare value', () => {
      const r = coerceValue('Alice', 'reference');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('[[Alice]]');
    });

    it('leaves already-wrapped alone', () => {
      const r = coerceValue('[[Alice]]', 'reference');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('[[Alice]]');
    });

    it('preserves aliases', () => {
      const r = coerceValue('[[Alice|our contact]]', 'reference');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('[[Alice|our contact]]');
    });
  });

  describe('number to string', () => {
    it('converts number to string', () => {
      const r = coerceValue(42, 'string');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe('42');
    });
  });

  describe('single value to list', () => {
    it('wraps string to list<string>', () => {
      const r = coerceValue('alice', 'list', { list_item_type: 'string' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual(['alice']);
    });

    it('rejects number for list<string> without wrapping', () => {
      expect(coerceValue(42, 'list', { list_item_type: 'string' }).ok).toBe(false);
    });
  });

  describe('list element coercion', () => {
    it('coerces each element', () => {
      const r = coerceValue(['1', '2', '3'], 'list', { list_item_type: 'number' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual([1, 2, 3]);
    });

    it('reports failing element index', () => {
      const r = coerceValue(['1', 'bad', '3'], 'list', { list_item_type: 'number' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.element_errors).toBeDefined();
        expect(r.element_errors![0].index).toBe(1);
      }
    });
  });

  describe('no coercion needed', () => {
    it('passes string through for string field', () => {
      const r = coerceValue('hello', 'string');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe('hello');
        expect(r.changed).toBe(false);
      }
    });

    it('passes number through for number field', () => {
      const r = coerceValue(42, 'number');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe(42);
        expect(r.changed).toBe(false);
      }
    });

    it('passes boolean through for boolean field', () => {
      const r = coerceValue(true, 'boolean');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe(true);
        expect(r.changed).toBe(false);
      }
    });

    it('passes array through for list field', () => {
      const r = coerceValue(['a', 'b'], 'list', { list_item_type: 'string' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toEqual(['a', 'b']);
        expect(r.changed).toBe(false);
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/validation/coerce.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/validation/coerce.ts`**

```typescript
import type { FieldType } from './types.js';

export interface CoercionSuccess {
  ok: true;
  value: unknown;
  changed: boolean;
}

export interface CoercionFailure {
  ok: false;
  reason: string;
  from_type: string;
  to_type: string;
  closest_matches?: string[];
  element_errors?: Array<{ index: number; value: unknown; reason: string }>;
}

export type CoercionResult = CoercionSuccess | CoercionFailure;

interface CoercionOptions {
  enum_values?: string[];
  list_item_type?: FieldType;
}

export function coerceValue(
  value: unknown,
  targetType: FieldType,
  options?: CoercionOptions,
): CoercionResult {
  if (value === null || value === undefined) {
    return { ok: true, value: null, changed: false };
  }

  switch (targetType) {
    case 'string': return coerceToString(value);
    case 'number': return coerceToNumber(value);
    case 'date': return coerceToDate(value);
    case 'boolean': return coerceToBoolean(value);
    case 'enum': return coerceToEnum(value, options?.enum_values ?? []);
    case 'reference': return coerceToReference(value);
    case 'list': return coerceToList(value, options?.list_item_type ?? 'string', options);
    default: return { ok: false, reason: `Unknown target type: ${targetType}`, from_type: typeof value, to_type: targetType };
  }
}

function coerceToString(value: unknown): CoercionResult {
  if (typeof value === 'string') return { ok: true, value, changed: false };
  if (typeof value === 'number') return { ok: true, value: String(value), changed: true };
  if (value instanceof Date) return { ok: true, value: value.toISOString(), changed: true };
  return { ok: false, reason: `Cannot coerce ${typeof value} to string`, from_type: typeof value, to_type: 'string' };
}

function coerceToNumber(value: unknown): CoercionResult {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { ok: false, reason: 'Infinity and NaN are not valid numbers', from_type: 'number', to_type: 'number' };
    }
    return { ok: true, value, changed: false };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: false, reason: 'Empty string cannot be coerced to number', from_type: 'string', to_type: 'number' };
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return { ok: false, reason: `"${value}" is not a valid number`, from_type: 'string', to_type: 'number' };
    return { ok: true, value: num, changed: true };
  }
  return { ok: false, reason: `Cannot coerce ${typeof value} to number`, from_type: typeof value, to_type: 'number' };
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function coerceToDate(value: unknown): CoercionResult {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return { ok: false, reason: 'Invalid Date object', from_type: 'Date', to_type: 'date' };
    return { ok: true, value: value.toISOString(), changed: true };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (ISO_DATE_ONLY.test(trimmed)) {
      const parts = trimmed.split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      if (d.getFullYear() !== parts[0] || d.getMonth() !== parts[1] - 1 || d.getDate() !== parts[2]) {
        return { ok: false, reason: `"${value}" is not a valid date`, from_type: 'string', to_type: 'date' };
      }
      return { ok: true, value: trimmed, changed: false };
    }
    if (ISO_DATE_TIME.test(trimmed)) {
      const d = new Date(trimmed);
      if (isNaN(d.getTime())) {
        return { ok: false, reason: `"${value}" is not a valid date-time`, from_type: 'string', to_type: 'date' };
      }
      return { ok: true, value: trimmed, changed: false };
    }
    return { ok: false, reason: `"${value}" is not ISO 8601 format`, from_type: 'string', to_type: 'date' };
  }
  return { ok: false, reason: `Cannot coerce ${typeof value} to date`, from_type: typeof value, to_type: 'date' };
}

function coerceToBoolean(value: unknown): CoercionResult {
  if (typeof value === 'boolean') return { ok: true, value, changed: false };
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === 'yes') return { ok: true, value: true, changed: true };
    if (lower === 'false' || lower === 'no') return { ok: true, value: false, changed: true };
    return { ok: false, reason: `"${value}" is not a valid boolean (accepted: true/false/yes/no)`, from_type: 'string', to_type: 'boolean' };
  }
  return { ok: false, reason: `Cannot coerce ${typeof value} to boolean`, from_type: typeof value, to_type: 'boolean' };
}

function coerceToEnum(value: unknown, enumValues: string[]): CoercionResult {
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  const match = enumValues.find(v => v.toLowerCase() === lowerTrimmed);
  if (match) {
    return { ok: true, value: match, changed: match !== value };
  }

  const closest = enumValues
    .filter(v => v.toLowerCase().includes(lowerTrimmed) || lowerTrimmed.includes(v.toLowerCase()))
    .slice(0, 3);

  return {
    ok: false,
    reason: `"${trimmed}" is not a valid enum value (valid: ${enumValues.join(', ')})`,
    from_type: typeof value === 'string' ? 'string' : typeof value,
    to_type: 'enum',
    closest_matches: closest,
  };
}

function coerceToReference(value: unknown): CoercionResult {
  if (typeof value !== 'string') {
    return { ok: false, reason: `Cannot coerce ${typeof value} to reference`, from_type: typeof value, to_type: 'reference' };
  }
  if (value.startsWith('[[') && value.endsWith(']]')) {
    return { ok: true, value, changed: false };
  }
  return { ok: true, value: `[[${value}]]`, changed: true };
}

function coerceToList(
  value: unknown,
  itemType: FieldType,
  options?: CoercionOptions,
): CoercionResult {
  if (!Array.isArray(value)) {
    if (typeof value === 'string' && itemType === 'string') {
      return { ok: true, value: [value], changed: true };
    }
    return { ok: false, reason: `Cannot coerce ${typeof value} to list`, from_type: typeof value, to_type: 'list' };
  }

  const result: unknown[] = [];
  const errors: Array<{ index: number; value: unknown; reason: string }> = [];
  let anyChanged = false;

  for (let i = 0; i < value.length; i++) {
    const elementResult = coerceValue(value[i], itemType, {
      enum_values: options?.enum_values,
    });
    if (elementResult.ok) {
      result.push(elementResult.value);
      if (elementResult.changed) anyChanged = true;
    } else {
      errors.push({ index: i, value: value[i], reason: elementResult.reason });
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      reason: `${errors.length} list element(s) failed coercion`,
      from_type: 'list',
      to_type: 'list',
      element_errors: errors,
    };
  }

  return { ok: true, value: result, changed: anyChanged };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/validation/coerce.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite for no regressions**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/validation/coerce.ts tests/validation/coerce.test.ts
git commit -m "feat: coercion engine — deterministic value coercion per field type"
```

---

## Task 4: Merge Algorithm

**Files:**
- Create: `src/validation/merge.ts`
- Create: `tests/validation/merge.test.ts`

- [ ] **Step 1: Write failing merge tests**

Create `tests/validation/merge.test.ts`. Tests for: single type single claim, multi-type union, first-defined-wins for presentation, semantic conflict produces error, collects all conflicts, empty set for schemaless types, internal consistency error, global field defaults used when no override. See spec Section 4 for full merge algorithm.

The test helpers `gf()` and `claim()` create minimal `GlobalFieldDefinition` and `FieldClaim` objects with sensible defaults.

- [ ] **Step 2: Implement `src/validation/merge.ts`**

Pure function `mergeFieldClaims(types, claimsByType, globalFields) => MergeResult`. Steps: collect claims per type, union by field name, resolve presentation (first-defined-wins), resolve semantic (error on conflict when overrides allowed, internal consistency error when overrides not allowed but claim has them), remove conflicting fields from effective set to produce partial_fields.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- tests/validation/merge.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/validation/merge.ts tests/validation/merge.test.ts
git commit -m "feat: merge algorithm — multi-type field claim merging with conflict detection"
```

---

## Task 5: Validation Engine

**Files:**
- Create: `src/validation/validate.ts`
- Create: `tests/validation/validate.test.ts`

- [ ] **Step 1: Write failing validation tests**

Tests for: valid state passes, REQUIRED_MISSING, default_value supplied (source: 'defaulted'), null overrides default, null on required raises error, string-to-number coercion (check original field), enum mismatch with closest matches, orphan pass-through, merge conflicts + value errors in same run (no bail), all-schemaless trivial pass, list element coercion failure with index.

- [ ] **Step 2: Implement `src/validation/validate.ts`**

Pure function `validateProposedState(proposedFields, types, claimsByType, globalFields) => ValidationResult`. Orchestrates merge (falls back to partial on conflict), checks required/defaults, coerces provided fields, passes orphans through.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- tests/validation/validate.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/validation/validate.ts tests/validation/validate.test.ts
git commit -m "feat: validation engine — orchestrates merge + coercion into ValidationResult"
```

---

## Task 6: Global Field CRUD

**Files:**
- Create: `src/global-fields/crud.ts`
- Create: `tests/global-fields/crud.test.ts`

- [ ] **Step 1: Write failing tests**

Tests for: create string/enum/list fields, reject duplicates, reject enum without values, reject list without item type, reject nested lists, rename propagation (global_fields + node_fields + schema_field_claims), delete as metadata-only (node_fields untouched), update description, type change preview, type change with confirm.

- [ ] **Step 2: Implement `src/global-fields/crud.ts`**

Functions: `createGlobalField`, `updateGlobalField` (with type-change preview/confirm), `renameGlobalField` (atomic across 3 tables), `deleteGlobalField` (metadata-only), `getGlobalField`. Uses coercion engine for type change preview. All multi-column invariants enforced at application layer.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- tests/global-fields/crud.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/global-fields/crud.ts tests/global-fields/crud.test.ts
git commit -m "feat: global field CRUD — create, update, rename, delete with propagation"
```

---

## Task 7: Schema CRUD

**Files:**
- Create: `src/schema/crud.ts`
- Create: `tests/schema/crud.test.ts`

- [ ] **Step 1: Write failing tests**

Tests for: create schema with claims, reject nonexistent field, reject semantic override without permission, allow override when permitted, update replaces all claims, update metadata without touching claims, delete removes schema and claims (CASCADE) but leaves node_types.

- [ ] **Step 2: Implement `src/schema/crud.ts`**

Functions: `createSchemaDefinition`, `updateSchemaDefinition` (full-replace claims), `deleteSchemaDefinition` (CASCADE, node_types untouched), `getSchemaDefinition`. Validates claims against global_fields on create/update.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- tests/schema/crud.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/schema/crud.ts tests/schema/crud.test.ts
git commit -m "feat: schema CRUD — create, update, delete with claim validation"
```

---

## Task 8: Discovery Tools

**Files:**
- Create: `src/discovery/list-field-values.ts`
- Create: `src/discovery/infer-field-type.ts`
- Create: `tests/discovery/list-field-values.test.ts`
- Create: `tests/discovery/infer-field-type.test.ts`

- [ ] **Step 1: Write failing tests for both discovery tools**

`list-field-values`: distinct values with counts, type filter, limit, nonexistent field.
`infer-field-type`: high confidence number, varied text as string, enum suggestion for few distinct values, nonexistent field returns confidence 0.

- [ ] **Step 2: Implement both discovery modules**

`listFieldValues(db, fieldName, options?)`: query node_fields with optional type filter via node_types join. Returns values array, total_nodes, total_distinct.

`inferFieldType(db, fieldName)`: classify each row by populated column, pick dominant type, check for enum heuristic (few distinct values), compute confidence as dominant/total, collect dissenters.

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test -- tests/discovery/`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/discovery/ tests/discovery/
git commit -m "feat: discovery tools — list-field-values and infer-field-type"
```

---

## Task 9: Conformance Queries

**Files:**
- Create: `src/validation/conformance.ts`

- [ ] **Step 1: Implement conformance queries**

`getNodeConformance(db, nodeId, types) => ConformanceResult`: For each type, check if schema exists (types_with/without_schemas). Collect schema_field_claims. Compare against node_fields to produce three-way classification: claimed_fields, orphan_fields, unfilled_claims (with required from global_fields).

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/validation/conformance.ts
git commit -m "feat: conformance queries — cheap-join structural awareness for get-node"
```

---

## Task 10: MCP Tool Handlers

**Files:**
- Create: 10 new tool files in `src/mcp/tools/`
- Modify: `src/mcp/tools/index.ts`

- [ ] **Step 1: Create all 10 MCP tool handlers**

Each tool follows the existing pattern: `export function registerXxx(server: McpServer, db: Database.Database)` calling `server.tool()` with zod params, delegating to CRUD/validation/discovery modules, returning via `toolResult()`/`toolErrorResult()`. Wrap CRUD calls in try/catch, return `INVALID_PARAMS` on validation errors.

Tool list:
- `create-global-field.ts` — calls `createGlobalField()`
- `update-global-field.ts` — calls `updateGlobalField()`
- `rename-global-field.ts` — calls `renameGlobalField()`
- `delete-global-field.ts` — calls `deleteGlobalField()`
- `create-schema.ts` — calls `createSchemaDefinition()`
- `update-schema.ts` — calls `updateSchemaDefinition()`
- `delete-schema.ts` — calls `deleteSchemaDefinition()`
- `validate-node.ts` — loads claims/globals from DB, calls `validateProposedState()`, composes `types_without_schemas` via cheap join
- `infer-field-type.ts` — calls `inferFieldType()`
- `list-field-values.ts` — calls `listFieldValues()`

The `validate-node.ts` handler handles two modes (node_id vs proposed), loads `FieldClaim[]` and `GlobalFieldDefinition` maps from DB, calls the pure validation engine, and adds `types_without_schemas` from a schema-existence check.

- [ ] **Step 2: Update `src/mcp/tools/index.ts` to register all new tools**

Add imports for all 10 new register functions and call them in `registerAllTools()`.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/
git commit -m "feat: 10 new MCP tool handlers for Phase 2 schema/field/validation tools"
```

---

## Task 11: Enrich Existing Tools

**Files:**
- Modify: `src/mcp/tools/get-node.ts`
- Modify: `src/mcp/tools/describe-schema.ts`
- Modify: `src/mcp/tools/describe-global-field.ts`
- Modify: `src/mcp/tools/list-types.ts`

- [ ] **Step 1: Enrich `get-node` with conformance block**

Import `getNodeConformance`. After building the existing response, call it with the node's ID and types, add result as `conformance` property.

- [ ] **Step 2: Enrich `describe-schema`**

Rewrite to read claims from `schema_field_claims` join table (not JSON column). For each claim, inline the global field definition. Add `node_count` (count from node_types), `field_coverage` (per claimed field: `{have_value, total}`), `orphan_field_names` (fields on nodes of this type not in claims — interpretation (a) from spec).

- [ ] **Step 3: Enrich `describe-global-field`**

Add `claimed_by_types` (from schema_field_claims), `node_count` (distinct node_fields), `orphan_count` (nodes with field but no claiming type). Include Phase 2 columns in response.

- [ ] **Step 4: Enrich `list-types`**

Join against schemas table for `has_schema: boolean`. When true, count schema_field_claims for `claim_count`. When false, `claim_count: null`.

- [ ] **Step 5: Verify compilation and run full suite**

Run: `npx tsc --noEmit && npm test`
Expected: No errors, all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/get-node.ts src/mcp/tools/describe-schema.ts src/mcp/tools/describe-global-field.ts src/mcp/tools/list-types.ts
git commit -m "feat: enrich get-node, describe-schema, describe-global-field, list-types with Phase 2 conformance data"
```

---

## Task 12: MCP Tool Response Shape Tests

**Files:**
- Create: `tests/phase2/tools.test.ts`

- [ ] **Step 1: Write tool response shape tests**

Using the existing `getToolHandler` pattern from Phase 1 tests. Pre-populate DB with nodes, global fields, and schemas. Test:
- `get-node` conformance block (claimed, orphan, unfilled fields)
- `describe-schema` enrichments (node_count, field_coverage, orphan_field_names)
- `list-types` (has_schema, claim_count)
- `describe-global-field` (claimed_by_types, node_count)
- `validate-node` both modes (real node + hypothetical proposed)

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/phase2/tools.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/phase2/tools.test.ts
git commit -m "test: MCP tool response shape tests for Phase 2 enrichments"
```

---

## Task 13: Cross-Cutting Tests

**Files:**
- Create: `tests/phase2/conformance.test.ts`
- Create: `tests/phase2/end-to-end.test.ts`

- [ ] **Step 1: Write cross-tool schemaless consistency test**

Create a node with two types (one with schema, one without). Call `get-node`, `list-types`, and `validate-node`. Assert all three mark the schemaless type consistently.

- [ ] **Step 2: Write end-to-end integration test**

Full lifecycle in one test:
1. Create nodes with fields and types
2. Create global fields (string, enum, reference, list types)
3. Create schemas with field claims
4. Verify conformance via `getNodeConformance()`
5. Rename a global field — verify propagation
6. Update field type with preview/confirm — verify coercion + orphaning
7. Delete schema — verify node_types untouched, orphan emergence
8. Verify enrichments reflect all changes

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: ALL PASS (all Phase 1 + Phase 2 tests)

- [ ] **Step 4: Commit**

```bash
git add tests/phase2/
git commit -m "test: Phase 2 cross-tool consistency + end-to-end integration test"
```

---

## Task 14: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 2: Run TypeScript compilation**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Verify Phase 1 tests unchanged**

Run: `npm test -- tests/mcp/tools.test.ts tests/indexer/indexer.test.ts tests/parser/parse.test.ts`
Expected: ALL PASS — no regressions

- [ ] **Step 4: Commit any final fixes if needed**
