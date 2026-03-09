# Schema Validation on Index — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Validate frontmatter fields against merged schema definitions during indexing, storing an `is_valid` flag on each node (warn, don't reject).

**Architecture:** A pure `validateNode` function in `src/schema/validator.ts` checks parsed file data against merged schema fields. `indexFile` calls it after inserting the node and sets `is_valid` on the `nodes` row. Three-state model: `null` (no schema), `1` (valid), `0` (has warnings).

**Tech Stack:** TypeScript, vitest, better-sqlite3

---

### Task 1: Add ValidationWarning and ValidationResult types

**Files:**
- Modify: `src/schema/types.ts`

**Step 1: Add the types at the end of `src/schema/types.ts`**

```typescript
export interface ValidationWarning {
  field: string;
  message: string;
  rule: 'required' | 'type_mismatch' | 'invalid_enum' | 'invalid_reference';
}

export interface ValidationResult {
  valid: boolean;
  warnings: ValidationWarning[];
}
```

**Step 2: Re-export from `src/schema/index.ts`**

Add `ValidationWarning` and `ValidationResult` to the type re-exports from `'./types.js'`.

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

**Step 4: Commit**

```
git add src/schema/types.ts src/schema/index.ts
git commit -m "add ValidationWarning and ValidationResult types"
```

---

### Task 2: Validate required fields

**Files:**
- Create: `src/schema/validator.ts`
- Create: `tests/schema/validator.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { validateNode } from '../../src/schema/validator.js';
import type { ParsedFile } from '../../src/parser/types.js';
import type { MergeResult } from '../../src/schema/types.js';

function makeParsed(fields: Array<{ key: string; value: unknown; valueType: string }>): ParsedFile {
  return {
    filePath: 'test.md',
    frontmatter: {},
    types: [],
    fields: fields as ParsedFile['fields'],
    wikiLinks: [],
    mdast: { type: 'root', children: [] },
    contentText: '',
    contentMd: '',
  };
}

function makeMerge(fields: Record<string, { type: string; required?: boolean; values?: string[]; target_schema?: string }>): MergeResult {
  const merged: MergeResult['fields'] = {};
  for (const [name, def] of Object.entries(fields)) {
    merged[name] = { ...def, sources: ['test'] } as any;
  }
  return { fields: merged, conflicts: [] };
}

describe('validateNode', () => {
  describe('required fields', () => {
    it('warns when a required field is missing', () => {
      const parsed = makeParsed([]);
      const merge = makeMerge({ status: { type: 'enum', required: true, values: ['todo', 'done'] } });

      const result = validateNode(parsed, merge);

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toEqual({
        field: 'status',
        rule: 'required',
        message: "Required field 'status' is missing",
      });
    });

    it('passes when a required field is present', () => {
      const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum', required: true, values: ['todo', 'done'] } });

      const result = validateNode(parsed, merge);

      expect(result.warnings.filter(w => w.rule === 'required')).toHaveLength(0);
    });

    it('skips non-required fields that are missing', () => {
      const parsed = makeParsed([]);
      const merge = makeMerge({ notes: { type: 'string' } });

      const result = validateNode(parsed, merge);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: FAIL — cannot resolve `../../src/schema/validator.js`

**Step 3: Write minimal implementation**

Create `src/schema/validator.ts`:

```typescript
import type { ParsedFile } from '../parser/types.js';
import type { MergeResult, ValidationResult, ValidationWarning } from './types.js';

export function validateNode(parsed: ParsedFile, mergeResult: MergeResult): ValidationResult {
  const warnings: ValidationWarning[] = [];
  const presentKeys = new Set(parsed.fields.map(f => f.key));

  // Check required fields
  for (const [name, field] of Object.entries(mergeResult.fields)) {
    if (field.required && !presentKeys.has(name)) {
      warnings.push({
        field: name,
        rule: 'required',
        message: `Required field '${name}' is missing`,
      });
    }
  }

  return { valid: warnings.length === 0, warnings };
}
```

**Step 4: Re-export from `src/schema/index.ts`**

Add: `export { validateNode } from './validator.js';`

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: PASS

**Step 6: Commit**

```
git add src/schema/validator.ts src/schema/index.ts tests/schema/validator.test.ts
git commit -m "add validateNode with required field checking"
```

---

### Task 3: Validate type compatibility

**Files:**
- Modify: `src/schema/validator.ts`
- Modify: `tests/schema/validator.test.ts`

**Step 1: Write the failing tests**

Add to `tests/schema/validator.test.ts` inside the `validateNode` describe block:

```typescript
describe('type compatibility', () => {
  it('warns on type mismatch (schema expects number, got string)', () => {
    const parsed = makeParsed([{ key: 'count', value: 'abc', valueType: 'string' }]);
    const merge = makeMerge({ count: { type: 'number' } });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      field: 'count',
      rule: 'type_mismatch',
    });
  });

  it('passes when types are compatible', () => {
    const parsed = makeParsed([{ key: 'count', value: 42, valueType: 'number' }]);
    const merge = makeMerge({ count: { type: 'number' } });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(true);
  });

  it('accepts string valueType for enum schema type', () => {
    const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
    const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
  });

  it('accepts reference valueType for reference schema type', () => {
    const parsed = makeParsed([{ key: 'assignee', value: '[[Alice]]', valueType: 'reference' }]);
    const merge = makeMerge({ assignee: { type: 'reference' } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
  });

  it('accepts list valueType for list<string> schema type', () => {
    const parsed = makeParsed([{ key: 'tags', value: ['a', 'b'], valueType: 'list' }]);
    const merge = makeMerge({ tags: { type: 'list<string>' } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
  });

  it('accepts list valueType for list<reference> schema type', () => {
    const parsed = makeParsed([{ key: 'attendees', value: ['[[Alice]]', '[[Bob]]'], valueType: 'list' }]);
    const merge = makeMerge({ attendees: { type: 'list<reference>' } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
  });

  it('skips fields not in schema (extra frontmatter fields are fine)', () => {
    const parsed = makeParsed([{ key: 'custom', value: 'whatever', valueType: 'string' }]);
    const merge = makeMerge({});

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(true);
  });
});
```

**Step 2: Run test to verify failures**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: FAIL — type mismatch test expects `type_mismatch` warning but none produced

**Step 3: Add type compatibility map and checking to `validateNode`**

Add this constant before the function in `src/schema/validator.ts`:

```typescript
const TYPE_COMPAT: Record<string, Set<string>> = {
  string: new Set(['string']),
  number: new Set(['number']),
  date: new Set(['date']),
  boolean: new Set(['boolean']),
  enum: new Set(['string']),
  reference: new Set(['reference']),
  'list<string>': new Set(['list']),
  'list<reference>': new Set(['list']),
};
```

Then in `validateNode`, after the required-fields loop, add a second loop over `parsed.fields`:

```typescript
// Check type compatibility
const fieldsByKey = new Map(parsed.fields.map(f => [f.key, f]));
for (const [name, schemaDef] of Object.entries(mergeResult.fields)) {
  const parsedField = fieldsByKey.get(name);
  if (!parsedField) continue;

  const allowed = TYPE_COMPAT[schemaDef.type];
  if (allowed && !allowed.has(parsedField.valueType)) {
    warnings.push({
      field: name,
      rule: 'type_mismatch',
      message: `Field '${name}' expected type '${schemaDef.type}' but got '${parsedField.valueType}'`,
    });
  }
}
```

**Step 4: Run test to verify all pass**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add src/schema/validator.ts tests/schema/validator.test.ts
git commit -m "add type compatibility checking to validateNode"
```

---

### Task 4: Validate enum values

**Files:**
- Modify: `src/schema/validator.ts`
- Modify: `tests/schema/validator.test.ts`

**Step 1: Write the failing tests**

Add inside the `validateNode` describe block:

```typescript
describe('enum validation', () => {
  it('warns when enum value is not in allowed values', () => {
    const parsed = makeParsed([{ key: 'status', value: 'invalid', valueType: 'string' }]);
    const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      field: 'status',
      rule: 'invalid_enum',
    });
  });

  it('passes when enum value is in allowed values', () => {
    const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
    const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(true);
  });

  it('skips enum check when schema has no values array', () => {
    const parsed = makeParsed([{ key: 'status', value: 'anything', valueType: 'string' }]);
    const merge = makeMerge({ status: { type: 'enum' } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'invalid_enum')).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: FAIL — first enum test expects `invalid_enum` warning

**Step 3: Add enum checking after type compatibility loop**

In `src/schema/validator.ts`, add after the type compatibility loop:

```typescript
// Check enum values
for (const [name, schemaDef] of Object.entries(mergeResult.fields)) {
  if (schemaDef.type !== 'enum' || !schemaDef.values) continue;
  const parsedField = fieldsByKey.get(name);
  if (!parsedField) continue;
  // Skip if already flagged as type mismatch
  if (parsedField.valueType !== 'string') continue;

  if (!schemaDef.values.includes(String(parsedField.value))) {
    warnings.push({
      field: name,
      rule: 'invalid_enum',
      message: `Field '${name}' has value '${parsedField.value}' which is not in [${schemaDef.values.join(', ')}]`,
    });
  }
}
```

**Step 4: Run test to verify all pass**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add src/schema/validator.ts tests/schema/validator.test.ts
git commit -m "add enum value validation to validateNode"
```

---

### Task 5: Validate reference syntax

**Files:**
- Modify: `src/schema/validator.ts`
- Modify: `tests/schema/validator.test.ts`

**Step 1: Write the failing tests**

Add inside the `validateNode` describe block:

```typescript
describe('reference validation', () => {
  it('warns when reference field lacks wiki-link syntax', () => {
    const parsed = makeParsed([{ key: 'assignee', value: 'Alice', valueType: 'string' }]);
    const merge = makeMerge({ assignee: { type: 'reference' } });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      field: 'assignee',
      rule: 'invalid_reference',
    });
  });

  it('passes when reference field has wiki-link syntax', () => {
    const parsed = makeParsed([{ key: 'assignee', value: '[[Alice]]', valueType: 'reference' }]);
    const merge = makeMerge({ assignee: { type: 'reference' } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'invalid_reference')).toHaveLength(0);
  });

  it('warns for list<reference> items without wiki-link syntax', () => {
    const parsed = makeParsed([{ key: 'attendees', value: ['[[Alice]]', 'Bob', '[[Carol]]'], valueType: 'list' }]);
    const merge = makeMerge({ attendees: { type: 'list<reference>' } });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      field: 'attendees',
      rule: 'invalid_reference',
      message: expect.stringContaining('Bob'),
    });
  });

  it('passes for list<reference> when all items are wiki-links', () => {
    const parsed = makeParsed([{ key: 'attendees', value: ['[[Alice]]', '[[Bob]]'], valueType: 'list' }]);
    const merge = makeMerge({ attendees: { type: 'list<reference>' } });

    const result = validateNode(parsed, merge);

    expect(result.warnings.filter(w => w.rule === 'invalid_reference')).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: FAIL — reference tests expect `invalid_reference` warnings

**Step 3: Add reference syntax checking**

In `src/schema/validator.ts`, add a regex constant near the top:

```typescript
const WIKI_LINK_RE = /^\[\[[^\]]+\]\]$/;
```

Then add after the enum check loop:

```typescript
// Check reference syntax
for (const [name, schemaDef] of Object.entries(mergeResult.fields)) {
  const parsedField = fieldsByKey.get(name);
  if (!parsedField) continue;

  if (schemaDef.type === 'reference') {
    if (typeof parsedField.value === 'string' && !WIKI_LINK_RE.test(parsedField.value)) {
      warnings.push({
        field: name,
        rule: 'invalid_reference',
        message: `Field '${name}' should be a wiki-link ([[target]]) but got '${parsedField.value}'`,
      });
    }
  } else if (schemaDef.type === 'list<reference>' && Array.isArray(parsedField.value)) {
    const invalid = parsedField.value.filter(
      (item): item is string => typeof item === 'string' && !WIKI_LINK_RE.test(item),
    );
    if (invalid.length > 0) {
      warnings.push({
        field: name,
        rule: 'invalid_reference',
        message: `Field '${name}' contains non-wiki-link values: ${invalid.join(', ')}`,
      });
    }
  }
}
```

**Step 4: Run test to verify all pass**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: PASS

**Step 5: Commit**

```
git add src/schema/validator.ts tests/schema/validator.test.ts
git commit -m "add reference syntax validation to validateNode"
```

---

### Task 6: Test multiple warnings accumulate

**Files:**
- Modify: `tests/schema/validator.test.ts`

**Step 1: Write the test**

Add inside the `validateNode` describe block:

```typescript
describe('multiple warnings', () => {
  it('accumulates warnings from different rules', () => {
    const parsed = makeParsed([
      { key: 'priority', value: 'invalid-enum', valueType: 'string' },
      { key: 'assignee', value: 'not-a-link', valueType: 'string' },
    ]);
    const merge = makeMerge({
      status: { type: 'enum', required: true, values: ['todo', 'done'] },
      priority: { type: 'enum', values: ['high', 'low'] },
      assignee: { type: 'reference' },
    });

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(3); // required + invalid_enum + invalid_reference
    const rules = result.warnings.map(w => w.rule).sort();
    expect(rules).toEqual(['invalid_enum', 'invalid_reference', 'required']);
  });

  it('returns valid with empty merge result', () => {
    const parsed = makeParsed([{ key: 'anything', value: 'whatever', valueType: 'string' }]);
    const merge: MergeResult = { fields: {}, conflicts: [] };

    const result = validateNode(parsed, merge);

    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/schema/validator.test.ts`
Expected: PASS (this should already work with existing implementation)

**Step 3: Commit**

```
git add tests/schema/validator.test.ts
git commit -m "add multi-warning and empty merge result tests"
```

---

### Task 7: Add `is_valid` column to nodes table

**Files:**
- Modify: `src/db/schema.ts`

**Step 1: Add the column**

In `src/db/schema.ts`, add `is_valid INTEGER,` after the `title` column in the `nodes` CREATE TABLE statement (before `created_at`).

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Run full test suite to check for regressions**

Run: `npm test`
Expected: PASS — existing tests don't query `is_valid` so they shouldn't break

**Step 4: Commit**

```
git add src/db/schema.ts
git commit -m "add is_valid column to nodes table"
```

---

### Task 8: Integrate validateNode into indexFile

**Files:**
- Modify: `src/sync/indexer.ts`
- Modify: `tests/sync/indexer.test.ts`

**Step 1: Write the failing tests**

Add a new describe block in `tests/sync/indexer.test.ts`:

```typescript
import { loadSchemas } from '../../src/schema/loader.js';

describe('indexFile validation (is_valid)', () => {
  let db: Database.Database;
  const fixtureSchemaDir = resolve(import.meta.dirname, '../fixtures');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    // Load schemas from test fixtures (task, person, meeting, work-task)
    loadSchemas(db, fixtureSchemaDir);
  });

  afterEach(() => {
    db.close();
  });

  it('sets is_valid = 1 when node passes validation', () => {
    // sample-task.md has status: todo, which matches task schema
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const parsed = parseFile('tasks/review.md', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT is_valid FROM nodes WHERE id = ?').get('tasks/review.md') as any;
    expect(node.is_valid).toBe(1);
  });

  it('sets is_valid = 0 when node has validation warnings', () => {
    // Task with invalid enum value for status
    const raw = '---\ntitle: Bad Task\ntypes: [task]\nstatus: nonexistent\n---\nBody.';
    const parsed = parseFile('tasks/bad.md', raw);
    indexFile(db, parsed, 'tasks/bad.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT is_valid FROM nodes WHERE id = ?').get('tasks/bad.md') as any;
    expect(node.is_valid).toBe(0);
  });

  it('sets is_valid = null when no schema exists for the types', () => {
    const raw = '---\ntitle: Unknown Type\ntypes: [recipe]\nservings: 4\n---\nBody.';
    const parsed = parseFile('recipes/pasta.md', raw);
    indexFile(db, parsed, 'recipes/pasta.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT is_valid FROM nodes WHERE id = ?').get('recipes/pasta.md') as any;
    expect(node.is_valid).toBeNull();
  });

  it('sets is_valid = null when node has no types', () => {
    const raw = '# Just a note\nNo frontmatter types.';
    const parsed = parseFile('notes/plain.md', raw);
    indexFile(db, parsed, 'notes/plain.md', '2025-03-10T00:00:00.000Z', raw);

    const node = db.prepare('SELECT is_valid FROM nodes WHERE id = ?').get('notes/plain.md') as any;
    expect(node.is_valid).toBeNull();
  });
});
```

**Step 2: Run test to verify failure**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — `is_valid` is always null because `indexFile` doesn't set it yet

**Step 3: Modify indexFile to call validateNode**

In `src/sync/indexer.ts`:

Add imports at the top:
```typescript
import { mergeSchemaFields } from '../schema/merger.js';
import { validateNode } from '../schema/validator.js';
```

After the `files` INSERT OR REPLACE statement (end of function), add:

```typescript
// Validate against schema if types exist
let isValid: number | null = null;
if (parsed.types.length > 0) {
  const merge = mergeSchemaFields(db, parsed.types);
  const hasKnownSchema = parsed.types.some(t => {
    const schema = db.prepare('SELECT 1 FROM schemas WHERE name = ?').get(t);
    return schema !== undefined;
  });

  if (hasKnownSchema) {
    const validation = validateNode(parsed, merge);
    isValid = validation.valid ? 1 : 0;
  }
}

db.prepare('UPDATE nodes SET is_valid = ? WHERE id = ?').run(isValid, relativePath);
```

**Step 4: Run test to verify all pass**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: PASS

**Step 5: Run full test suite to verify no regressions**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "integrate schema validation into indexFile"
```

---

### Task 9: Final verification

**Step 1: Type-check the full project**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing and new tests green

**Step 3: Review the diff**

Run: `git diff HEAD~8 --stat` (or however many commits were made)
Expected: changes in `src/schema/types.ts`, `src/schema/validator.ts`, `src/schema/index.ts`, `src/db/schema.ts`, `src/sync/indexer.ts`, `tests/schema/validator.test.ts`, `tests/sync/indexer.test.ts`
