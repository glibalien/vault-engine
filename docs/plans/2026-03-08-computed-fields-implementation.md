# Computed Fields Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evaluate computed field definitions (count and percentage aggregates) from schema YAML and surface results via the `get-node` MCP tool.

**Architecture:** Structured YAML computed definitions are already parsed and stored by the schema loader. This plan adds: (1) new types for the structured format, (2) an evaluation engine that translates definitions to SQL, (3) MCP integration via `include_computed` flag on `get-node`. Update the existing fixture schema and loader test to use the new structured format.

**Tech Stack:** TypeScript, better-sqlite3, vitest, @modelcontextprotocol/sdk

---

### Task 1: Update Types for Structured Computed Definitions

**Files:**
- Modify: `src/schema/types.ts:31,45` (replace `computed` type on `SchemaDefinition` and `ResolvedSchema`)

**Step 1: Update `SchemaDefinition.computed` and `ResolvedSchema.computed` types**

Replace the two `computed?: Record<string, { query: string }>` lines with the new structured types. Add them above the `SchemaDefinition` interface:

```typescript
// src/schema/types.ts — add before SchemaDefinition

export interface ComputedFilter {
  types_includes?: string;
  references_this?: string;
  // Any other key is a field equality condition.
  // At evaluation time, strip types_includes and references_this
  // before treating remaining keys as field conditions.
  [field: string]: string | undefined;
}

export interface CountDefinition {
  aggregate: 'count';
  filter: ComputedFilter;
}

export interface PercentageDefinition {
  aggregate: 'percentage';
  filter: ComputedFilter;
  numerator: Record<string, string>;
}

export type ComputedDefinition = CountDefinition | PercentageDefinition;
```

Then change both occurrences of:
```typescript
computed?: Record<string, { query: string }>;
```
to:
```typescript
computed?: Record<string, ComputedDefinition>;
```

**Step 2: Update `src/schema/index.ts` to re-export new types**

Add `ComputedFilter`, `ComputedDefinition`, `CountDefinition`, `PercentageDefinition` to the type export list.

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: May show errors in loader test that references `query` — that's expected and fixed in Task 2.

**Step 4: Commit**

```
feat: add structured computed field types
```

---

### Task 2: Update Fixture Schema and Loader Test

**Files:**
- Modify: `tests/fixtures/.schemas/meeting.yaml:20-22` (change computed format)
- Modify: `tests/schema/loader.test.ts:55-60` (update assertion)

**Step 1: Update meeting.yaml fixture**

Replace the computed section:

```yaml
computed:
  action_count:
    aggregate: count
    filter:
      types_includes: task
      references_this: source
```

**Step 2: Update loader test assertion**

In `tests/schema/loader.test.ts`, the test "stores computed fields in schema definition" (line 55) currently asserts:
```typescript
expect(meeting!.computed!.action_count.query).toContain('COUNT');
```

Replace with:
```typescript
expect(meeting!.computed!.action_count).toEqual({
  aggregate: 'count',
  filter: {
    types_includes: 'task',
    references_this: 'source',
  },
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/schema/loader.test.ts`
Expected: All tests PASS.

**Step 4: Run full type check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```
update meeting fixture and loader test for structured computed format
```

---

### Task 3: Implement `evaluateComputed` — Count Aggregate

**Files:**
- Create: `src/schema/computed.ts`
- Create: `tests/schema/computed.test.ts`
- Modify: `src/schema/index.ts` (add re-export)

**Step 1: Write failing tests for count aggregate**

Create `tests/schema/computed.test.ts`. The test needs:
- An in-memory DB with schema created
- A "meeting" node indexed
- Two "task" nodes that reference the meeting via `source` field (creating relationships with `rel_type: 'source'` and `resolved_target_id` pointing to the meeting)
- Call `evaluateComputed` with a count definition

```typescript
// tests/schema/computed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { evaluateComputed } from '../../src/schema/computed.js';
import type { ComputedDefinition } from '../../src/schema/types.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function indexFixture(db: Database.Database, fixture: string, relativePath: string) {
  const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
  const parsed = parseFile(relativePath, raw);
  indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
}

describe('evaluateComputed', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('count aggregate', () => {
    it('counts nodes matching types_includes and references_this', () => {
      // Index a meeting and two tasks that reference it via source
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      // sample-task.md has source: "[[Q1 Planning Meeting]]" which resolves to meetings/q1.md
      // sample-meeting.md also has types: [meeting, task] with source not set
      // So we expect 1 task node referencing q1 via source
      const defs: Record<string, ComputedDefinition> = {
        task_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'task',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.task_count).toEqual({ value: 1 });
    });

    it('returns zero when no nodes match', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        resolveReferences(db);
      })();

      const defs: Record<string, ComputedDefinition> = {
        task_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'project',
            references_this: 'source',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.task_count).toEqual({ value: 0 });
    });

    it('counts with field condition in filter', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      // sample-task.md has status: todo
      const defs: Record<string, ComputedDefinition> = {
        todo_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'task',
            references_this: 'source',
            status: 'todo',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.todo_count).toEqual({ value: 1 });
    });

    it('returns zero when field condition does not match', () => {
      db.transaction(() => {
        indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
        indexFixture(db, 'sample-task.md', 'tasks/review.md');
        resolveReferences(db);
      })();

      // sample-task.md has status: todo, not done
      const defs: Record<string, ComputedDefinition> = {
        done_count: {
          aggregate: 'count',
          filter: {
            types_includes: 'task',
            references_this: 'source',
            status: 'done',
          },
        },
      };

      const results = evaluateComputed(db, 'meetings/q1.md', defs);
      expect(results.done_count).toEqual({ value: 0 });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schema/computed.test.ts`
Expected: FAIL — `evaluateComputed` not found.

**Step 3: Implement `evaluateComputed` for count**

Create `src/schema/computed.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { ComputedDefinition, ComputedFilter } from './types.js';

export type ComputedResult =
  | { value: number }
  | { value: number; numerator: number; denominator: number };

// Known structural keys in ComputedFilter — everything else is a field condition.
const STRUCTURAL_KEYS = new Set(['types_includes', 'references_this']);

function buildCountQuery(
  filter: ComputedFilter,
  nodeId: string,
): { sql: string; params: unknown[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.types_includes) {
    joins.push('JOIN node_types nt ON nt.node_id = n.id');
    conditions.push('nt.schema_type = ?');
    params.push(filter.types_includes);
  }

  if (filter.references_this) {
    joins.push('JOIN relationships r ON r.source_id = n.id');
    conditions.push('r.rel_type = ?');
    conditions.push('r.resolved_target_id = ?');
    params.push(filter.references_this, nodeId);
  }

  // Field conditions: any key not in STRUCTURAL_KEYS
  let fieldIdx = 0;
  for (const [key, value] of Object.entries(filter)) {
    if (STRUCTURAL_KEYS.has(key) || value === undefined) continue;
    const alias = `ff${fieldIdx++}`;
    joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);
    conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
    params.push(key, value);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT COUNT(DISTINCT n.id) AS cnt FROM nodes n\n${joins.join('\n')}\n${where}`;

  return { sql, params };
}

export function evaluateComputed(
  db: Database.Database,
  nodeId: string,
  computedDefs: Record<string, ComputedDefinition>,
): Record<string, ComputedResult> {
  const results: Record<string, ComputedResult> = {};

  for (const [name, def] of Object.entries(computedDefs)) {
    if (def.aggregate === 'count') {
      const { sql, params } = buildCountQuery(def.filter, nodeId);
      const row = db.prepare(sql).get(...params) as { cnt: number };
      results[name] = { value: row.cnt };
    }
  }

  return results;
}
```

**Step 4: Add re-export to `src/schema/index.ts`**

Add:
```typescript
export { evaluateComputed } from './computed.js';
export type { ComputedResult } from './computed.js';
```

**Step 5: Run tests**

Run: `npx vitest run tests/schema/computed.test.ts`
Expected: All 4 count tests PASS.

**Step 6: Commit**

```
add evaluateComputed with count aggregate support
```

---

### Task 4: Add Percentage Aggregate

**Files:**
- Modify: `tests/schema/computed.test.ts` (add percentage tests)
- Modify: `src/schema/computed.ts` (add percentage evaluation)

**Step 1: Write failing tests for percentage aggregate**

Add a new `describe('percentage aggregate')` block in `tests/schema/computed.test.ts`:

```typescript
describe('percentage aggregate', () => {
  it('calculates percentage of matching nodes', () => {
    db.transaction(() => {
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      resolveReferences(db);
    })();

    // sample-task.md has status: todo, not done
    // 1 task references the meeting, 0 are done
    const defs: Record<string, ComputedDefinition> = {
      completion_pct: {
        aggregate: 'percentage',
        numerator: { status: 'done' },
        filter: {
          types_includes: 'task',
          references_this: 'source',
        },
      },
    };

    const results = evaluateComputed(db, 'meetings/q1.md', defs);
    expect(results.completion_pct).toEqual({
      value: 0,
      numerator: 0,
      denominator: 1,
    });
  });

  it('returns zero when denominator is zero', () => {
    db.transaction(() => {
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
      resolveReferences(db);
    })();

    const defs: Record<string, ComputedDefinition> = {
      completion_pct: {
        aggregate: 'percentage',
        numerator: { status: 'done' },
        filter: {
          types_includes: 'task',
          references_this: 'source',
        },
      },
    };

    const results = evaluateComputed(db, 'meetings/q1.md', defs);
    expect(results.completion_pct).toEqual({
      value: 0,
      numerator: 0,
      denominator: 0,
    });
  });

  it('calculates percentage with multiple numerator conditions', () => {
    db.transaction(() => {
      indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
      indexFixture(db, 'sample-task.md', 'tasks/review.md');
      resolveReferences(db);
    })();

    // sample-task.md has status: todo and priority: high
    const defs: Record<string, ComputedDefinition> = {
      high_todo_pct: {
        aggregate: 'percentage',
        numerator: { status: 'todo', priority: 'high' },
        filter: {
          types_includes: 'task',
          references_this: 'source',
        },
      },
    };

    const results = evaluateComputed(db, 'meetings/q1.md', defs);
    expect(results.high_todo_pct).toEqual({
      value: 100,
      numerator: 1,
      denominator: 1,
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schema/computed.test.ts`
Expected: FAIL — percentage aggregate not implemented (results empty or missing).

**Step 3: Implement percentage aggregate**

In `src/schema/computed.ts`, add a helper to build the numerator query, and update the `evaluateComputed` function. Add this inside the `for` loop, after the count branch:

```typescript
    } else if (def.aggregate === 'percentage') {
      // Denominator: count matching filter only
      const denomQ = buildCountQuery(def.filter, nodeId);
      const denomRow = db.prepare(denomQ.sql).get(...denomQ.params) as { cnt: number };
      const denominator = denomRow.cnt;

      // Numerator: count matching filter + numerator field conditions
      const numeratorFilter: ComputedFilter = { ...def.filter };
      for (const [key, value] of Object.entries(def.numerator)) {
        numeratorFilter[key] = value;
      }
      const numQ = buildCountQuery(numeratorFilter, nodeId);
      const numRow = db.prepare(numQ.sql).get(...numQ.params) as { cnt: number };
      const numerator = numRow.cnt;

      const value = denominator === 0 ? 0 : (numerator / denominator) * 100;
      results[name] = { value, numerator, denominator };
    }
```

**Step 4: Run tests**

Run: `npx vitest run tests/schema/computed.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```
add percentage aggregate to evaluateComputed
```

---

### Task 5: Add `include_computed` to `get-node` MCP Tool

**Files:**
- Modify: `src/mcp/server.ts:115-150` (add `include_computed` param and evaluation logic)
- Modify: `tests/mcp/server.test.ts` (add computed field tests)

**Step 1: Write failing tests**

Add to `tests/mcp/server.test.ts`, inside the `describe('get-node')` block:

```typescript
it('includes computed fields when include_computed is true', async () => {
  // Need schemas loaded for computed fields
  const { loadSchemas } = await import('../../src/schema/loader.js');
  const { resolveReferences } = await import('../../src/sync/resolver.js');

  loadSchemas(db, fixturesDir);

  db.transaction(() => {
    indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');
    indexFixture(db, 'sample-task.md', 'tasks/review.md');
    resolveReferences(db);
  })();

  const result = await client.callTool({
    name: 'get-node',
    arguments: { node_id: 'meetings/q1.md', include_computed: true },
  });

  expect(result.isError).toBeFalsy();
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.computed).toBeDefined();
  expect(data.computed.action_count).toEqual({ value: 1 });
});

it('does not include computed fields by default', async () => {
  indexFixture(db, 'sample-meeting.md', 'meetings/q1.md');

  const result = await client.callTool({
    name: 'get-node',
    arguments: { node_id: 'meetings/q1.md' },
  });

  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  expect(data.computed).toBeUndefined();
});

it('returns empty computed when node has no schemas with computed defs', async () => {
  const { loadSchemas } = await import('../../src/schema/loader.js');
  loadSchemas(db, fixturesDir);

  indexFixture(db, 'sample-person.md', 'people/alice.md');

  const result = await client.callTool({
    name: 'get-node',
    arguments: { node_id: 'people/alice.md', include_computed: true },
  });

  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  // person schema has no computed fields, so computed should be empty or absent
  expect(data.computed).toEqual({});
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — `include_computed` param not recognized, `computed` not in response.

**Step 3: Implement `include_computed` in `get-node`**

In `src/mcp/server.ts`:

1. Add import at top:
```typescript
import { evaluateComputed } from '../schema/computed.js';
import type { ComputedDefinition } from '../schema/types.js';
```

2. Add `include_computed` param to `get-node` tool definition (after `include_relationships`):
```typescript
include_computed: z.boolean().optional().default(false)
  .describe('Include computed field values from schema definitions'),
```

3. Update the destructured params:
```typescript
async ({ node_id, include_relationships, include_computed }) => {
```

4. After the `include_relationships` block (after line 146), add:
```typescript
if (include_computed) {
  // Collect computed definitions from all schemas matching node's types
  const nodeTypes = (node as Record<string, unknown>).types as string[];
  const allComputedDefs: Record<string, ComputedDefinition> = {};
  for (const typeName of nodeTypes) {
    const schema = getSchema(db, typeName);
    if (schema?.computed) {
      Object.assign(allComputedDefs, schema.computed);
    }
  }
  const computed = Object.keys(allComputedDefs).length > 0
    ? evaluateComputed(db, node_id, allComputedDefs)
    : {};
  (node as Record<string, unknown>).computed = computed;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: All tests PASS.

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

**Step 6: Commit**

```
add include_computed flag to get-node MCP tool
```

---

### Task 6: Final Verification and Cleanup

**Files:**
- Modify: `src/schema/index.ts` (verify all exports)
- Modify: `CLAUDE.md` (no change needed — architecture section already describes MCP tools generically)

**Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

**Step 3: Commit (if any cleanup was needed)**

```
phase 2 task 6 (computed fields) complete
```
