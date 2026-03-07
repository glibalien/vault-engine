# Multi-type Field Merging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `mergeSchemaFields(db, types)` that loads resolved schemas and merges their field definitions with conflict detection.

**Architecture:** Pure function in `src/schema/merger.ts`. Loads schemas via existing `getSchema()`, iterates field definitions, applies merge rules (compatible → merge, incompatible → conflict). New types (`MergedField`, `MergeConflict`, `MergeResult`) in `src/schema/types.ts`.

**Tech Stack:** TypeScript, better-sqlite3 (read-only via `getSchema`), vitest for tests.

---

### Task 1: Add Merger Types to types.ts

**Files:**
- Modify: `src/schema/types.ts`

**Step 1: Write the new types**

Add at the end of `src/schema/types.ts`:

```typescript
export interface MergedField {
  type: SchemaFieldType;
  required?: boolean;
  default?: unknown;
  values?: string[];
  target_schema?: string;
  sources: string[];
}

export interface MergeConflict {
  field: string;
  definitions: Array<{ schema: string; type: SchemaFieldType }>;
  message: string;
}

export interface MergeResult {
  fields: Record<string, MergedField>;
  conflicts: MergeConflict[];
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/schema/types.ts
git commit -m "add merger types: MergedField, MergeConflict, MergeResult"
```

---

### Task 2: Single Type and Empty Types Tests + Implementation

**Files:**
- Create: `tests/schema/merger.test.ts`
- Create: `src/schema/merger.ts`
- Modify: `src/schema/index.ts`

**Step 1: Write tests for empty array and single type**

Create `tests/schema/merger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { mergeSchemaFields } from '../../src/schema/merger.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('mergeSchemaFields', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty result for empty types array', () => {
    const result = mergeSchemaFields(db, []);
    expect(result.fields).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it('wraps single type fields as MergedFields', () => {
    const result = mergeSchemaFields(db, ['person']);
    expect(result.conflicts).toEqual([]);
    expect(result.fields.role).toEqual({
      type: 'string',
      sources: ['person'],
    });
    expect(result.fields.email).toEqual({
      type: 'string',
      sources: ['person'],
    });
    expect(result.fields.tags).toEqual({
      type: 'list<string>',
      sources: ['person'],
    });
  });

  it('preserves required and default on single type', () => {
    const result = mergeSchemaFields(db, ['task']);
    expect(result.fields.status.required).toBe(true);
    expect(result.fields.status.default).toBe('todo');
    expect(result.fields.status.values).toEqual(
      ['todo', 'in-progress', 'blocked', 'done', 'cancelled']
    );
    expect(result.fields.status.sources).toEqual(['task']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schema/merger.test.ts`
Expected: FAIL — module `../../src/schema/merger.js` not found.

**Step 3: Write minimal implementation**

Create `src/schema/merger.ts`:

```typescript
import type Database from 'better-sqlite3';
import { getSchema } from './loader.js';
import type { MergedField, MergeConflict, MergeResult, FieldDefinition } from './types.js';

function fieldToMerged(field: FieldDefinition, source: string): MergedField {
  const merged: MergedField = { type: field.type, sources: [source] };
  if (field.required) merged.required = true;
  if (field.default !== undefined) merged.default = field.default;
  if (field.values) merged.values = [...field.values];
  if (field.target_schema) merged.target_schema = field.target_schema;
  return merged;
}

export function mergeSchemaFields(db: Database.Database, types: string[]): MergeResult {
  if (types.length === 0) return { fields: {}, conflicts: [] };

  const conflicts: MergeConflict[] = [];
  const fields: Record<string, MergedField> = {};

  // Sort type names alphabetically for deterministic default resolution
  const sortedTypes = [...types].sort();

  for (const typeName of sortedTypes) {
    const schema = getSchema(db, typeName);
    if (!schema) {
      conflicts.push({
        field: '',
        definitions: [{ schema: typeName, type: 'string' }],
        message: `Unknown schema type '${typeName}'`,
      });
      continue;
    }

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      const existing = fields[fieldName];
      if (!existing) {
        fields[fieldName] = fieldToMerged(fieldDef, typeName);
        continue;
      }

      // Field exists — check compatibility
      const typesMatch = existing.type === fieldDef.type;
      const targetSchemaConflict =
        typesMatch &&
        (existing.type === 'reference' || existing.type === 'list<reference>') &&
        existing.target_schema !== undefined &&
        fieldDef.target_schema !== undefined &&
        existing.target_schema !== fieldDef.target_schema;

      if (!typesMatch || targetSchemaConflict) {
        // Incompatible — remove from fields, add conflict
        const existingDefs = existing.sources.map(s => ({
          schema: s,
          type: existing.type,
        }));
        conflicts.push({
          field: fieldName,
          definitions: [
            ...existingDefs,
            { schema: typeName, type: fieldDef.type },
          ],
          message: targetSchemaConflict
            ? `Field '${fieldName}' has conflicting target_schema: '${existing.target_schema}' vs '${fieldDef.target_schema}'`
            : `Field '${fieldName}' has incompatible types: '${existing.type}' (from ${existing.sources.join(', ')}) vs '${fieldDef.type}' (from ${typeName})`,
        });
        delete fields[fieldName];
        continue;
      }

      // Compatible — merge
      existing.sources.push(typeName);
      if (fieldDef.required) existing.required = true;
      // Default: first schema wins (alphabetical order). Deliberate choice —
      // alphabetical is arbitrary but deterministic. In inheritance, the child
      // already overrides via resolveInheritance. In multi-type merging there's
      // no inherent priority, so alphabetical is defensible.
      if (fieldDef.values) {
        const merged = new Set(existing.values ?? []);
        for (const v of fieldDef.values) merged.add(v);
        existing.values = [...merged];
      }
      if (existing.target_schema === undefined && fieldDef.target_schema) {
        existing.target_schema = fieldDef.target_schema;
      }
    }
  }

  return { fields, conflicts };
}
```

**Step 4: Add re-export to index.ts**

Add to `src/schema/index.ts`:

```typescript
export type { MergedField, MergeConflict, MergeResult } from './types.js';
export { mergeSchemaFields } from './merger.js';
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/schema/merger.test.ts`
Expected: All 3 tests PASS.

**Step 6: Commit**

```bash
git add src/schema/merger.ts src/schema/index.ts tests/schema/merger.test.ts
git commit -m "add mergeSchemaFields with single-type and empty-types support"
```

---

### Task 3: Compatible Field Merging Tests

**Files:**
- Modify: `tests/schema/merger.test.ts`

**Step 1: Write tests for compatible field merging**

Add to the `mergeSchemaFields` describe block in `tests/schema/merger.test.ts`:

```typescript
  it('merges compatible enum fields by unioning values', () => {
    // meeting.status: enum [scheduled, completed, cancelled]
    // task.status: enum [todo, in-progress, blocked, done, cancelled]
    const result = mergeSchemaFields(db, ['meeting', 'task']);

    expect(result.fields.status.type).toBe('enum');
    expect(result.fields.status.sources).toEqual(['meeting', 'task']);
    // Union of both value sets, deduplicated
    expect(result.fields.status.values).toContain('scheduled');
    expect(result.fields.status.values).toContain('completed');
    expect(result.fields.status.values).toContain('todo');
    expect(result.fields.status.values).toContain('in-progress');
    expect(result.fields.status.values).toContain('blocked');
    expect(result.fields.status.values).toContain('done');
    // 'cancelled' appears in both — only once
    expect(
      result.fields.status.values!.filter(v => v === 'cancelled')
    ).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
  });

  it('merges required as OR — required if any schema says required', () => {
    // meeting.status: not required (no required field)
    // task.status: required: true
    const result = mergeSchemaFields(db, ['meeting', 'task']);
    expect(result.fields.status.required).toBe(true);
  });

  it('uses first alphabetical schema default for compatible fields', () => {
    // meeting (alphabetically first) has status default: 'scheduled'
    // task has status default: 'todo'
    const result = mergeSchemaFields(db, ['meeting', 'task']);
    expect(result.fields.status.default).toBe('scheduled');
  });

  it('merges disjoint fields from multiple types', () => {
    // meeting has: date, attendees, project, status
    // task has: status, assignee, due_date, priority
    const result = mergeSchemaFields(db, ['meeting', 'task']);

    // meeting-only fields
    expect(result.fields.date).toBeDefined();
    expect(result.fields.date.sources).toEqual(['meeting']);
    expect(result.fields.attendees).toBeDefined();

    // task-only fields
    expect(result.fields.assignee).toBeDefined();
    expect(result.fields.assignee.sources).toEqual(['task']);
    expect(result.fields.due_date).toBeDefined();
    expect(result.fields.priority).toBeDefined();

    // shared field
    expect(result.fields.status.sources).toEqual(['meeting', 'task']);
  });

  it('merges reference fields with same target_schema', () => {
    // meeting.project: reference, target_schema: project
    // work-task also has project: reference, target_schema: project (inherited)
    // But work-task extends task, so let's use a direct test:
    // meeting and work-task both have project → reference → project
    const result = mergeSchemaFields(db, ['meeting', 'work-task']);
    expect(result.fields.project.type).toBe('reference');
    expect(result.fields.project.target_schema).toBe('project');
    expect(result.fields.project.sources).toEqual(['meeting', 'work-task']);
    // No conflict
    const projectConflicts = result.conflicts.filter(c => c.field === 'project');
    expect(projectConflicts).toEqual([]);
  });
```

**Step 2: Run tests**

Run: `npx vitest run tests/schema/merger.test.ts`
Expected: All tests PASS (implementation already handles these cases).

**Step 3: Commit**

```bash
git add tests/schema/merger.test.ts
git commit -m "add compatible field merging tests"
```

---

### Task 4: Incompatible Field and Unknown Type Tests

**Files:**
- Modify: `tests/schema/merger.test.ts`

**Step 1: Write tests for conflicts and unknown types**

These tests need schemas that create incompatible fields — the fixtures don't have any, so we'll create schemas inline using the tmp dir pattern from `loader.test.ts`. Add a new describe block:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
```

Add these imports at the top, then add a new describe block after the existing one:

```typescript
describe('mergeSchemaFields conflicts', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-merge-'));
    mkdirSync(join(tmpDir, '.schemas'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports conflict for same field name with different types', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  status:
    type: string
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  status:
    type: number
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['alpha', 'beta']);
    expect(result.fields.status).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('status');
    expect(result.conflicts[0].definitions).toEqual([
      { schema: 'alpha', type: 'string' },
      { schema: 'beta', type: 'number' },
    ]);
    expect(result.conflicts[0].message).toContain('incompatible types');
  });

  it('reports conflict for reference fields with different target_schema', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  owner:
    type: reference
    target_schema: person
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  owner:
    type: reference
    target_schema: project
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['alpha', 'beta']);
    expect(result.fields.owner).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('owner');
    expect(result.conflicts[0].message).toContain('target_schema');
  });

  it('reports unknown schema type in conflicts', () => {
    const result = mergeSchemaFields(db, ['nonexistent']);
    expect(result.fields).toEqual({});
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain("Unknown schema type 'nonexistent'");
  });

  it('merges known types and reports unknown ones', () => {
    writeFileSync(join(tmpDir, '.schemas', 'real.yaml'), `
name: real
fields:
  x:
    type: string
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['real', 'fake']);
    expect(result.fields.x).toBeDefined();
    expect(result.fields.x.sources).toEqual(['real']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain("Unknown schema type 'fake'");
  });

  it('non-conflicting fields survive alongside a conflicting field', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  shared:
    type: string
  unique_a:
    type: number
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  shared:
    type: boolean
  unique_b:
    type: date
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['alpha', 'beta']);
    // Conflicting field removed
    expect(result.fields.shared).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    // Non-conflicting fields preserved
    expect(result.fields.unique_a).toBeDefined();
    expect(result.fields.unique_b).toBeDefined();
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/schema/merger.test.ts`
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add tests/schema/merger.test.ts
git commit -m "add conflict and unknown type tests for field merging"
```

---

### Task 5: Type-check and Run Full Suite

**Files:** None (verification only).

**Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass, including new merger tests.

**Step 3: Commit (if any fixes were needed)**

Only if previous steps required fixes.
