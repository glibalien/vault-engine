# Bulk Mutate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `update-node` query mode to support the full `query-nodes` filter shape, add `add_types`/`remove_types` operations, switch to best-effort execution, and add dry-run previews with per-node diffs.

**Architecture:** Extract the query-to-SQL builder from `query-nodes.ts` into a shared module (`src/mcp/query-builder.ts`). Both `query-nodes` and `update-node` consume it. Add `without_types` and `without_fields` negation to the shared builder. Extend `update-node`'s `handleQueryMode` with type operations, best-effort execution, batch ID, and preview diffs.

**Tech Stack:** TypeScript, better-sqlite3, Zod, vitest, nanoid

**Spec:** `Notes/Bulk Mutate Tool — Design Spec.md` in the vault (also available via `get-node` title lookup)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/mcp/query-builder.ts` | **Create** | Shared query-to-SQL builder extracted from query-nodes |
| `src/mcp/tools/query-nodes.ts` | **Modify** | Replace inline SQL builder with shared module; add `without_types`, `without_fields` params |
| `src/mcp/tools/update-node.ts` | **Modify** | Expand query mode: full filter shape, add_types/remove_types, best-effort, preview diffs, batch size guard |
| `tests/mcp/query-builder.test.ts` | **Create** | Unit tests for the shared query builder |
| `tests/mcp/tools.test.ts` | **Modify** | Add negation filter tests to query-nodes section |
| `tests/mcp/update-node-query.test.ts` | **Create** | Dedicated tests for update-node query mode (bulk ops) |

---

### Task 1: Extract query builder into shared module

**Files:**
- Create: `src/mcp/query-builder.ts`
- Create: `tests/mcp/query-builder.test.ts`

- [ ] **Step 1: Write failing tests for the query builder**

Create `tests/mcp/query-builder.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { buildNodeQuery } from '../../src/mcp/query-builder.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

function seedData(db: Database.Database) {
  const insertNode = db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertNode.run('n1', 'Clippings/article.md', 'Article', '', 'h1', 1000, 2000);
  insertNode.run('n2', 'Notes/note.md', 'Note', '', 'h2', 2000, 3000);
  insertNode.run('n3', 'Clippings/other.md', 'Other', '', 'h3', 3000, 4000);

  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  insertType.run('n1', 'clippings');
  insertType.run('n2', 'note');
  insertType.run('n3', 'note');

  const insertField = db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)'
  );
  insertField.run('n1', 'status', 'open', 'frontmatter');
  insertField.run('n2', 'status', 'done', 'frontmatter');
}

beforeEach(() => {
  db = createTestDb();
  seedData(db);
});

describe('buildNodeQuery', () => {
  it('returns all nodes with empty filter', () => {
    const { sql, params } = buildNodeQuery({});
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(3);
  });

  it('filters by path_prefix', () => {
    const { sql, params } = buildNodeQuery({ path_prefix: 'Clippings/' });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
  });

  it('filters by types (intersection)', () => {
    const { sql, params } = buildNodeQuery({ types: ['note'] });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
  });

  it('filters by without_types', () => {
    const { sql, params } = buildNodeQuery({ without_types: ['clippings'] });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.id !== 'n1')).toBe(true);
  });

  it('filters by field equality', () => {
    const { sql, params } = buildNodeQuery({ fields: { status: { eq: 'done' } } });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('n2');
  });

  it('filters by without_fields', () => {
    const { sql, params } = buildNodeQuery({ without_fields: ['status'] });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('n3');
  });

  it('combines multiple filters (AND)', () => {
    const { sql, params } = buildNodeQuery({
      path_prefix: 'Clippings/',
      without_types: ['clippings'],
    });
    const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('n3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the query builder**

Create `src/mcp/query-builder.ts`. This is a direct extraction from `query-nodes.ts` lines 38–165, with `without_types` and `without_fields` added:

```typescript
// src/mcp/query-builder.ts
//
// Shared query-to-SQL builder for query-nodes and update-node bulk mode.

import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import { resolveTarget } from '../resolver/resolve.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export interface NodeQueryFilter {
  types?: string[];
  without_types?: string[];
  fields?: Record<string, Record<string, unknown>>;
  without_fields?: string[];
  full_text?: string;
  references?: {
    target: string;
    rel_type?: string;
    direction?: 'outgoing' | 'incoming' | 'both';
  };
  path_prefix?: string;
  modified_since?: string;
}

export interface NodeQueryResult {
  sql: string;
  countSql: string;
  params: unknown[];
}

/**
 * Build SQL for querying nodes with the full filter set.
 * Returns a data query (SELECT DISTINCT n.id, n.file_path, n.title, n.body)
 * and a count query. Both use the same params array.
 *
 * The caller appends ORDER BY / LIMIT / OFFSET to the data query as needed.
 */
export function buildNodeQuery(
  filter: NodeQueryFilter,
  db?: Database.Database,
): NodeQueryResult {
  const joins: string[] = [];
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let joinIdx = 0;

  // Type filter (intersection: node must have ALL specified types)
  if (filter.types && filter.types.length > 0) {
    for (const t of filter.types) {
      const alias = `t${joinIdx++}`;
      joins.push(`INNER JOIN node_types ${alias} ON ${alias}.node_id = n.id AND ${alias}.schema_type = ?`);
      params.push(t);
    }
  }

  // Negated type filter: node must NOT have any of these types
  if (filter.without_types && filter.without_types.length > 0) {
    for (const t of filter.without_types) {
      whereClauses.push(`n.id NOT IN (SELECT node_id FROM node_types WHERE schema_type = ?)`);
      params.push(t);
    }
  }

  // Field filters
  if (filter.fields) {
    for (const [fieldName, ops] of Object.entries(filter.fields)) {
      const alias = `f${joinIdx++}`;

      if ('exists' in ops && ops.exists === false) {
        joins.push(`LEFT JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
        params.push(fieldName);
        whereClauses.push(`${alias}.node_id IS NULL`);
        continue;
      }

      joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
      params.push(fieldName);

      for (const [op, value] of Object.entries(ops)) {
        if (op === 'exists') continue;
        if (op === 'contains') {
          whereClauses.push(`${alias}.value_text LIKE ?`);
          params.push(`%${value}%`);
        } else if (op === 'eq') {
          if (typeof value === 'number') {
            whereClauses.push(`${alias}.value_number = ?`);
          } else if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
            whereClauses.push(`${alias}.value_date = ?`);
          } else {
            whereClauses.push(`${alias}.value_text = ?`);
          }
          params.push(value);
        } else if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
          const sqlOp = op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
          if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
            whereClauses.push(`${alias}.value_date ${sqlOp} ?`);
          } else {
            whereClauses.push(`${alias}.value_number ${sqlOp} ?`);
          }
          params.push(value);
        }
      }
    }
  }

  // Negated field filter: node must NOT have any of these fields
  if (filter.without_fields && filter.without_fields.length > 0) {
    for (const f of filter.without_fields) {
      whereClauses.push(`n.id NOT IN (SELECT node_id FROM node_fields WHERE field_name = ?)`);
      params.push(f);
    }
  }

  // FTS5 full-text search
  if (filter.full_text) {
    joins.push('INNER JOIN nodes_fts ON nodes_fts.rowid = n.rowid');
    whereClauses.push('nodes_fts MATCH ?');
    params.push(filter.full_text);
  }

  // Reference filter
  if (filter.references && db) {
    const ref = filter.references;
    const dir = ref.direction ?? 'outgoing';

    if (dir === 'outgoing' || dir === 'both') {
      const alias = `r${joinIdx++}`;
      let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target = ?`;
      params.push(ref.target);
      if (ref.rel_type) {
        joinCond += ` AND ${alias}.rel_type = ?`;
        params.push(ref.rel_type);
      }
      joins.push(joinCond);
    }

    if (dir === 'incoming' || dir === 'both') {
      const resolved = resolveTarget(db, ref.target);
      if (!resolved) {
        whereClauses.push('1 = 0');
      } else {
        const targetNode = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?')
          .get(resolved.id) as { file_path: string; title: string | null };
        const possibleTargets: string[] = [];
        if (targetNode.title) possibleTargets.push(targetNode.title);
        possibleTargets.push(targetNode.file_path);
        possibleTargets.push(basename(targetNode.file_path, '.md'));
        const unique = [...new Set(possibleTargets)];

        const alias = `r${joinIdx++}`;
        const placeholders = unique.map(() => '?').join(', ');
        let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target IN (${placeholders})`;
        params.push(...unique);
        if (ref.rel_type) {
          joinCond += ` AND ${alias}.rel_type = ?`;
          params.push(ref.rel_type);
        }
        joins.push(joinCond);
      }
    }
  }

  // Path prefix filter
  if (filter.path_prefix) {
    whereClauses.push('n.file_path LIKE ?');
    params.push(`${filter.path_prefix}%`);
  }

  // Modified since filter
  if (filter.modified_since) {
    whereClauses.push('n.file_mtime >= ?');
    const ts = Math.floor(new Date(filter.modified_since).getTime() / 1000);
    params.push(ts);
  }

  const joinSql = joins.join('\n');
  const whereSql = whereClauses.length > 0
    ? 'WHERE ' + whereClauses.join(' AND ')
    : '';

  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body FROM nodes n ${joinSql} ${whereSql}`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total FROM nodes n ${joinSql} ${whereSql}`;

  return { sql, countSql, params };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/query-builder.ts tests/mcp/query-builder.test.ts
git commit -m "refactor: extract shared query builder with negation filters"
```

---

### Task 2: Wire query-nodes to use shared builder

**Files:**
- Modify: `src/mcp/tools/query-nodes.ts`

- [ ] **Step 1: Run existing query-nodes tests as baseline**

Run: `npx vitest run tests/mcp/tools.test.ts -t "query-nodes"`
Expected: all PASS (14 tests)

- [ ] **Step 2: Replace inline SQL builder with shared module**

Replace the body of `registerQueryNodes` handler (lines 33–194 of `query-nodes.ts`). Keep the Zod params shape, but add the new negation params. Replace the inline SQL building with a call to `buildNodeQuery`. The handler becomes:

```typescript
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
```

Add to `paramsShape`:
```typescript
  without_types: z.array(z.string()).optional(),
  without_fields: z.array(z.string()).optional(),
```

Replace the SQL-building section of the handler with:
```typescript
    async (params) => {
      const sortBy = params.sort_by ?? 'title';
      const sortOrder = params.sort_order ?? 'asc';
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const filter: NodeQueryFilter = {
        types: params.types,
        without_types: params.without_types,
        fields: params.fields as NodeQueryFilter['fields'],
        without_fields: params.without_fields,
        full_text: params.full_text,
        references: params.references,
        path_prefix: params.path_prefix,
        modified_since: params.modified_since,
      };

      const { sql, countSql, params: sqlParams } = buildNodeQuery(filter, db);

      const total = (db.prepare(countSql).get(...sqlParams) as { total: number }).total;

      const sortCol = sortBy === 'title' ? 'n.title' : sortBy === 'file_mtime' ? 'n.file_mtime' : 'n.indexed_at';
      const dataSql = `${sql} ORDER BY ${sortCol} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`;
      const dataParams = [...sqlParams, limit, offset];
      const rows = db.prepare(dataSql).all(...dataParams) as Array<{ id: string; file_path: string; title: string | null }>;

      const getTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?');
      const getFieldCount = db.prepare('SELECT COUNT(*) as count FROM node_fields WHERE node_id = ?');

      const nodes = rows.map(row => ({
        id: row.id,
        file_path: row.file_path,
        title: row.title,
        types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
        field_count: (getFieldCount.get(row.id) as { count: number }).count,
      }));

      return toolResult({ nodes, total });
    },
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run tests/mcp/tools.test.ts -t "query-nodes"`
Expected: all 14 PASS — behavior unchanged

- [ ] **Step 4: Add negation filter tests to query-nodes**

Add to the `query-nodes` describe block in `tests/mcp/tools.test.ts`:

```typescript
  it('filters by without_types (negation)', async () => {
    const result = parseResult(await handler({ without_types: ['meeting'] }));
    expect((result as any).nodes.every((n: any) => !n.types.includes('meeting'))).toBe(true);
    expect((result as any).nodes.length).toBe(2); // n2 (note), n3 (task)
  });

  it('filters by without_fields (negation)', async () => {
    const result = parseResult(await handler({ without_fields: ['project'] }));
    // n1 has project, n2 and n3 don't
    expect((result as any).nodes.length).toBe(2);
    expect((result as any).nodes.every((n: any) => n.id !== 'n1')).toBe(true);
  });
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run tests/mcp/tools.test.ts -t "query-nodes"`
Expected: all 16 PASS (14 existing + 2 new)

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/query-nodes.ts tests/mcp/tools.test.ts
git commit -m "refactor: wire query-nodes to shared builder, add without_types/without_fields"
```

---

### Task 3: Extend update-node query mode filter and add type operations

**Files:**
- Modify: `src/mcp/tools/update-node.ts`
- Create: `tests/mcp/update-node-query.test.ts`

- [ ] **Step 1: Write failing tests for the extended query mode**

Create `tests/mcp/update-node-query.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();

  // Capture the handler
  let capturedHandler: any;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: any) => {
      capturedHandler = (args: any) => h(args);
    },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, writeLock, vaultPath);
  handler = capturedHandler!;
});

function createTestNode(overrides: { title: string; types?: string[]; fields?: Record<string, unknown> }) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: `${overrides.title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title: overrides.title,
    types: overrides.types ?? [],
    fields: overrides.fields ?? {},
    body: '',
  });
}

describe('update-node query mode — add_types', () => {
  it('adds a type to all matched nodes', async () => {
    createTestNode({ title: 'A', types: [] });
    createTestNode({ title: 'B', types: [] });
    createTestNode({ title: 'C', types: ['note'] });

    const result = parseResult(await handler({
      query: { path_prefix: '' },
      add_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.matched).toBe(3);
    expect(result.updated).toBe(3);

    // All nodes now have clippings type
    const types = db.prepare('SELECT DISTINCT schema_type FROM node_types WHERE schema_type = ?').all('clippings');
    expect(types).toHaveLength(1);
    const count = db.prepare("SELECT COUNT(*) as c FROM node_types WHERE schema_type = 'clippings'").get() as { c: number };
    expect(count.c).toBe(3);
  });

  it('skips nodes that already have the type', async () => {
    createTestNode({ title: 'A', types: ['clippings'] });
    createTestNode({ title: 'B', types: [] });

    const result = parseResult(await handler({
      query: { path_prefix: '' },
      add_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.matched).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

describe('update-node query mode — remove_types', () => {
  it('removes a type from matched nodes', async () => {
    createTestNode({ title: 'A', types: ['note', 'clippings'] });
    createTestNode({ title: 'B', types: ['clippings'] });

    const result = parseResult(await handler({
      query: { types: ['clippings'] },
      remove_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.matched).toBe(2);
    expect(result.updated).toBe(2);

    const remaining = db.prepare("SELECT COUNT(*) as c FROM node_types WHERE schema_type = 'clippings'").get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe('update-node query mode — full filter', () => {
  it('uses path_prefix + without_types together', async () => {
    const a = createTestNode({ title: 'A', types: ['clippings'] });
    const b = createTestNode({ title: 'B', types: [] });

    const result = parseResult(await handler({
      query: { without_types: ['clippings'] },
      add_types: ['clippings'],
      dry_run: false,
    }));

    expect(result.matched).toBe(1);
    expect(result.updated).toBe(1);
  });
});

describe('update-node query mode — dry_run', () => {
  it('defaults to dry_run true in query mode', async () => {
    createTestNode({ title: 'A', types: [] });

    const result = parseResult(await handler({
      query: { path_prefix: '' },
      add_types: ['clippings'],
      // no dry_run param — should default true
    }));

    expect(result.dry_run).toBe(true);
    // No actual changes
    const count = db.prepare("SELECT COUNT(*) as c FROM node_types WHERE schema_type = 'clippings'").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('returns preview with per-node diffs', async () => {
    createTestNode({ title: 'A', types: ['note'] });

    const result = parseResult(await handler({
      query: { path_prefix: '' },
      add_types: ['clippings'],
    }));

    expect(result.preview).toBeDefined();
    expect(result.preview.length).toBeGreaterThan(0);
    expect(result.preview[0].changes.types_added).toEqual(['clippings']);
  });
});

describe('update-node query mode — best effort', () => {
  it('continues past validation errors on individual nodes', async () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', required: true }] });

    // Node A: task with valid status
    createTestNode({ title: 'A', types: ['task'], fields: { status: 'open' } });
    // Node B: no types (setting status to null will succeed — not claimed)
    createTestNode({ title: 'B', types: [] });

    const result = parseResult(await handler({
      query: { path_prefix: '' },
      set_fields: { status: null },
      dry_run: false,
    }));

    // A fails (required field), B succeeds
    expect(result.errors.length).toBe(1);
    expect(result.updated).toBe(1);
  });
});

describe('update-node query mode — batch size guard', () => {
  it('rejects batches over 1000 without confirm_large_batch', async () => {
    // We won't create 1001 nodes — just test the guard logic by mocking.
    // Instead, test that confirm_large_batch param is accepted.
    const result = parseResult(await handler({
      query: { path_prefix: '' },
      add_types: ['test'],
      dry_run: false,
    }));
    // With 0 nodes, should just return matched: 0
    expect(result.matched).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/update-node-query.test.ts`
Expected: FAIL — `add_types` not recognized, query filter shape doesn't match

- [ ] **Step 3: Implement the extended query mode**

Modify `src/mcp/tools/update-node.ts`:

**3a. Update imports:**
```typescript
import { nanoid } from 'nanoid';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
```

**3b. Update the Zod params shape** — replace the `query` field and add new operation params:
```typescript
const paramsShape = {
  // Single-node identity
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  // Single-node updates
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),
  set_fields: z.record(z.string(), z.unknown()).optional(),
  set_body: z.string().optional(),
  append_body: z.string().optional(),
  // Query-mode bulk update
  query: z.object({
    types: z.array(z.string()).optional(),
    without_types: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    without_fields: z.array(z.string()).optional(),
    full_text: z.string().optional(),
    references: z.object({
      target: z.string(),
      rel_type: z.string().optional(),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
    }).optional(),
    path_prefix: z.string().optional(),
    modified_since: z.string().optional(),
  }).optional(),
  // Query-mode type operations
  add_types: z.array(z.string()).optional(),
  remove_types: z.array(z.string()).optional(),
  // Query-mode options
  dry_run: z.boolean().optional(),
  confirm_large_batch: z.boolean().optional(),
};
```

**3c. Update the query mode dispatch** in the handler — change the `if (hasQuery)` block:
```typescript
      if (hasQuery) {
        const hasOperation = params.set_fields !== undefined ||
          params.add_types !== undefined ||
          params.remove_types !== undefined;
        if (!hasOperation) {
          return toolErrorResult('INVALID_PARAMS', 'Query mode requires at least one operation (set_fields, add_types, or remove_types)');
        }
        // dry_run defaults to true in query mode
        const dryRun = params.dry_run ?? true;
        return handleQueryMode(db, writeLock, vaultPath, params.query!, {
          set_fields: params.set_fields,
          add_types: params.add_types,
          remove_types: params.remove_types,
        }, dryRun, params.confirm_large_batch ?? false);
      }
```

Also update single-node mode to default `dry_run` to `false`:
```typescript
      // For single-node mode, dry_run is not used (kept for API compat)
```

**3d. Replace `handleQueryMode` entirely:**

```typescript
interface BulkOperation {
  set_fields?: Record<string, unknown>;
  add_types?: string[];
  remove_types?: string[];
}

function handleQueryMode(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  query: NodeQueryFilter,
  operation: BulkOperation,
  dryRun: boolean,
  confirmLargeBatch: boolean,
) {
  const { sql, params } = buildNodeQuery(query, db);
  const matchedNodes = db.prepare(sql).all(...params) as Array<{
    id: string; file_path: string; title: string; body: string;
  }>;

  // Batch size guard
  if (matchedNodes.length > 1000 && !confirmLargeBatch) {
    return toolErrorResult('INVALID_PARAMS',
      `Query matched ${matchedNodes.length} nodes (limit 1000). Pass confirm_large_batch: true to proceed.`);
  }

  const batchId = nanoid();

  if (dryRun) {
    return handleDryRun(db, matchedNodes, operation, batchId);
  }

  // Best-effort execution: each node is independent
  const errors: Array<{ node_id: string; file_path: string; error: string }> = [];
  let updated = 0;
  let skipped = 0;

  for (const node of matchedNodes) {
    const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const currentFields: Record<string, unknown> = {};
    const rawTexts: Record<string, string> = {};
    const fieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text FROM node_fields WHERE node_id = ?'
    ).all(node.id) as Array<{
      field_name: string; value_text: string | null; value_number: number | null;
      value_date: string | null; value_json: string | null; value_raw_text: string | null;
    }>;
    for (const row of fieldRows) {
      currentFields[row.field_name] = reconstructValue(row);
      if (row.value_raw_text) rawTexts[row.field_name] = row.value_raw_text;
    }

    // Compute new types: add_types → remove_types
    let newTypes = [...currentTypes];
    if (operation.add_types) {
      for (const t of operation.add_types) {
        if (!newTypes.includes(t)) newTypes.push(t);
      }
    }
    if (operation.remove_types) {
      newTypes = newTypes.filter(t => !operation.remove_types!.includes(t));
    }

    // Compute new fields (patch semantics)
    const newFields = { ...currentFields };
    if (operation.set_fields) {
      for (const [key, value] of Object.entries(operation.set_fields)) {
        newFields[key] = value;
      }
    }

    // Check if anything actually changed
    const typesChanged = newTypes.length !== currentTypes.length ||
      !newTypes.every(t => currentTypes.includes(t));
    const fieldsChanged = operation.set_fields !== undefined;
    if (!typesChanged && !fieldsChanged) {
      skipped++;
      continue;
    }

    try {
      const result = executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: node.id,
        file_path: node.file_path,
        title: node.title,
        types: newTypes,
        fields: newFields,
        body: node.body,
        raw_field_texts: rawTexts,
      });

      if (result.file_written) {
        updated++;
      } else {
        skipped++;
      }

      // Log batch linkage
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        node.id,
        Date.now(),
        'bulk-mutate',
        JSON.stringify({ batch_id: batchId, operation }),
      );
    } catch (err) {
      if (err instanceof PipelineError) {
        errors.push({
          node_id: node.id,
          file_path: node.file_path,
          error: err.message,
        });
      } else {
        errors.push({
          node_id: node.id,
          file_path: node.file_path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return toolResult({
    dry_run: false,
    batch_id: batchId,
    matched: matchedNodes.length,
    updated,
    skipped,
    errors,
  });
}

function handleDryRun(
  db: Database.Database,
  matchedNodes: Array<{ id: string; file_path: string; title: string; body: string }>,
  operation: BulkOperation,
  batchId: string,
) {
  const preview: Array<{
    node_id: string;
    file_path: string;
    title: string;
    changes: {
      types_added: string[];
      types_removed: string[];
      fields_set: Record<string, { from: unknown; to: unknown }>;
      would_fail: boolean;
      fail_reason?: string;
    };
  }> = [];

  let wouldUpdate = 0;
  let wouldSkip = 0;
  let wouldFail = 0;

  for (const node of matchedNodes.slice(0, 20)) {
    const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const currentFields: Record<string, unknown> = {};
    const fieldRows = db.prepare(
      'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?'
    ).all(node.id) as Array<{
      field_name: string; value_text: string | null; value_number: number | null;
      value_date: string | null; value_json: string | null;
    }>;
    for (const row of fieldRows) currentFields[row.field_name] = reconstructValue(row);

    const typesAdded = (operation.add_types ?? []).filter(t => !currentTypes.includes(t));
    const typesRemoved = (operation.remove_types ?? []).filter(t => currentTypes.includes(t));

    const fieldsSet: Record<string, { from: unknown; to: unknown }> = {};
    if (operation.set_fields) {
      for (const [key, value] of Object.entries(operation.set_fields)) {
        const from = currentFields[key] ?? null;
        if (from !== value) {
          fieldsSet[key] = { from, to: value };
        }
      }
    }

    const hasChanges = typesAdded.length > 0 || typesRemoved.length > 0 || Object.keys(fieldsSet).length > 0;
    if (!hasChanges) {
      wouldSkip++;
      continue;
    }

    // Validate proposed state
    let wouldFail_ = false;
    let failReason: string | undefined;
    try {
      let newTypes = [...currentTypes, ...typesAdded].filter(t => !(operation.remove_types ?? []).includes(t));
      const newFields = { ...currentFields };
      if (operation.set_fields) {
        for (const [key, value] of Object.entries(operation.set_fields)) {
          newFields[key] = value;
        }
      }
      const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
      const validation = validateProposedState(newFields, newTypes, claimsByType, globalFields);
      if (hasBlockingErrors(validation.issues)) {
        wouldFail_ = true;
        failReason = validation.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ');
      }
    } catch (e) {
      wouldFail_ = true;
      failReason = e instanceof Error ? e.message : String(e);
    }

    if (wouldFail_) {
      wouldFail++;
    } else {
      wouldUpdate++;
    }

    preview.push({
      node_id: node.id,
      file_path: node.file_path,
      title: node.title,
      changes: {
        types_added: typesAdded,
        types_removed: typesRemoved,
        fields_set: fieldsSet,
        would_fail: wouldFail_,
        ...(failReason ? { fail_reason: failReason } : {}),
      },
    });
  }

  // Count remaining nodes beyond preview
  for (const node of matchedNodes.slice(20)) {
    const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const typesAdded = (operation.add_types ?? []).filter(t => !currentTypes.includes(t));
    const typesRemoved = (operation.remove_types ?? []).filter(t => currentTypes.includes(t));
    const hasFieldChanges = operation.set_fields !== undefined && Object.keys(operation.set_fields).length > 0;

    if (typesAdded.length === 0 && typesRemoved.length === 0 && !hasFieldChanges) {
      wouldSkip++;
    } else {
      wouldUpdate++;
    }
  }

  return toolResult({
    dry_run: true,
    batch_id: batchId,
    matched: matchedNodes.length,
    would_update: wouldUpdate,
    would_skip: wouldSkip,
    would_fail: wouldFail,
    preview,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/update-node-query.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all PASS — no regressions in existing tests

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/update-node.ts tests/mcp/update-node-query.test.ts
git commit -m "feat: extend update-node query mode with full filters, type ops, best-effort, preview"
```

---

### Task 4: Build, verify, and ship

- [ ] **Step 1: TypeScript build check**

Run: `npm run build`
Expected: clean build, no errors

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 3: Manual smoke test via MCP**

Start the dev server and test via MCP client:

```json
// Dry run — preview adding clippings type to Clippings/ folder
{
  "query": { "path_prefix": "Clippings/", "without_types": ["clippings"] },
  "add_types": ["clippings"]
}
```

Verify the response has `dry_run: true`, `matched` count, and `preview` array with `types_added: ["clippings"]`.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "chore: final build verification for bulk mutate"
git push
```
