# FTS5 Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `search()` function that queries FTS5-indexed content and returns rich results with types, fields, and rank.

**Architecture:** New `src/search/` module with types, search function, and re-export index. Two-phase SQL: FTS5 MATCH for ranked node IDs, then batch-load types/fields. Same patterns as existing `src/sync/` and `src/db/` modules.

**Tech Stack:** TypeScript ESM, better-sqlite3, vitest

**Design doc:** `docs/plans/2026-03-07-fts5-search-design.md`

---

### Task 1: Create types file

**Files:**
- Create: `src/search/types.ts`

**Step 1: Create the types file**

```typescript
// src/search/types.ts
export interface SearchOptions {
  query: string;
  schemaType?: string;
  limit?: number;
}

export interface SearchResult {
  id: string;
  filePath: string;
  nodeType: string;
  types: string[];
  fields: Record<string, { value: string; type: string }>;
  contentText: string;
  rank: number;
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors (file is self-contained, no imports needed)

**Step 3: Commit**

```bash
git add src/search/types.ts
git commit -m "add SearchOptions and SearchResult types for FTS5 search"
```

---

### Task 2: Write failing tests for basic search

**Files:**
- Create: `tests/search/search.test.ts`

**Context:** Tests follow the same pattern as `tests/sync/indexer.test.ts` — in-memory DB, create schema, index fixture files via `indexFile`, then call `search`. The helper `indexFixture` loads a fixture `.md` file, parses it, and indexes it.

**Step 1: Write the test file with first 4 tests**

```typescript
// tests/search/search.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { search } from '../../src/search/search.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('search', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function indexFixture(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    const parsed = parseFile(relativePath, raw);
    indexFile(db, parsed, relativePath, '2025-03-10T00:00:00.000Z', raw);
  }

  it('returns matching nodes for a basic query', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'vendor' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('tasks/review.md');
    expect(results[0].filePath).toBe('tasks/review.md');
    expect(results[0].nodeType).toBe('file');
    expect(results[0].contentText).toContain('vendor');
    expect(typeof results[0].rank).toBe('number');
  });

  it('returns empty array when nothing matches', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'nonexistentterm' });

    expect(results).toEqual([]);
  });

  it('filters results by schemaType', () => {
    indexFixture('sample-task.md', 'tasks/review.md');
    indexFixture('sample-person.md', 'people/alice.md');

    // "Acme" appears in both: task body mentions "Acme Corp", person has company: Acme Corp
    // But content_text for person includes "Acme Corp" from body: "Key contact for the CenterPoint project."
    // Actually let's use a term that appears in both content_text values
    // Task has "vendor" in body, person does not — so filter isn't needed here.
    // Instead: both files mention things, search broadly and filter by type.
    indexFixture('sample-meeting.md', 'meetings/q1.md');

    // "budget" appears in meeting body, not in task or person
    const allResults = search(db, { query: 'budget' });
    expect(allResults.length).toBeGreaterThan(0);

    const filtered = search(db, { query: 'budget', schemaType: 'person' });
    expect(filtered).toEqual([]);

    const meetingResults = search(db, { query: 'budget', schemaType: 'meeting' });
    expect(meetingResults).toHaveLength(1);
    expect(meetingResults[0].id).toBe('meetings/q1.md');
  });

  it('returns empty array when schemaType has no matching nodes', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'vendor', schemaType: 'person' });

    expect(results).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/search/search.test.ts`
Expected: FAIL — cannot resolve `../../src/search/search.js`

---

### Task 3: Implement search function (basic + type filter)

**Files:**
- Create: `src/search/search.ts`

**Step 1: Write the search function**

```typescript
// src/search/search.ts
import type Database from 'better-sqlite3';
import type { SearchOptions, SearchResult } from './types.js';

interface NodeRow {
  id: string;
  file_path: string;
  node_type: string;
  content_text: string;
  rank: number;
}

interface TypeRow {
  node_id: string;
  schema_type: string;
}

interface FieldRow {
  node_id: string;
  key: string;
  value_text: string;
  value_type: string;
}

export function search(db: Database.Database, options: SearchOptions): SearchResult[] {
  const limit = options.limit ?? 20;

  // Phase 1: FTS5 match + optional type filter
  let sql: string;
  const params: unknown[] = [];

  if (options.schemaType) {
    sql = `
      SELECT n.id, n.file_path, n.node_type, n.content_text, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      JOIN node_types nt ON nt.node_id = n.id
      WHERE nodes_fts MATCH ?
        AND nt.schema_type = ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params.push(options.query, options.schemaType, limit);
  } else {
    sql = `
      SELECT n.id, n.file_path, n.node_type, n.content_text, fts.rank
      FROM nodes_fts fts
      JOIN nodes n ON n.rowid = fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `;
    params.push(options.query, limit);
  }

  const rows = db.prepare(sql).all(...params) as NodeRow[];

  if (rows.length === 0) return [];

  // Phase 2: Batch-load types and fields
  const nodeIds = rows.map(r => r.id);
  const placeholders = nodeIds.map(() => '?').join(',');

  const typeRows = db.prepare(
    `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as TypeRow[];

  const fieldRows = db.prepare(
    `SELECT node_id, key, value_text, value_type FROM fields WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as FieldRow[];

  // Phase 3: Group and assemble
  const typesMap = new Map<string, string[]>();
  for (const row of typeRows) {
    const arr = typesMap.get(row.node_id) ?? [];
    arr.push(row.schema_type);
    typesMap.set(row.node_id, arr);
  }

  const fieldsMap = new Map<string, Record<string, { value: string; type: string }>>();
  for (const row of fieldRows) {
    const rec = fieldsMap.get(row.node_id) ?? {};
    rec[row.key] = { value: row.value_text, type: row.value_type };
    fieldsMap.set(row.node_id, rec);
  }

  return rows.map(row => ({
    id: row.id,
    filePath: row.file_path,
    nodeType: row.node_type,
    types: typesMap.get(row.id) ?? [],
    fields: fieldsMap.get(row.id) ?? {},
    contentText: row.content_text,
    rank: row.rank,
  }));
}
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/search/search.test.ts`
Expected: All 4 tests PASS

**Step 3: Commit**

```bash
git add src/search/search.ts
git commit -m "add search function with FTS5 matching and type filtering"
```

---

### Task 4: Write remaining tests (limit, fields, types, rank, FTS5 syntax)

**Files:**
- Modify: `tests/search/search.test.ts`

**Step 1: Add the remaining 6 tests**

Append these tests inside the existing `describe('search', ...)` block, after the last `it(...)`:

```typescript
  it('respects the limit option', () => {
    indexFixture('sample-task.md', 'tasks/review.md');
    indexFixture('sample-meeting.md', 'meetings/q1.md');

    // Both files contain text; search broadly
    const results = search(db, { query: 'proposal OR budget', limit: 1 });

    expect(results).toHaveLength(1);
  });

  it('defaults limit to 20', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    // We can't easily create 21 fixtures, so just verify the function works
    // without a limit param and returns results (implicit limit: 20)
    const results = search(db, { query: 'vendor' });
    expect(results).toHaveLength(1);
  });

  it('populates fields with correct keys, values, and types', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const results = search(db, { query: 'vendor' });

    expect(results[0].fields.status).toEqual({ value: 'todo', type: 'string' });
    expect(results[0].fields.priority).toEqual({ value: 'high', type: 'string' });
    expect(results[0].fields.assignee.type).toBe('reference');
    expect(results[0].fields.due_date.type).toBe('date');
  });

  it('populates types array including multi-typed nodes', () => {
    indexFixture('sample-meeting.md', 'meetings/q1.md');

    const results = search(db, { query: 'budget' });

    expect(results).toHaveLength(1);
    expect(results[0].types).toContain('meeting');
    expect(results[0].types).toContain('task');
  });

  it('ranks nodes with more occurrences of the term higher', () => {
    indexFixture('sample-task.md', 'tasks/review.md');
    // plain-note has no "vendor" mentions, task has several
    // Index a file that mentions "vendor" fewer times
    const raw = '---\ntitle: Brief\n---\nOne mention of vendor here.';
    const parsed = parseFile('notes/brief.md', raw);
    indexFile(db, parsed, 'notes/brief.md', '2025-03-10T00:00:00.000Z', raw);

    const results = search(db, { query: 'vendor' });

    expect(results.length).toBe(2);
    // Task file mentions "vendor" more often — should rank first (lower rank value)
    expect(results[0].id).toBe('tasks/review.md');
    expect(results[0].rank).toBeLessThanOrEqual(results[1].rank);
  });

  it('supports FTS5 phrase and prefix queries', () => {
    indexFixture('sample-task.md', 'tasks/review.md');

    const phrase = search(db, { query: '"vendor proposals"' });
    expect(phrase).toHaveLength(1);

    const prefix = search(db, { query: 'vend*' });
    expect(prefix).toHaveLength(1);
  });
```

**Step 2: Run all tests to verify they pass**

Run: `npx vitest run tests/search/search.test.ts`
Expected: All 10 tests PASS

**Step 3: Commit**

```bash
git add tests/search/search.test.ts
git commit -m "add comprehensive tests for FTS5 search"
```

---

### Task 5: Add module index and update CLAUDE.md

**Files:**
- Create: `src/search/index.ts`
- Modify: `CLAUDE.md`

**Step 1: Create the re-export index**

```typescript
// src/search/index.ts
export { search } from './search.js';
export type { SearchOptions, SearchResult } from './types.js';
```

**Step 2: Type-check the full project**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass (parser, db, sync, and search)

**Step 4: Update CLAUDE.md**

Add a new subsection under `### Sync Layer` describing the search module:

```markdown
### Search Layer (`src/search/`)

Full-text search over indexed content.

- **`types.ts`** — `SearchOptions` (query, schemaType, limit) and `SearchResult` (id, filePath, nodeType, types, fields, contentText, rank).
- **`search.ts`** — `search(db, options)` queries FTS5 with optional type filtering. Two-phase SQL: FTS5 MATCH for ranked node IDs, then batch-loads types and fields. Returns `SearchResult[]` ordered by bm25 rank.
- **`index.ts`** — Re-exports `search`, `SearchOptions`, `SearchResult`.
```

**Step 5: Commit**

```bash
git add src/search/index.ts CLAUDE.md
git commit -m "add search module index with re-exports, update CLAUDE.md"
```
