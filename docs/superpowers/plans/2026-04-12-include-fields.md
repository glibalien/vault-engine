# `include_fields` for `query-nodes` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `include_fields` parameter to `query-nodes` so callers can retrieve field values inline with query results, eliminating the N+1 `get-node` pattern.

**Architecture:** Extract field value resolution from `get-node` into a shared helper. Add `include_fields` parameter to `query-nodes` that uses the helper to enrich result rows. No changes to query-builder.ts — this is response enrichment, not a filter change.

**Tech Stack:** TypeScript, better-sqlite3, Zod, Vitest

---

## File Structure

- **Create:** `src/mcp/field-value.ts` — shared field value resolution helper
- **Modify:** `src/mcp/tools/query-nodes.ts` — add `include_fields` parameter and enrichment logic
- **Modify:** `src/mcp/tools/get-node.ts` — refactor to use shared helper
- **Modify:** `tests/mcp/tools.test.ts` — add tests for `include_fields` behavior

---

### Task 1: Extract shared field value resolver

**Files:**
- Create: `src/mcp/field-value.ts`
- Modify: `src/mcp/tools/get-node.ts:29-36,95-115`
- Test: `tests/mcp/tools.test.ts` (existing get-node tests serve as regression)

- [ ] **Step 1: Write the failing test**

Add to `tests/mcp/tools.test.ts` at the top-level (not inside an existing describe block):

```typescript
import { resolveFieldValue } from '../../src/mcp/field-value.js';

describe('resolveFieldValue', () => {
  it('resolves value_json as parsed JSON', () => {
    const row = { field_name: 'tags', value_text: null, value_number: null, value_date: null, value_json: '["a","b"]', source: 'frontmatter' };
    expect(resolveFieldValue(row)).toEqual(['a', 'b']);
  });

  it('resolves value_number', () => {
    const row = { field_name: 'priority', value_text: null, value_number: 3, value_date: null, value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBe(3);
  });

  it('resolves value_date', () => {
    const row = { field_name: 'due', value_text: null, value_number: null, value_date: '2026-04-12', value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBe('2026-04-12');
  });

  it('resolves value_text as fallback', () => {
    const row = { field_name: 'status', value_text: 'open', value_number: null, value_date: null, value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBe('open');
  });

  it('resolves null when all value columns are null', () => {
    const row = { field_name: 'empty', value_text: null, value_number: null, value_date: null, value_json: null, source: 'frontmatter' };
    expect(resolveFieldValue(row)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools.test.ts -t "resolveFieldValue"`
Expected: FAIL — `resolveFieldValue` does not exist yet.

- [ ] **Step 3: Create the shared helper**

Create `src/mcp/field-value.ts`:

```typescript
export interface FieldRow {
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
  source: string;
}

export function resolveFieldValue(row: FieldRow): unknown {
  if (row.value_json !== null) return JSON.parse(row.value_json);
  if (row.value_number !== null) return row.value_number;
  if (row.value_date !== null) return row.value_date;
  return row.value_text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/tools.test.ts -t "resolveFieldValue"`
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Refactor get-node to use shared helper**

In `src/mcp/tools/get-node.ts`:

1. Remove the `FieldRow` interface (lines 29-36) — it's now in `field-value.ts`.
2. Add import: `import { resolveFieldValue, type FieldRow } from '../field-value.js';`
3. Replace lines 98-114 (the value resolution block inside the for loop) with:

```typescript
      for (const f of fieldRows) {
        const value = resolveFieldValue(f);
        const type = f.value_json !== null ? 'json'
          : f.value_number !== null ? 'number'
          : f.value_date !== null ? 'date'
          : 'text';
        fields[f.field_name] = { value, type, source: f.source };
      }
```

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass. The get-node behavior is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/field-value.ts src/mcp/tools/get-node.ts tests/mcp/tools.test.ts
git commit -m "refactor: extract resolveFieldValue into shared helper"
```

---

### Task 2: Add `include_fields` to `query-nodes`

**Files:**
- Modify: `src/mcp/tools/query-nodes.ts:8-27,64-76`
- Test: `tests/mcp/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('query-nodes', ...)` block in `tests/mcp/tools.test.ts`:

```typescript
  it('returns field values when include_fields is specified', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['meeting'], include_fields: ['project'] }) as any) as any;
    expect(result.total).toBe(1);
    expect(result.nodes[0].fields).toEqual({ project: 'Vault Engine' });
  });

  it('omits fields key when include_fields is not specified', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['meeting'] }) as any) as any;
    expect(result.nodes[0].fields).toBeUndefined();
  });

  it('returns empty fields object when requested field does not exist on node', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['task'], include_fields: ['project'] }) as any) as any;
    // n3 (task) has no project field
    expect(result.nodes[0].fields).toEqual({});
  });

  it('wildcard include_fields returns all fields', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['task'], include_fields: ['*'] }) as any) as any;
    // n3 has only 'priority' field with value 1
    expect(result.nodes[0].fields).toEqual({ priority: 1 });
  });

  it('include_fields resolves JSON values correctly', async () => {
    // Add a node with a JSON field for this test
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n_json', 'notes/json-test.md', 'JSON Test', '', 'hj', 5000, 5000);
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('n_json', 'note');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n_json', 'tags', null, null, null, '["design","spec"]', 'frontmatter');

    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ full_text: 'JSON Test', include_fields: ['tags'] }) as any) as any;
    expect(result.nodes[0].fields).toEqual({ tags: ['design', 'spec'] });
  });

  it('include_fields with multiple specific fields', async () => {
    // Add a second field to n1
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n1', 'status', 'active', null, null, null, 'frontmatter');

    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['meeting'], include_fields: ['project', 'status'] }) as any) as any;
    expect(result.nodes[0].fields).toEqual({ project: 'Vault Engine', status: 'active' });
  });

  it('field_count is unaffected by include_fields', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseResult(await handler({ types: ['meeting'], include_fields: ['project'] }) as any) as any;
    // n1 has 1 field (project). field_count should still be 1.
    expect(result.nodes[0].field_count).toBe(1);
    expect(result.nodes[0].fields).toEqual({ project: 'Vault Engine' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/tools.test.ts -t "include_fields"`
Expected: FAIL — `include_fields` parameter not recognized / `fields` not in response.

- [ ] **Step 3: Add include_fields parameter to paramsShape**

In `src/mcp/tools/query-nodes.ts`, add to `paramsShape` (after `offset`):

```typescript
  include_fields: z.array(z.string()).optional(),
```

- [ ] **Step 4: Add field enrichment logic**

In `src/mcp/tools/query-nodes.ts`, add the import at the top:

```typescript
import { resolveFieldValue, type FieldRow } from '../field-value.js';
```

Then, after the existing `getFieldCount` prepared statement (line 66), add the field fetching logic. Replace the `nodes` mapping block (lines 68-74) with:

```typescript
      const includeFields = params.include_fields;
      const isWildcard = includeFields?.length === 1 && includeFields[0] === '*';

      // Prepare field query if needed
      let getFields: ReturnType<typeof db.prepare> | undefined;
      if (includeFields && includeFields.length > 0) {
        if (isWildcard) {
          getFields = db.prepare(
            'SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?'
          );
        } else {
          const placeholders = includeFields.map(() => '?').join(', ');
          getFields = db.prepare(
            `SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ? AND field_name IN (${placeholders})`
          );
        }
      }

      const nodes = rows.map(row => {
        const node: Record<string, unknown> = {
          id: row.id,
          file_path: row.file_path,
          title: row.title,
          types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
          field_count: (getFieldCount.get(row.id) as { count: number }).count,
        };

        if (getFields) {
          const fieldArgs = isWildcard ? [row.id] : [row.id, ...includeFields!];
          const fieldRows = getFields.all(...fieldArgs) as FieldRow[];
          const fields: Record<string, unknown> = {};
          for (const f of fieldRows) {
            fields[f.field_name] = resolveFieldValue(f);
          }
          node.fields = fields;
        }

        return node;
      });
```

- [ ] **Step 5: Update tool description**

Change the tool description string (line 32) to:

```typescript
    'Query nodes with filtering by type, fields, full-text search, references, path, and date. Returns paginated results. Use include_fields to return field values inline (e.g. ["project","status"] or ["*"] for all).',
```

- [ ] **Step 6: Run include_fields tests to verify they pass**

Run: `npx vitest run tests/mcp/tools.test.ts -t "include_fields"`
Expected: PASS — all 7 new tests green.

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/query-nodes.ts tests/mcp/tools.test.ts
git commit -m "feat: add include_fields parameter to query-nodes"
```

---

### Task 3: Build, deploy, and verify end-to-end

**Files:**
- No new files

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 2: Run full test suite one more time**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit any remaining changes**

If the build produced updated dist files or anything else, commit them.

- [ ] **Step 4: Manual smoke test via MCP**

Restart the dev server and test the actual MCP tool:

```
query-nodes({
  types: ["task"],
  fields: { status: { eq: "open" } },
  include_fields: ["project"],
  limit: 200
})
```

Verify:
- Response includes `fields` on each node
- `fields` contains `project` with the correct value
- `field_count` is still present and correct
- Nodes without a `project` field have `fields: {}`

Then test wildcard:

```
query-nodes({
  types: ["task"],
  fields: { status: { eq: "open" } },
  include_fields: ["*"],
  limit: 5
})
```

Verify all fields are returned for each node.

Then test backwards compatibility — omit `include_fields`:

```
query-nodes({
  types: ["task"],
  limit: 1
})
```

Verify: No `fields` key in the response (old behavior preserved).
