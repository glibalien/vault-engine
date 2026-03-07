# Full Rebuild Indexer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the `file → parse → upsert` pipeline that connects the parser to the database, enabling full vault rebuilds.

**Architecture:** Two functions in `src/sync/indexer.ts`. `indexFile` writes one parsed file into all DB tables (no transaction management). `rebuildIndex` scans a vault directory, clears the DB, parses and indexes every `.md` file in a single transaction. The `relationships` table FK on `target_id` is dropped to allow dangling wiki-link targets.

**Tech Stack:** TypeScript ESM, better-sqlite3, node:crypto (SHA-256), node:fs, fast-glob, vitest

---

### Task 1: Drop FK constraint on `target_id` in relationships table

**Files:**
- Modify: `src/db/schema.ts:44-53`
- Modify: `tests/db/schema.test.ts`

**Step 1: Update the schema DDL**

In `src/db/schema.ts`, remove the `FOREIGN KEY (target_id)` line from the `relationships` table. Keep the `FOREIGN KEY (source_id)` line. The table should become:

```typescript
    CREATE TABLE IF NOT EXISTS relationships (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id       TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      rel_type        TEXT NOT NULL,
      context         TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
```

**Step 2: Run existing tests to verify nothing breaks**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: All tests PASS. No existing test depends on the target_id FK.

**Step 3: Add a test confirming dangling target_id is allowed**

Add this test to `tests/db/schema.test.ts`:

```typescript
  it('allows dangling target_id in relationships (no FK on target)', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'text', '# Test')`
    ).run();

    expect(() =>
      db.prepare(
        `INSERT INTO relationships (source_id, target_id, rel_type)
         VALUES ('n1', 'nonexistent-target', 'wiki-link')`
      ).run()
    ).not.toThrow();
  });
```

**Step 4: Run tests**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "drop FK constraint on relationships.target_id for dangling wiki-links"
```

---

### Task 2: `indexFile` — test and implement node + node_types insertion

**Files:**
- Create: `tests/sync/indexer.test.ts`
- Create: `src/sync/indexer.ts`

**Step 1: Write the failing tests**

Create `tests/sync/indexer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('indexFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function loadAndParse(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    return { parsed: parseFile(relativePath, raw), raw };
  }

  it('inserts a node row with correct fields', () => {
    const { parsed } = loadAndParse('sample-task.md', 'tasks/review-vendor-proposals.md');
    indexFile(db, parsed, 'tasks/review-vendor-proposals.md', '2025-03-10T00:00:00.000Z');

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('tasks/review-vendor-proposals.md') as any;
    expect(node).toBeDefined();
    expect(node.file_path).toBe('tasks/review-vendor-proposals.md');
    expect(node.node_type).toBe('file');
    expect(node.content_text).toContain('Review the three vendor proposals');
    expect(node.content_md).toContain('[[Acme Corp Proposal]]');
    expect(node.depth).toBe(0);
    expect(node.parent_id).toBeNull();
  });

  it('inserts node_types for each type', () => {
    const { parsed } = loadAndParse('sample-meeting.md', 'meetings/q1-planning.md');
    indexFile(db, parsed, 'meetings/q1-planning.md', '2025-03-06T00:00:00.000Z');

    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type')
      .all('meetings/q1-planning.md') as any[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'task']);
  });

  it('inserts no node_types when types array is empty', () => {
    const parsed = parseFile('notes/plain.md', 'Just a plain note.');
    indexFile(db, parsed, 'notes/plain.md', '2025-03-10T00:00:00.000Z');

    const types = db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('notes/plain.md');
    expect(types).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — `src/sync/indexer.js` does not exist.

**Step 3: Implement `indexFile` (node + node_types only)**

Create `src/sync/indexer.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { ParsedFile } from '../parser/index.js';

export function indexFile(
  db: Database.Database,
  parsed: ParsedFile,
  relativePath: string,
  mtime: string,
): void {
  // Delete existing child rows
  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(relativePath);
  db.prepare('DELETE FROM node_types WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM fields WHERE node_id = ?').run(relativePath);

  // Upsert node
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, depth)
    VALUES (?, ?, 'file', ?, ?, 0)
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd);

  // Insert node_types
  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const type of parsed.types) {
    insertType.run(relativePath, type);
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "add indexFile with node and node_types insertion"
```

---

### Task 3: `indexFile` — fields insertion

**Files:**
- Modify: `tests/sync/indexer.test.ts`
- Modify: `src/sync/indexer.ts`

**Step 1: Write the failing tests**

Add to the `indexFile` describe block in `tests/sync/indexer.test.ts`:

```typescript
  it('inserts fields with correct value mappings', () => {
    const { parsed } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z');

    const fields = db.prepare('SELECT * FROM fields WHERE node_id = ? ORDER BY key')
      .all('tasks/review.md') as any[];
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));

    // string field
    expect(byKey.status.value_text).toBe('todo');
    expect(byKey.status.value_type).toBe('string');

    // reference field
    expect(byKey.assignee.value_type).toBe('reference');
    expect(byKey.assignee.value_text).toBe('[[Bob Jones]]');

    // number field — priority is 'high' (string), not a number
    expect(byKey.priority.value_type).toBe('string');
  });

  it('populates value_number for number fields', () => {
    const raw = '---\ntitle: Test\ncount: 42\n---\nBody.';
    const parsed = parseFile('test.md', raw);
    indexFile(db, parsed, 'test.md', '2025-03-10T00:00:00.000Z');

    const field = db.prepare('SELECT * FROM fields WHERE node_id = ? AND key = ?')
      .get('test.md', 'count') as any;
    expect(field.value_type).toBe('number');
    expect(field.value_number).toBe(42);
    expect(field.value_text).toBe('42');
  });

  it('populates value_date for date fields', () => {
    const { parsed } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z');

    const field = db.prepare('SELECT * FROM fields WHERE node_id = ? AND key = ?')
      .get('tasks/review.md', 'due_date') as any;
    expect(field.value_type).toBe('date');
    expect(field.value_date).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('serializes list fields as JSON', () => {
    const { parsed } = loadAndParse('sample-person.md', 'people/alice.md');
    indexFile(db, parsed, 'people/alice.md', '2025-03-10T00:00:00.000Z');

    const field = db.prepare('SELECT * FROM fields WHERE node_id = ? AND key = ?')
      .get('people/alice.md', 'tags') as any;
    expect(field.value_type).toBe('list');
    expect(JSON.parse(field.value_text)).toEqual(['engineering', 'leadership']);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — fields table is empty.

**Step 3: Add fields insertion to `indexFile`**

Add to the end of `indexFile` in `src/sync/indexer.ts`:

```typescript
  // Insert fields
  const insertField = db.prepare(`
    INSERT INTO fields (node_id, key, value_text, value_type, value_number, value_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const field of parsed.fields) {
    insertField.run(
      relativePath,
      field.key,
      stringifyValue(field.value, field.valueType),
      field.valueType,
      field.valueType === 'number' ? Number(field.value) : null,
      field.valueType === 'date' && field.value instanceof Date
        ? field.value.toISOString()
        : null,
    );
  }
```

Add this helper function above `indexFile`:

```typescript
function stringifyValue(value: unknown, valueType: string): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "add fields insertion to indexFile"
```

---

### Task 4: `indexFile` — relationships and files table insertion

**Files:**
- Modify: `tests/sync/indexer.test.ts`
- Modify: `src/sync/indexer.ts`

**Step 1: Write the failing tests**

Add to the `indexFile` describe block:

```typescript
  it('inserts relationships for frontmatter wiki-links with field name as rel_type', () => {
    const { parsed } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z');

    const rels = db.prepare('SELECT * FROM relationships WHERE source_id = ? ORDER BY target_id')
      .all('tasks/review.md') as any[];
    const assignee = rels.find(r => r.target_id === 'Bob Jones');
    expect(assignee).toBeDefined();
    expect(assignee.rel_type).toBe('assignee');

    const source = rels.find(r => r.target_id === 'Q1 Planning Meeting');
    expect(source).toBeDefined();
    expect(source.rel_type).toBe('source');
  });

  it('inserts relationships for body wiki-links with rel_type "wiki-link"', () => {
    const { parsed } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z');

    const rels = db.prepare(
      "SELECT * FROM relationships WHERE source_id = ? AND rel_type = 'wiki-link'"
    ).all('tasks/review.md') as any[];
    const targets = rels.map(r => r.target_id);
    expect(targets).toContain('Acme Corp Proposal');
    expect(targets).toContain('Globex Proposal');
    expect(targets).toContain('Alice Smith');
  });

  it('inserts into the files table with mtime and hash', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);

    const file = db.prepare('SELECT * FROM files WHERE path = ?').get('tasks/review.md') as any;
    expect(file).toBeDefined();
    expect(file.mtime).toBe('2025-03-10T00:00:00.000Z');
    expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — relationships and files tables are empty.

**Step 3: Update `indexFile` signature and add relationships + files insertion**

Update the `indexFile` signature to accept `raw`:

```typescript
import { createHash } from 'node:crypto';

export function indexFile(
  db: Database.Database,
  parsed: ParsedFile,
  relativePath: string,
  mtime: string,
  raw: string,
): void {
```

Add to the end of `indexFile`:

```typescript
  // Insert relationships
  const insertRel = db.prepare(`
    INSERT INTO relationships (source_id, target_id, rel_type, context)
    VALUES (?, ?, ?, ?)
  `);
  for (const link of parsed.wikiLinks) {
    insertRel.run(
      relativePath,
      link.target,
      link.field ?? 'wiki-link',
      link.context ?? null,
    );
  }

  // Upsert files row
  const hash = createHash('sha256').update(raw).digest('hex');
  db.prepare(`
    INSERT OR REPLACE INTO files (path, mtime, hash)
    VALUES (?, ?, ?)
  `).run(relativePath, mtime, hash);
```

**Step 4: Update earlier tests to pass `raw` parameter**

Update the `loadAndParse` helper and all existing `indexFile` calls to include the `raw` argument:

```typescript
  function loadAndParse(fixture: string, relativePath: string) {
    const raw = readFileSync(resolve(fixturesDir, fixture), 'utf-8');
    return { parsed: parseFile(relativePath, raw), raw };
  }
```

For any test using inline `parseFile`, pass the raw string too:

```typescript
  it('inserts no node_types when types array is empty', () => {
    const raw = 'Just a plain note.';
    const parsed = parseFile('notes/plain.md', raw);
    indexFile(db, parsed, 'notes/plain.md', '2025-03-10T00:00:00.000Z', raw);
    // ...
  });

  it('populates value_number for number fields', () => {
    const raw = '---\ntitle: Test\ncount: 42\n---\nBody.';
    const parsed = parseFile('test.md', raw);
    indexFile(db, parsed, 'test.md', '2025-03-10T00:00:00.000Z', raw);
    // ...
  });
```

**Step 5: Run tests**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts
git commit -m "add relationships and files table insertion to indexFile"
```

---

### Task 5: `indexFile` — idempotency test

**Files:**
- Modify: `tests/sync/indexer.test.ts`

**Step 1: Write the test**

Add to the `indexFile` describe block:

```typescript
  it('is idempotent — re-indexing replaces old data cleanly', () => {
    const { parsed, raw } = loadAndParse('sample-task.md', 'tasks/review.md');
    indexFile(db, parsed, 'tasks/review.md', '2025-03-10T00:00:00.000Z', raw);
    indexFile(db, parsed, 'tasks/review.md', '2025-03-11T00:00:00.000Z', raw);

    const nodes = db.prepare('SELECT * FROM nodes WHERE id = ?').all('tasks/review.md');
    expect(nodes).toHaveLength(1);

    const types = db.prepare('SELECT * FROM node_types WHERE node_id = ?').all('tasks/review.md');
    expect(types).toHaveLength(1); // task

    const file = db.prepare('SELECT * FROM files WHERE path = ?').get('tasks/review.md') as any;
    expect(file.mtime).toBe('2025-03-11T00:00:00.000Z');
  });
```

**Step 2: Run tests**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: PASS — the delete-then-insert strategy handles this.

**Step 3: Commit**

```bash
git add tests/sync/indexer.test.ts
git commit -m "add idempotency test for indexFile"
```

---

### Task 6: `rebuildIndex` — test and implement

**Files:**
- Modify: `tests/sync/indexer.test.ts`
- Modify: `src/sync/indexer.ts`

**Step 1: Create a test vault fixture directory**

Create fixture files for a mini vault at `tests/fixtures/vault/`:

Create `tests/fixtures/vault/tasks/review-vendor-proposals.md` — copy contents from `tests/fixtures/sample-task.md`.

Create `tests/fixtures/vault/people/alice-smith.md` — copy contents from `tests/fixtures/sample-person.md`.

Create `tests/fixtures/vault/notes/plain-note.md` with:

```markdown
Just a plain note with no frontmatter.

See [[Alice Smith]] for details.
```

**Step 2: Write the failing tests**

Add a new describe block in `tests/sync/indexer.test.ts`:

```typescript
import { rebuildIndex } from '../../src/sync/indexer.js';

describe('rebuildIndex', () => {
  let db: Database.Database;
  const vaultDir = resolve(import.meta.dirname, '../fixtures/vault');

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('indexes all .md files in the vault directory', () => {
    const result = rebuildIndex(db, vaultDir);

    expect(result.filesIndexed).toBe(3);

    const nodes = db.prepare('SELECT id FROM nodes ORDER BY id').all() as any[];
    expect(nodes.map(n => n.id)).toEqual([
      'notes/plain-note.md',
      'people/alice-smith.md',
      'tasks/review-vendor-proposals.md',
    ]);
  });

  it('populates node_types from frontmatter', () => {
    rebuildIndex(db, vaultDir);

    const taskTypes = db.prepare(
      "SELECT schema_type FROM node_types WHERE node_id = 'tasks/review-vendor-proposals.md'"
    ).all() as any[];
    expect(taskTypes.map(t => t.schema_type)).toEqual(['task']);

    const personTypes = db.prepare(
      "SELECT schema_type FROM node_types WHERE node_id = 'people/alice-smith.md'"
    ).all() as any[];
    expect(personTypes.map(t => t.schema_type)).toEqual(['person']);
  });

  it('populates relationships across files', () => {
    rebuildIndex(db, vaultDir);

    const rels = db.prepare('SELECT source_id, target_id, rel_type FROM relationships ORDER BY source_id, target_id')
      .all() as any[];
    expect(rels.length).toBeGreaterThan(0);

    // Task file references Bob Jones via assignee
    const assignee = rels.find(r => r.source_id === 'tasks/review-vendor-proposals.md' && r.target_id === 'Bob Jones');
    expect(assignee).toBeDefined();
    expect(assignee.rel_type).toBe('assignee');
  });

  it('populates the files table with mtime and hash', () => {
    rebuildIndex(db, vaultDir);

    const files = db.prepare('SELECT * FROM files ORDER BY path').all() as any[];
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(f.mtime).toBeTruthy();
      expect(f.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('clears old data on rebuild', () => {
    rebuildIndex(db, vaultDir);

    // Manually insert a stale node that isn't in the vault
    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('stale.md', 'stale.md', 'file', 'old', '# old')`
    ).run();

    rebuildIndex(db, vaultDir);

    const stale = db.prepare('SELECT * FROM nodes WHERE id = ?').get('stale.md');
    expect(stale).toBeUndefined();
  });

  it('FTS5 indexes content from rebuilt vault', () => {
    rebuildIndex(db, vaultDir);

    const results = db.prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'vendor'").all();
    expect(results.length).toBeGreaterThan(0);
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: FAIL — `rebuildIndex` is not exported.

**Step 4: Implement `rebuildIndex`**

Add to `src/sync/indexer.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { globSync } from 'node:fs';
```

Wait — `globSync` from `node:fs` requires Node 22+. Use the `glob` npm package or `fs.readdirSync` recursively. Actually, Node 22 has `globSync` on `node:fs`. The project requires Node >=20. Let's use a simple recursive readdir instead to avoid adding a dependency.

Add these imports at the top of `src/sync/indexer.ts`:

```typescript
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { relative, join } from 'node:path';
import { parseFile } from '../parser/index.js';
```

Add the function:

```typescript
export function rebuildIndex(
  db: Database.Database,
  vaultPath: string,
): { filesIndexed: number } {
  const mdFiles = globMd(vaultPath);

  const run = db.transaction(() => {
    // Clear all tables (children before parents for FK order)
    db.prepare('DELETE FROM relationships').run();
    db.prepare('DELETE FROM fields').run();
    db.prepare('DELETE FROM node_types').run();
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM files').run();

    let filesIndexed = 0;
    for (const absPath of mdFiles) {
      const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
      const raw = readFileSync(absPath, 'utf-8');
      const mtime = statSync(absPath).mtime.toISOString();

      try {
        const parsed = parseFile(rel, raw);
        indexFile(db, parsed, rel, mtime, raw);
        filesIndexed++;
      } catch {
        // Skip files that fail to parse
      }
    }

    return { filesIndexed };
  });

  return run();
}

function globMd(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(join(entry.parentPath, entry.name));
    }
  }
  return results;
}
```

**Step 5: Run tests**

Run: `npx vitest run tests/sync/indexer.test.ts`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add src/sync/indexer.ts tests/sync/indexer.test.ts tests/fixtures/vault/
git commit -m "add rebuildIndex with full vault scanning and indexing"
```

---

### Task 7: Re-exports and documentation

**Files:**
- Create: `src/sync/index.ts`
- Modify: `CLAUDE.md`

**Step 1: Create `src/sync/index.ts`**

```typescript
export { indexFile, rebuildIndex } from './indexer.js';
```

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 4: Update CLAUDE.md**

Add the sync module to the architecture section after the DB Layer description:

```markdown
### Sync Layer (`src/sync/`)

File-to-database indexing pipeline.

- **`indexer.ts`** — `indexFile(db, parsed, relativePath, mtime, raw)` writes one parsed file into all DB tables (nodes, node_types, fields, relationships, files). Uses delete-then-insert for child tables. Does not manage transactions. `rebuildIndex(db, vaultPath)` scans all `.md` files, clears the DB, and indexes everything in one transaction.
- **`index.ts`** — Re-exports `indexFile` and `rebuildIndex`.
```

**Step 5: Commit**

```bash
git add src/sync/index.ts CLAUDE.md
git commit -m "add sync module index with re-exports, update CLAUDE.md"
```
