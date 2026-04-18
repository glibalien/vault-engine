# Cross-Node Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graph-aware filtering to `query-nodes` (and, by inheritance, `update-node` query mode) via `join_filters` / `without_joins` parameters backed by a new pre-resolved `relationships.resolved_target_id` column.

**Architecture:** Three blocks in strict order. Block 1 adds a `resolved_target_id` column to `relationships`, populated at insert and maintained via lifecycle-event refresh helpers, with a startup backfill. Block 2 extends the shared query builder with EXISTS-based join filters. Block 3 threads those filters through `update-node` query mode.

**Tech Stack:** TypeScript (ESM, `.js` imports), `better-sqlite3`, Vitest, zod. Design spec: `docs/superpowers/specs/2026-04-17-cross-node-query-design.md`.

---

## File Structure

**New files:**
- `src/resolver/resolved-targets-version.ts` — meta-table version accessor (template: `src/db/search-version.ts`)
- `src/resolver/candidate-keys.ts` — pure helper deriving tier-keyed lookup strings for a node
- `src/resolver/refresh.ts` — `refreshOnCreate`, `refreshOnRename`, `refreshOnDelete`, `backfillResolvedTargets`
- `tests/integration/resolved-target-maintenance.test.ts`
- `tests/integration/cross-node-query.test.ts`
- `tests/integration/bulk-mutate-join-filters.test.ts`

**Modified files:**
- `src/db/schema.ts` — add `resolved_target_id` column + indexes to baseline `relationships` CREATE (replace the "no resolved_target_id column" comment)
- `src/db/migrate.ts` — new `upgradeForResolvedTargetId(db)` function
- `src/index.ts` — import + call the migration and `backfillResolvedTargets` on startup
- `src/indexer/indexer.ts` — inline `resolveTarget()` during relationship insert; also in `doIndex`'s relationship-insert loop
- `src/pipeline/execute.ts` — call `refreshOnCreate` / `refreshOnRename` at the right stage inside `executeMutation`
- `src/sync/watcher.ts` — delete path calls `refreshOnDelete` (currently no-op; placeholder for future) — see note in Task 8
- `src/sync/reconciler.ts` — same as watcher (delete path)
- `src/mcp/tools/delete-node.ts` — delete path calls `refreshOnDelete` (placeholder no-op)
- `src/mcp/tools/batch-mutate.ts` — confirmed to flow through `executeMutation` → inherits refresh; no wiring needed
- `src/mcp/query-builder.ts` — refactor `buildNodeQuery` body into `buildFilterClauses` helper; add `buildJoinExistsClauses`; simplify incoming `references` to use `resolved_target_id`
- `src/mcp/tools/query-nodes.ts` — extend zod schema with `join_filters` / `without_joins`; add `notice` detection + field in response
- `src/mcp/tools/update-node.ts` — extend query-mode zod schema; emit bulk `notice` in dry-run
- `tests/mcp/query-builder.test.ts` — extend with new filter cases
- `tests/helpers/db.ts` — no change required; `createSchema` change in `src/db/schema.ts` means fresh test DBs get the column automatically

**Dependency order (hard):** Block 1 (Tasks 1–9) → Block 2 (Tasks 10–14) → Block 3 (Tasks 15–16).

---

## Block 1 — `resolved_target_id` Infrastructure

### Task 1: Schema baseline + migration + version module

**Files:**
- Modify: `src/db/schema.ts:82-95`
- Modify: `src/db/migrate.ts` (append new function near existing `upgrade*` functions)
- Create: `src/resolver/resolved-targets-version.ts`
- Modify: `src/index.ts:9` and `src/index.ts:47` (import + call)

- [ ] **Step 1: Write the failing test**

Create `tests/db/resolved-target-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForResolvedTargetId } from '../../src/db/migrate.js';
import {
  CURRENT_RESOLVED_TARGETS_VERSION,
  getResolvedTargetsVersion,
  setResolvedTargetsVersion,
} from '../../src/resolver/resolved-targets-version.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('resolved_target_id schema + migration', () => {
  it('fresh createSchema includes resolved_target_id column and indexes', () => {
    const db = openDb();
    createSchema(db);
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('resolved_target_id');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relationships'").all() as Array<{ name: string }>;
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_relationships_resolved_target_id');
    expect(names).toContain('idx_relationships_source_resolved');
  });

  it('upgradeForResolvedTargetId is idempotent on DB missing the column', () => {
    const db = openDb();
    // Simulate an old DB: create relationships without resolved_target_id.
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, file_path TEXT, title TEXT, body TEXT, content_hash TEXT, file_mtime INTEGER, indexed_at INTEGER, created_at INTEGER);
      CREATE TABLE relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target TEXT NOT NULL,
        rel_type TEXT NOT NULL,
        context TEXT,
        UNIQUE(source_id, target, rel_type)
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
    upgradeForResolvedTargetId(db);
    upgradeForResolvedTargetId(db); // second call should be a no-op
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('resolved_target_id');
  });

  it('version accessor reads/writes meta.resolved_targets_version', () => {
    const db = openDb();
    createSchema(db);
    expect(getResolvedTargetsVersion(db)).toBe(0); // default when absent
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);
    expect(getResolvedTargetsVersion(db)).toBe(CURRENT_RESOLVED_TARGETS_VERSION);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/resolved-target-migration.test.ts`
Expected: FAIL — `upgradeForResolvedTargetId` not exported, `resolved-targets-version` not found, column missing.

- [ ] **Step 3: Update the baseline schema**

In `src/db/schema.ts`, replace the `relationships` block (lines 82–95):

```ts
    -- Relationships store raw target strings plus an optional resolved node id.
    -- resolved_target_id is populated at insert (indexer + pipeline) and maintained
    -- via src/resolver/refresh.ts on node create/rename/delete.
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      context TEXT,
      resolved_target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      UNIQUE(source_id, target, rel_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source_id ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
    CREATE INDEX IF NOT EXISTS idx_relationships_rel_type ON relationships(rel_type);
    CREATE INDEX IF NOT EXISTS idx_relationships_resolved_target_id ON relationships(resolved_target_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_source_resolved ON relationships(source_id, resolved_target_id);
```

- [ ] **Step 4: Add the migration function**

Append to `src/db/migrate.ts`:

```ts
export function upgradeForResolvedTargetId(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>;
    const hasCol = cols.some(c => c.name === 'resolved_target_id');
    if (!hasCol) {
      db.prepare(
        'ALTER TABLE relationships ADD COLUMN resolved_target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL'
      ).run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_relationships_resolved_target_id ON relationships(resolved_target_id)'
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_relationships_source_resolved ON relationships(source_id, resolved_target_id)'
    ).run();
  });
  run();
}
```

- [ ] **Step 5: Create the version module**

Create `src/resolver/resolved-targets-version.ts`:

```ts
import type Database from 'better-sqlite3';

export const CURRENT_RESOLVED_TARGETS_VERSION = 1;
const KEY = 'resolved_targets_version';

export function getResolvedTargetsVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (!row) return 0;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
}

export function setResolvedTargetsVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KEY, String(version));
}
```

- [ ] **Step 6: Wire migration into startup**

In `src/index.ts`, update the import on line 9:

```ts
import { upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6, addCreatedAt, upgradeForOverrides, ensureMetaTable, upgradeForResolvedTargetId } from './db/migrate.js';
```

Add after line 47 (`ensureMetaTable(db);`):

```ts
upgradeForResolvedTargetId(db);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/db/resolved-target-migration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Run full test suite to confirm no regressions**

Run: `npm test`
Expected: all green (new column is additive; existing tests unaffected).

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/resolver/resolved-targets-version.ts src/index.ts tests/db/resolved-target-migration.test.ts
git commit -m "feat(db): add resolved_target_id column + migration for relationships"
```

---

### Task 2: Candidate-keys helper

**Files:**
- Create: `src/resolver/candidate-keys.ts`
- Test: `tests/resolver/candidate-keys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/resolver/candidate-keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { candidateKeysForNode } from '../../src/resolver/candidate-keys.js';

describe('candidateKeysForNode', () => {
  it('produces file_path, title, basename, case-folded basename, NFC basename', () => {
    const keys = candidateKeysForNode({
      file_path: 'Projects/Acme Corp.md',
      title: 'Acme Corp',
    });
    expect(keys.file_path).toBe('Projects/Acme Corp.md');
    expect(keys.title).toBe('Acme Corp');
    expect(keys.basename).toBe('Acme Corp');
    expect(keys.basenameLower).toBe('acme corp');
    expect(keys.basenameNfcLower).toBe('acme corp');
  });

  it('strips .md extension from basename', () => {
    const keys = candidateKeysForNode({ file_path: 'a/b/Foo.md', title: 'Foo' });
    expect(keys.basename).toBe('Foo');
  });

  it('normalizes unicode for NFC key', () => {
    // "café" as NFD (e + combining acute)
    const nfd = 'cafe\u0301';
    const keys = candidateKeysForNode({ file_path: `${nfd}.md`, title: nfd });
    expect(keys.basenameNfcLower).toBe('café'.normalize('NFC').toLowerCase());
  });

  it('returns null title when title is null', () => {
    const keys = candidateKeysForNode({ file_path: 'Untitled.md', title: null });
    expect(keys.title).toBeNull();
    expect(keys.basename).toBe('Untitled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resolver/candidate-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/resolver/candidate-keys.ts`:

```ts
import { basename } from 'node:path';

export interface NodeLike {
  file_path: string;
  title: string | null;
}

export interface CandidateKeys {
  file_path: string;
  title: string | null;
  basename: string;
  basenameLower: string;
  basenameNfcLower: string;
}

export function candidateKeysForNode(node: NodeLike): CandidateKeys {
  const base = basename(node.file_path, '.md');
  return {
    file_path: node.file_path,
    title: node.title,
    basename: base,
    basenameLower: base.toLowerCase(),
    basenameNfcLower: base.normalize('NFC').toLowerCase(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/resolver/candidate-keys.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver/candidate-keys.ts tests/resolver/candidate-keys.test.ts
git commit -m "feat(resolver): add candidateKeysForNode helper for tier-keyed lookups"
```

---

### Task 3: Refresh helpers — `refreshOnCreate`

**Files:**
- Create: `src/resolver/refresh.ts`
- Test: `tests/resolver/refresh.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/resolver/refresh.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { refreshOnCreate } from '../../src/resolver/refresh.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

function insertNode(id: string, file_path: string, title: string | null) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, file_path, title, null, null, null, null);
}
function insertRel(source_id: string, target: string, rel_type = 'wiki-link') {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, NULL)'
  ).run(source_id, target, rel_type, null);
}
function resolvedFor(source_id: string, target: string): string | null {
  const row = db.prepare(
    'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
  ).get(source_id, target) as { resolved_target_id: string | null } | undefined;
  return row?.resolved_target_id ?? null;
}

describe('refreshOnCreate', () => {
  it('resolves unresolved edges pointing at the new node by file_path', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Projects/Acme.md');
    insertNode('new1', 'Projects/Acme.md', 'Acme');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Projects/Acme.md')).toBe('new1');
  });

  it('resolves by exact title', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Acme Corp');
    insertNode('new1', 'deeply/nested/Acme Corp.md', 'Acme Corp');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Acme Corp')).toBe('new1');
  });

  it('resolves by basename', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Acme');
    insertNode('new1', 'dir/Acme.md', null);
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Acme')).toBe('new1');
  });

  it('resolves by case-folded basename', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'acme');
    insertNode('new1', 'dir/Acme.md', null);
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'acme')).toBe('new1');
  });

  it('leaves already-resolved edges alone', () => {
    insertNode('existing', 'dir/Thing.md', 'Thing');
    insertNode('src1', 'writer.md', 'Writer');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Thing', 'wiki-link', 'existing');
    insertNode('new1', 'another/Thing.md', 'Thing');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'Thing')).toBe('existing'); // not superseded (documented v1 limitation)
  });

  it('does not touch edges whose target does not match any key', () => {
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'UnrelatedName');
    insertNode('new1', 'dir/Acme.md', 'Acme');
    refreshOnCreate(db, 'new1');
    expect(resolvedFor('src1', 'UnrelatedName')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resolver/refresh.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `refreshOnCreate`**

Create `src/resolver/refresh.ts`:

```ts
import type Database from 'better-sqlite3';
import { candidateKeysForNode } from './candidate-keys.js';

/**
 * Called after a node is created. Resolves any existing NULL-resolved
 * relationships whose raw `target` matches one of the new node's
 * candidate keys (file_path, title, basename, case-folded basename,
 * NFC-normalized basename).
 *
 * Does NOT supersede already-resolved edges — see documented v1 limitation.
 */
export function refreshOnCreate(db: Database.Database, nodeId: string): void {
  const row = db
    .prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
    .get(nodeId) as { id: string; file_path: string; title: string | null } | undefined;
  if (!row) return;
  const keys = candidateKeysForNode(row);

  const tx = db.transaction(() => {
    // Tier 1: exact file_path
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND target = ?`
    ).run(nodeId, keys.file_path);

    // Tier 2: exact title (when present)
    if (keys.title !== null) {
      db.prepare(
        `UPDATE relationships SET resolved_target_id = ?
           WHERE resolved_target_id IS NULL AND target = ?`
      ).run(nodeId, keys.title);
    }

    // Tier 3: exact basename
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND target = ?`
    ).run(nodeId, keys.basename);

    // Tier 4: case-folded basename (compare lowercased target to basenameLower)
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND LOWER(target) = ?`
    ).run(nodeId, keys.basenameLower);

    // Tier 5: NFC-normalized, case-folded basename.
    // SQLite has no NFC normalization; handle with a scan restricted to NULL rows.
    const nullRows = db
      .prepare(`SELECT id, target FROM relationships WHERE resolved_target_id IS NULL`)
      .all() as Array<{ id: number; target: string }>;
    const upd = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
    for (const r of nullRows) {
      if (r.target.normalize('NFC').toLowerCase() === keys.basenameNfcLower) {
        upd.run(nodeId, r.id);
      }
    }
  });
  tx();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/resolver/refresh.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolver/refresh.ts tests/resolver/refresh.test.ts
git commit -m "feat(resolver): add refreshOnCreate lifecycle helper"
```

---

### Task 4: Refresh helpers — `refreshOnRename`

**Files:**
- Modify: `src/resolver/refresh.ts` (append)
- Modify: `tests/resolver/refresh.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/resolver/refresh.test.ts`:

```ts
import { refreshOnRename } from '../../src/resolver/refresh.js';

describe('refreshOnRename', () => {
  it('nulls edges pointing at the old resolution and re-resolves via resolveTarget', () => {
    // Start state: nodeA at Foo.md/title Foo. src1 links to "Foo" via wiki-link.
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('src1', 'writer.md', 'Writer');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');

    // Rename A: Foo.md -> Bar.md, title Foo -> Bar.
    db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run('Bar.md', 'Bar', 'A');
    refreshOnRename(db, 'A');

    // The "Foo" edge no longer matches A's new keys; it becomes NULL (no other node matches).
    expect(resolvedFor('src1', 'Foo')).toBeNull();
  });

  it('edges using the new name get resolved after rename', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('src1', 'writer.md', 'Writer');
    // Pre-rename: src1 links to "Bar" — unresolved.
    insertRel('src1', 'Bar');

    db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run('Bar.md', 'Bar', 'A');
    refreshOnRename(db, 'A');

    expect(resolvedFor('src1', 'Bar')).toBe('A');
  });

  it('other unique targets in the NULL set re-resolve to a different node if possible', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('B', 'Baz.md', 'Baz');
    insertNode('src1', 'writer.md', 'Writer');
    // Pre-rename: src1 links to "Foo" (resolved=A) and "Baz" (resolved=A erroneously, as a stand-in).
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Baz', 'wiki-link', 'A');

    db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run('Qux.md', 'Qux', 'A');
    refreshOnRename(db, 'A');

    // "Baz" should re-resolve to B via resolveTarget.
    expect(resolvedFor('src1', 'Baz')).toBe('B');
    // "Foo" has no matching node; stays NULL.
    expect(resolvedFor('src1', 'Foo')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resolver/refresh.test.ts`
Expected: FAIL — `refreshOnRename` not exported.

- [ ] **Step 3: Implement `refreshOnRename`**

Append to `src/resolver/refresh.ts`:

```ts
import { resolveTarget } from './resolve.js';

/**
 * Called after a node's file_path or title changes.
 * Step 1: null out every relationship whose resolved_target_id = nodeId.
 * Step 2: for each unique raw target in those rows, call resolveTarget and
 *         repopulate. (Deduping keeps N resolver calls down to U unique
 *         targets.)
 * Step 3: run refreshOnCreate-equivalent over still-NULL rows — rows whose
 *         raw target now matches the renamed node's new keys.
 */
export function refreshOnRename(db: Database.Database, nodeId: string): void {
  const tx = db.transaction(() => {
    const affected = db
      .prepare(
        'SELECT DISTINCT target FROM relationships WHERE resolved_target_id = ?'
      )
      .all(nodeId) as Array<{ target: string }>;

    db.prepare('UPDATE relationships SET resolved_target_id = NULL WHERE resolved_target_id = ?').run(nodeId);

    const upd = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE target = ? AND resolved_target_id IS NULL');
    for (const { target } of affected) {
      const resolved = resolveTarget(db, target);
      if (resolved) {
        upd.run(resolved.id, target);
      }
    }

    // Step 3: cover edges whose raw target matches the new name.
    // Inline the create-logic rather than nesting transactions.
    const row = db
      .prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
      .get(nodeId) as { id: string; file_path: string; title: string | null } | undefined;
    if (!row) return;
    const keys = candidateKeysForNode(row);

    db.prepare(
      'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?'
    ).run(nodeId, keys.file_path);
    if (keys.title !== null) {
      db.prepare(
        'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?'
      ).run(nodeId, keys.title);
    }
    db.prepare(
      'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?'
    ).run(nodeId, keys.basename);
    db.prepare(
      'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND LOWER(target) = ?'
    ).run(nodeId, keys.basenameLower);

    const nullRows = db
      .prepare('SELECT id, target FROM relationships WHERE resolved_target_id IS NULL')
      .all() as Array<{ id: number; target: string }>;
    const updById = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
    for (const r of nullRows) {
      if (r.target.normalize('NFC').toLowerCase() === keys.basenameNfcLower) {
        updById.run(nodeId, r.id);
      }
    }
  });
  tx();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/resolver/refresh.test.ts`
Expected: PASS (9 tests total — 6 from Task 3 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/resolver/refresh.ts tests/resolver/refresh.test.ts
git commit -m "feat(resolver): add refreshOnRename lifecycle helper"
```

---

### Task 5: Refresh helpers — `refreshOnDelete` (placeholder) + `backfillResolvedTargets`

**Files:**
- Modify: `src/resolver/refresh.ts` (append)
- Modify: `tests/resolver/refresh.test.ts` (append)

`refreshOnDelete` is a documented no-op in v1 — `ON DELETE SET NULL` handles nullification. We still export it so call sites compile cleanly and a future v2 can fill it in without touching every call site.

- [ ] **Step 1: Write the failing test**

Append to `tests/resolver/refresh.test.ts`:

```ts
import { refreshOnDelete, backfillResolvedTargets } from '../../src/resolver/refresh.js';

describe('refreshOnDelete', () => {
  it('is a no-op in v1 (FK ON DELETE SET NULL handles nullification)', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('src1', 'writer.md', 'Writer');
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');
    expect(() => refreshOnDelete(db, 'A')).not.toThrow();
    // Row still resolves to A — the actual nulling happens via FK, not via this helper.
    expect(resolvedFor('src1', 'Foo')).toBe('A');
  });
});

describe('backfillResolvedTargets', () => {
  it('populates resolved_target_id for every NULL row that can resolve', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('B', 'dir/Bar.md', 'Bar');
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Foo');
    insertRel('src1', 'Bar');
    insertRel('src1', 'UnrelatedName');

    const stats = backfillResolvedTargets(db);
    expect(stats.updated).toBe(2);
    expect(stats.scanned).toBe(3);
    expect(resolvedFor('src1', 'Foo')).toBe('A');
    expect(resolvedFor('src1', 'Bar')).toBe('B');
    expect(resolvedFor('src1', 'UnrelatedName')).toBeNull();
  });

  it('is safe to call twice', () => {
    insertNode('A', 'Foo.md', 'Foo');
    insertNode('src1', 'writer.md', 'Writer');
    insertRel('src1', 'Foo');
    backfillResolvedTargets(db);
    const second = backfillResolvedTargets(db);
    // On second call, no NULLs remain.
    expect(second.updated).toBe(0);
  });

  it('dedupes identical targets — resolver called once per unique target', () => {
    insertNode('A', 'Foo.md', 'Foo');
    for (let i = 0; i < 5; i++) {
      insertNode(`src${i}`, `w${i}.md`, `W${i}`);
      insertRel(`src${i}`, 'Foo');
    }
    const stats = backfillResolvedTargets(db);
    expect(stats.updated).toBe(5);
    expect(stats.uniqueTargets).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/resolver/refresh.test.ts`
Expected: FAIL — `refreshOnDelete` and `backfillResolvedTargets` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/resolver/refresh.ts`:

```ts
/**
 * v1: no-op. FK `ON DELETE SET NULL` handles the row-level nulling.
 * Exported so callers can wire in advance; future versions may promote
 * runner-up resolutions for affected rows.
 */
export function refreshOnDelete(_db: Database.Database, _nodeId: string): void {
  // Intentionally empty. See spec: "Re-resolution on delete ... documented v1 limitation."
}

export interface BackfillStats {
  scanned: number;
  uniqueTargets: number;
  updated: number;
}

/**
 * Walks every NULL-resolved relationship, dedupes by raw target, calls
 * resolveTarget per unique string, and UPDATEs in chunks. Intended for
 * one-shot use at startup after the migration (version-gated by caller).
 */
export function backfillResolvedTargets(db: Database.Database): BackfillStats {
  const nullRows = db
    .prepare('SELECT id, target FROM relationships WHERE resolved_target_id IS NULL')
    .all() as Array<{ id: number; target: string }>;

  const scanned = nullRows.length;
  if (scanned === 0) {
    return { scanned: 0, uniqueTargets: 0, updated: 0 };
  }

  // Dedupe by raw target.
  const byTarget = new Map<string, number[]>();
  for (const r of nullRows) {
    const list = byTarget.get(r.target);
    if (list) list.push(r.id);
    else byTarget.set(r.target, [r.id]);
  }

  let updated = 0;
  const upd = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const [target, ids] of byTarget) {
      const resolved = resolveTarget(db, target);
      if (!resolved) continue;
      for (const id of ids) {
        upd.run(resolved.id, id);
        updated++;
      }
    }
  });
  tx();

  return { scanned, uniqueTargets: byTarget.size, updated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/resolver/refresh.test.ts`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/resolver/refresh.ts tests/resolver/refresh.test.ts
git commit -m "feat(resolver): add refreshOnDelete stub and backfillResolvedTargets"
```

---

### Task 6: Inline resolve during indexer relationship insert

**Files:**
- Modify: `src/indexer/indexer.ts:62` (prepared statement) and `src/indexer/indexer.ts:204-208` (insertion loop)
- Test: `tests/indexer/relationship-resolve.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/indexer/relationship-resolve.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';

let vault: string;
let db: Database.Database;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'rel-resolve-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

describe('indexer populates resolved_target_id at insert', () => {
  it('sets resolved_target_id when a target resolves, leaves NULL when it does not', async () => {
    writeFileSync(join(vault, 'Writer.md'), '# Writer\n\nLinks to [[Acme Corp]] and [[Nonexistent]].\n');
    writeFileSync(join(vault, 'Acme Corp.md'), '# Acme Corp\n');
    await fullIndex(vault, db);

    const rels = db.prepare(
      'SELECT target, resolved_target_id FROM relationships WHERE source_id = (SELECT id FROM nodes WHERE file_path = ?)'
    ).all('Writer.md') as Array<{ target: string; resolved_target_id: string | null }>;

    const acme = rels.find(r => r.target === 'Acme Corp');
    const nope = rels.find(r => r.target === 'Nonexistent');
    expect(acme?.resolved_target_id).not.toBeNull();
    expect(nope?.resolved_target_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/relationship-resolve.test.ts`
Expected: FAIL — `resolved_target_id` will be NULL for "Acme Corp" because indexer doesn't populate it yet.

- [ ] **Step 3: Modify `insertRelationship` prepared statement**

In `src/indexer/indexer.ts`, change the prepared statement at line 62:

```ts
insertRelationship: db.prepare(
  'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)',
),
```

Update the insertion loop (around lines 204–208):

```ts
// Insert relationships from wiki-links
for (const link of parsed.wikiLinks) {
  const relType = fieldNames.has(link.context) ? link.context : 'wiki-link';
  const resolved = resolveTarget(db, link.target);
  stmts.insertRelationship.run(nodeId, link.target, relType, link.context, resolved?.id ?? null);
}
```

Add the import at the top of `src/indexer/indexer.ts` (next to existing imports from `../resolver/...`):

```ts
import { resolveTarget } from '../resolver/resolve.js';
```

(If the import is already present, skip that line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/relationship-resolve.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run full suite to catch regressions**

Run: `npm test`
Expected: all green. (If query-builder tests fail because of resolver behavior changes, they shouldn't — query-time resolution is unchanged until Task 9.)

- [ ] **Step 6: Commit**

```bash
git add src/indexer/indexer.ts tests/indexer/relationship-resolve.test.ts
git commit -m "feat(indexer): populate resolved_target_id at relationship insert"
```

---

### Task 7: Wire `refreshOnCreate` / `refreshOnRename` into `executeMutation`

**Files:**
- Modify: `src/pipeline/execute.ts` (inside the Stage 6 write block around lines 246–346)
- Test: `tests/pipeline/refresh-wiring.test.ts` (new)

`executeMutation` also needs to populate `resolved_target_id` on the relationship rows it inserts in Stage 6d. Otherwise pipeline-inserted edges (create / update) would be NULL-resolved until the next startup backfill.

- [ ] **Step 1: Write the failing test**

Create `tests/pipeline/refresh-wiring.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

let vault: string;
let db: Database.Database;
let lock: WriteLockManager;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'refresh-wire-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  lock = new WriteLockManager();
});
afterEach(() => {
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

function runMutation(mutation: Parameters<typeof executeMutation>[3]) {
  return executeMutation(db, lock, vault, mutation);
}

describe('executeMutation wires refresh helpers', () => {
  it('creating a node resolves pre-existing unresolved edges pointing at it', () => {
    // Seed an existing node with an unresolved edge.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src1', 'Writer.md', 'Writer', 'Body mentions [[Acme Corp]]', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('src1', 'Acme Corp', 'wiki-link');

    // Create the target via mutation.
    const result = runMutation({
      source: 'tool',
      node_id: null,
      file_path: 'Acme Corp.md',
      title: 'Acme Corp',
      types: [],
      fields: {},
      body: '# Acme Corp\n',
    });
    expect(result.status).toBe('ok');

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
    ).get('src1', 'Acme Corp') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).not.toBeNull();
  });

  it('renaming a node re-resolves edges bound to its old identity', () => {
    // Setup: A (Foo.md, title Foo), src1 links "Foo" → resolved=A.
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('A', 'Foo.md', 'Foo', '# Foo\n', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src1', 'Writer.md', 'Writer', 'Body', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src1', 'Foo', 'wiki-link', 'A');

    // Rename A: file_path and title change.
    runMutation({
      source: 'tool',
      node_id: 'A',
      file_path: 'Bar.md',
      title: 'Bar',
      types: [],
      fields: {},
      body: '# Bar\n',
    });

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = ?'
    ).get('src1', 'Foo') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).toBeNull(); // "Foo" no longer matches A's new identity
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline/refresh-wiring.test.ts`
Expected: FAIL — resolved_target_id stays NULL (create) or stays pointing at A (rename).

- [ ] **Step 3: Thread resolver into the relationship insert in execute.ts**

In `src/pipeline/execute.ts`, around the Stage 6d loop (lines 315–323), change the insert to include `resolved_target_id`:

```ts
// Stage 6d: Delete + reinsert relationships (lines 315–323)
db.prepare('DELETE FROM relationships WHERE source_id = ?').run(nodeId);
const insertRel = db.prepare(
  'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
);
const rels = deriveRelationships(finalFields, mutation.body, globalFields, orphanRawValues);
for (const rel of rels) {
  const resolved = resolveTarget(db, rel.target);
  insertRel.run(nodeId, rel.target, rel.rel_type, rel.context, resolved?.id ?? null);
}
```

Add the import at the top of `src/pipeline/execute.ts`:

```ts
import { resolveTarget } from '../resolver/resolve.js';
```

- [ ] **Step 4: Call refresh helpers at the right points**

Still in `src/pipeline/execute.ts`, after the whole write block completes (after the `return { node_id: nodeId, ... }` inside `writeLock.withLockSync`), insert the refresh call. The cleanest placement: **after** the write lock block returns, using the `isCreate` / `isRename` signals already in scope.

Locate the end of the Stage 6 block (after the edits-log insert, before the outer function returns its `PipelineResult`). Add:

```ts
// Lifecycle-event refresh: keep resolved_target_id consistent across other nodes.
if (isCreate) {
  refreshOnCreate(db, nodeId);
} else if (isRename) {
  refreshOnRename(db, nodeId);
}
```

Add the import at the top of `src/pipeline/execute.ts`:

```ts
import { refreshOnCreate, refreshOnRename } from '../resolver/refresh.js';
```

**Where `isCreate` / `isRename` come from:** `executeMutation` already distinguishes create vs update via `mutation.node_id === null` (create) vs existing node id (update). For update, it tracks prior file_path/title to detect rename. Read lines 45–120 of `src/pipeline/execute.ts` to locate the exact variables — they exist (the rename codepath already updates the `nodes` table). If no `isRename` boolean is present, derive it locally:

```ts
const isCreate = mutation.node_id === null;
// Where `prior` is the pre-existing nodes row (already fetched earlier in the function
// when mutation.node_id !== null), define:
const isRename = !isCreate && (prior.file_path !== finalFilePath || prior.title !== finalTitle);
```

Use the variable names that already exist at that point in the function. If `prior` has a different name (e.g. `existing`, `currentNode`), use that.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/pipeline/refresh-wiring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/execute.ts tests/pipeline/refresh-wiring.test.ts
git commit -m "feat(pipeline): wire resolveTarget + refresh helpers into executeMutation"
```

---

### Task 8: Wire delete-path placeholders (watcher, reconciler, delete-node tool)

**Files:**
- Modify: `src/indexer/indexer.ts` (inside `deleteNodeByPath`, around line 388)
- Modify: `src/mcp/tools/delete-node.ts` (around line 105)
- Test: `tests/resolver/delete-integration.test.ts` (new)

`refreshOnDelete` is a no-op in v1, but calls are wired now so call sites are ready for v2. The more important delete-path assertion: FK `ON DELETE SET NULL` must actually fire — verify it explicitly.

- [ ] **Step 1: Write the failing test**

Create `tests/resolver/delete-integration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { deleteNodeByPath } from '../../src/indexer/indexer.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

describe('delete lifecycle', () => {
  it('ON DELETE SET NULL nullifies resolved_target_id for incoming edges', () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('tgt', 'Target.md', 'Target', '', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src', 'Source.md', 'Source', '', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
    ).run('src', 'Target', 'wiki-link', 'tgt');

    deleteNodeByPath('Target.md', db);

    const row = db.prepare(
      'SELECT resolved_target_id, target FROM relationships WHERE source_id = ?'
    ).get('src') as { resolved_target_id: string | null; target: string };
    expect(row.resolved_target_id).toBeNull();
    expect(row.target).toBe('Target'); // raw target text preserved
  });
});
```

- [ ] **Step 2: Run test to verify it passes OR fails**

Run: `npx vitest run tests/resolver/delete-integration.test.ts`
Expected: should already PASS if the migration ran — FK `ON DELETE SET NULL` is automatic. If it fails, the schema didn't apply correctly; review Task 1.

- [ ] **Step 3: Add `refreshOnDelete` calls at choke points (no-op stubs for v1 symmetry)**

In `src/indexer/indexer.ts`, inside `deleteNodeByPath` (around line 388, after the `txn()` call and before the `embeddingIndexer?.removeNode(existing.id)`):

```ts
refreshOnDelete(db, existing.id);
```

Add import at the top:

```ts
import { refreshOnDelete } from '../resolver/refresh.js';
```

In `src/mcp/tools/delete-node.ts` (around line 105, after the `txn()` call inside the write-lock block):

```ts
refreshOnDelete(db, node.node_id);
```

Add import at top:

```ts
import { refreshOnDelete } from '../../resolver/refresh.js';
```

(Watcher and reconciler both delete via `deleteNodeByPath` from `src/indexer/indexer.ts` — modifying that function covers them both.)

- [ ] **Step 4: Run test to confirm still passes**

Run: `npx vitest run tests/resolver/delete-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/indexer.ts src/mcp/tools/delete-node.ts tests/resolver/delete-integration.test.ts
git commit -m "feat(resolver): wire refreshOnDelete placeholders at delete choke points"
```

---

### Task 9: Startup backfill + incoming-`references` simplification

**Files:**
- Modify: `src/index.ts:47` (add backfill gate)
- Modify: `src/mcp/query-builder.ts:151-177` (simplify incoming references)
- Modify: `tests/mcp/query-builder.test.ts` (adjust expectations if any assert exact SQL for incoming references)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/resolved-target-maintenance.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import {
  CURRENT_RESOLVED_TARGETS_VERSION,
  getResolvedTargetsVersion,
  setResolvedTargetsVersion,
} from '../../src/resolver/resolved-targets-version.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

describe('resolved-target startup backfill', () => {
  it('first-open populates resolved_target_id on pre-existing NULL rows', () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('A', 'Foo.md', 'Foo', '', null, null, null);
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('src', 'Source.md', 'Source', '', null, null, null);
    db.prepare(
      'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)'
    ).run('src', 'Foo', 'wiki-link');

    expect(getResolvedTargetsVersion(db)).toBe(0);
    const stats = backfillResolvedTargets(db);
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);

    expect(stats.updated).toBe(1);
    expect(getResolvedTargetsVersion(db)).toBe(CURRENT_RESOLVED_TARGETS_VERSION);

    const row = db.prepare(
      'SELECT resolved_target_id FROM relationships WHERE source_id = ?'
    ).get('src') as { resolved_target_id: string | null };
    expect(row.resolved_target_id).toBe('A');
  });

  it('second-open is a no-op when version is current', () => {
    setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);
    // Simulating startup: caller checks version before calling backfill.
    // Here we assert the helper still correctly reports zero updates on an
    // already-populated DB.
    const stats = backfillResolvedTargets(db);
    expect(stats.scanned).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails OR passes**

Run: `npx vitest run tests/integration/resolved-target-maintenance.test.ts`
Expected: PASS — the building blocks are already in place from Tasks 1 and 5. If it fails, check imports.

- [ ] **Step 3: Gate backfill on version in `src/index.ts`**

In `src/index.ts`, after `upgradeForResolvedTargetId(db);` (added in Task 1, around line 48), and BEFORE `fullIndex(vaultPath, db)` at line 57:

```ts
import {
  CURRENT_RESOLVED_TARGETS_VERSION,
  getResolvedTargetsVersion,
  setResolvedTargetsVersion,
} from './resolver/resolved-targets-version.js';
import { backfillResolvedTargets } from './resolver/refresh.js';

// ... existing startup code ...

const storedResolvedVersion = getResolvedTargetsVersion(db);
if (storedResolvedVersion < CURRENT_RESOLVED_TARGETS_VERSION) {
  console.log(`Resolved-target backfill ${storedResolvedVersion} → ${CURRENT_RESOLVED_TARGETS_VERSION}...`);
  const stats = backfillResolvedTargets(db);
  console.log(`Backfill complete: ${stats.updated}/${stats.scanned} rows resolved (${stats.uniqueTargets} unique targets).`);
  setResolvedTargetsVersion(db, CURRENT_RESOLVED_TARGETS_VERSION);
}
```

Place the imports up top with the other migration-related imports.

- [ ] **Step 4: Simplify incoming `references` in the query builder**

In `src/mcp/query-builder.ts`, lines 151–177, replace the incoming-references branch. Before:

```ts
// OLD: resolves target text at query time, builds IN list of variants
const resolved = resolveTarget(db!, ref.target);
if (!resolved) {
  whereClauses.push('1 = 0');
} else {
  // ... IN-list against title, file_path, basename variants ...
}
```

After:

```ts
// NEW: resolve once, join on resolved_target_id
const resolved = resolveTarget(db!, ref.target);
if (!resolved) {
  whereClauses.push('1 = 0');
} else {
  const alias = `r${joinIdx++}`;
  joins.push(
    `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.resolved_target_id = ?`
  );
  joinParams.push(resolved.id);
  if (ref.rel_type) {
    whereClauses.push(`${alias}.rel_type = ?`);
    whereParams.push(ref.rel_type);
  }
}
```

(Outgoing `references` — the branch at lines 140–149 — is unchanged.)

- [ ] **Step 5: Run affected tests**

Run: `npx vitest run tests/mcp/query-builder.test.ts tests/integration/resolved-target-maintenance.test.ts`
Expected: all PASS. If an existing query-builder test asserts the exact shape of incoming-references SQL (e.g. checking for `IN (?, ?, ?)` against file_path/title/basename variants), update it to match the new single `resolved_target_id = ?` shape. Behavior test (does the right node get returned?) should continue passing.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/mcp/query-builder.ts tests/integration/resolved-target-maintenance.test.ts tests/mcp/query-builder.test.ts
git commit -m "feat(resolver): startup backfill + simplify incoming references via resolved_target_id"
```

---

## Block 2 — `join_filters` and `without_joins` on `query-nodes`

### Task 10: Refactor `buildNodeQuery` into `buildFilterClauses` helper

**Files:**
- Modify: `src/mcp/query-builder.ts` (factor body into helper)
- Test: `tests/mcp/query-builder.test.ts` (existing tests must still pass)

- [ ] **Step 1: Run existing tests to confirm green baseline**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: all PASS.

- [ ] **Step 2: Factor `buildNodeQuery`'s body into `buildFilterClauses`**

In `src/mcp/query-builder.ts`, add (before or after `buildNodeQuery`):

```ts
export interface FilterClauses {
  joins: string[];
  joinParams: unknown[];
  whereClauses: string[];
  whereParams: unknown[];
}

/**
 * Compiles a NodeQueryFilter into JOINs and WHEREs at a given alias.
 * Used by buildNodeQuery for the outer `n`, and recursively by
 * buildJoinExistsClauses for target nodes (aliased `tN`).
 *
 * The `idx` counter is passed by reference (via object wrapper) so nested
 * invocations don't collide on alias names.
 */
export function buildFilterClauses(
  filter: NodeQueryFilter,
  alias: string,
  idx: { n: number },
  db?: Database.Database,
): FilterClauses {
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  // Move the existing body of buildNodeQuery into here, replacing:
  //   `n.` → `${alias}.`
  //   alias counter variable `joinIdx` → `idx.n`
  //   alias generation: `t${joinIdx++}` → `t${idx.n++}_${alias}`,
  //                     `f${joinIdx++}` → `f${idx.n++}_${alias}`,
  //                     `r${joinIdx++}` → `r${idx.n++}_${alias}`
  //
  // (The `_${alias}` suffix guarantees uniqueness under nesting:
  //  outer-scope `t0_n` and inner-scope `t0_t0_n` never collide.)
  //
  // NOTE: filter.join_filters / filter.without_joins are NOT handled here.
  // They're handled by the caller (buildNodeQuery) via buildJoinExistsClauses.

  // ... (entire existing clause-building logic lives here) ...

  return { joins, joinParams, whereClauses, whereParams };
}
```

Then simplify `buildNodeQuery`:

```ts
export function buildNodeQuery(filter: NodeQueryFilter, db?: Database.Database): NodeQueryResult {
  const idx = { n: 0 };
  const { joins, joinParams, whereClauses, whereParams } =
    buildFilterClauses(filter, 'n', idx, db);

  // join_filters + without_joins handled in Task 11; for now, no additional clauses.

  const joinSql = joins.length ? ' ' + joins.join(' ') : '';
  const whereSql = whereClauses.length ? ' WHERE ' + whereClauses.join(' AND ') : '';
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body FROM nodes n${joinSql}${whereSql}`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total FROM nodes n${joinSql}${whereSql}`;
  return { sql, countSql, params: [...joinParams, ...whereParams] };
}
```

- [ ] **Step 3: Run tests to confirm no behavior change**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: all PASS (refactor preserves behavior).

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/query-builder.ts
git commit -m "refactor(query-builder): extract buildFilterClauses helper"
```

---

### Task 11: Implement `buildJoinExistsClauses`

**Files:**
- Modify: `src/mcp/query-builder.ts` (add new helper; extend `NodeQueryFilter` + `JoinFilter` interface)
- Test: `tests/mcp/query-builder.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Extend `tests/mcp/query-builder.test.ts` with a new `describe` block:

```ts
describe('join_filters compile to EXISTS clauses', () => {
  beforeEach(() => {
    // Reset and seed: task t1 (status=open) linked to project p1 (status=done),
    // task t2 (status=open) linked to project p2 (status=todo).
    db = createTestDb();

    const ins = db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run('t1', 'Tasks/t1.md', 'T1', '', null, null, null);
    ins.run('t2', 'Tasks/t2.md', 'T2', '', null, null, null);
    ins.run('p1', 'Projects/p1.md', 'P1', '', null, null, null);
    ins.run('p2', 'Projects/p2.md', 'P2', '', null, null, null);

    const ty = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
    ty.run('t1', 'task'); ty.run('t2', 'task'); ty.run('p1', 'project'); ty.run('p2', 'project');

    const fld = db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
    fld.run('t1', 'status', 'open', null, null, null, 'yaml');
    fld.run('t2', 'status', 'open', null, null, null, 'yaml');
    fld.run('p1', 'status', 'done', null, null, null, 'yaml');
    fld.run('p2', 'status', 'todo', null, null, null, 'yaml');

    const rel = db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)');
    rel.run('t1', 'P1', 'project', 'p1');
    rel.run('t2', 'P2', 'project', 'p2');
  });

  it('outgoing join_filter with rel_type only returns tasks that have any project edge', () => {
    const { rows } = runQuery({
      types: ['task'],
      join_filters: [{ rel_type: 'project' }],
    });
    expect(rows.map(r => r.id).sort()).toEqual(['t1', 't2']);
  });

  it('outgoing join_filter with target filter narrows to matching targets', () => {
    const { rows } = runQuery({
      types: ['task'],
      join_filters: [{
        rel_type: 'project',
        target: { fields: { status: { eq: 'done' } } },
      }],
    });
    expect(rows.map(r => r.id)).toEqual(['t1']);
  });

  it('rel_type array compiles to IN and matches any listed type', () => {
    const { rows } = runQuery({
      types: ['task'],
      join_filters: [{ rel_type: ['project', 'parent_project'] }],
    });
    expect(rows.map(r => r.id).sort()).toEqual(['t1', 't2']);
  });

  it('direction: incoming flips edge predicate', () => {
    const { rows } = runQuery({
      types: ['project'],
      join_filters: [{
        direction: 'incoming',
        rel_type: 'project',
        target: { types: ['task'], fields: { status: { eq: 'open' } } },
      }],
    });
    expect(rows.map(r => r.id).sort()).toEqual(['p1', 'p2']);
  });

  it('multiple join_filters AND together (independent matches allowed)', () => {
    // Add assignee relationship on t1 only.
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'People/u1.md', 'U1', '', null, null, null);
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('u1', 'person');
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'role', 'engineer', null, null, null, 'yaml');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)')
      .run('t1', 'U1', 'assignee', 'u1');

    const { rows } = runQuery({
      types: ['task'],
      join_filters: [
        { rel_type: 'project', target: { fields: { status: { eq: 'done' } } } },
        { rel_type: 'assignee', target: { fields: { role: { eq: 'engineer' } } } },
      ],
    });
    expect(rows.map(r => r.id)).toEqual(['t1']);
  });

  it('without_joins compiles to NOT EXISTS', () => {
    const { rows } = runQuery({
      types: ['task'],
      without_joins: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
    });
    expect(rows.map(r => r.id)).toEqual(['t2']);
  });

  it('unresolved edges are invisible to join_filters', () => {
    // Add t3 with an unresolved project edge.
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('t3', 'Tasks/t3.md', 'T3', '', null, null, null);
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('t3', 'task');
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('t3', 'status', 'open', null, null, null, 'yaml');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, NULL)')
      .run('t3', 'GhostProject', 'project');

    const { rows } = runQuery({
      types: ['task'],
      join_filters: [{ rel_type: 'project' }],
    });
    // t3 has only an unresolved edge, so join_filters without target still excludes it.
    expect(rows.map(r => r.id).sort()).toEqual(['t1', 't2']);
  });

  it('JoinFilter with neither rel_type nor target is rejected', () => {
    expect(() => buildNodeQuery({
      join_filters: [{} as JoinFilter],
    }, db)).toThrow(/INVALID_PARAMS/);
  });

  it('alias uniqueness under nesting', () => {
    // Outer types + nested target types: both would want t0, but scoping keeps them unique.
    const { rows } = runQuery({
      types: ['task'],
      fields: { status: { eq: 'open' } },
      join_filters: [{
        rel_type: 'project',
        target: { types: ['project'], fields: { status: { eq: 'done' } } },
      }],
    });
    expect(rows.map(r => r.id)).toEqual(['t1']);
  });
});
```

(Add `import { buildNodeQuery, type JoinFilter } from '../../src/mcp/query-builder.js';` if not already present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: FAIL — interface doesn't yet accept `join_filters`.

- [ ] **Step 3: Extend interfaces and add `buildJoinExistsClauses`**

In `src/mcp/query-builder.ts`:

```ts
export interface JoinFilter {
  direction?: 'outgoing' | 'incoming';
  rel_type?: string | string[];
  target?: NodeQueryFilter;
}

export interface NodeQueryFilter {
  // ... existing fields ...
  join_filters?: JoinFilter[];
  without_joins?: JoinFilter[];
}

function buildJoinExistsClauses(
  filters: JoinFilter[] | undefined,
  parentAlias: string,
  idx: { n: number },
  db: Database.Database | undefined,
  negated: boolean,
): { whereClauses: string[]; whereParams: unknown[] } {
  if (!filters || filters.length === 0) {
    return { whereClauses: [], whereParams: [] };
  }
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  for (const filter of filters) {
    if (!filter.rel_type && !filter.target) {
      throw new Error('INVALID_PARAMS: JoinFilter requires at least one of rel_type or target');
    }

    const direction = filter.direction ?? 'outgoing';
    const relAlias = `r${idx.n++}_${parentAlias}`;
    const targetAlias = `t${idx.n++}_${parentAlias}`;

    const outerCol = direction === 'outgoing' ? 'source_id' : 'resolved_target_id';
    const innerJoinCol = direction === 'outgoing' ? 'resolved_target_id' : 'source_id';

    const subJoins: string[] = [];
    const subJoinParams: unknown[] = [];
    const subWheres: string[] = [
      `${relAlias}.${outerCol} = ${parentAlias}.id`,
      `${relAlias}.resolved_target_id IS NOT NULL`,
    ];
    const subWhereParams: unknown[] = [];

    if (filter.rel_type) {
      const types = Array.isArray(filter.rel_type) ? filter.rel_type : [filter.rel_type];
      if (types.length === 1) {
        subWheres.push(`${relAlias}.rel_type = ?`);
        subWhereParams.push(types[0]);
      } else {
        subWheres.push(`${relAlias}.rel_type IN (${types.map(() => '?').join(', ')})`);
        subWhereParams.push(...types);
      }
    }

    // Build target's own clauses (recursive) at targetAlias.
    let innerJoin = '';
    if (filter.target) {
      innerJoin = `INNER JOIN nodes ${targetAlias} ON ${targetAlias}.id = ${relAlias}.${innerJoinCol}`;
      const targetClauses = buildFilterClauses(filter.target, targetAlias, idx, db);
      subJoins.push(...targetClauses.joins);
      subJoinParams.push(...targetClauses.joinParams);
      subWheres.push(...targetClauses.whereClauses);
      subWhereParams.push(...targetClauses.whereParams);
    }

    const existsSql =
      `SELECT 1 FROM relationships ${relAlias}` +
      (innerJoin ? ` ${innerJoin}` : '') +
      (subJoins.length ? ' ' + subJoins.join(' ') : '') +
      ' WHERE ' + subWheres.join(' AND ');

    whereClauses.push(`${negated ? 'NOT EXISTS' : 'EXISTS'} (${existsSql})`);
    whereParams.push(...subJoinParams, ...subWhereParams);
  }

  return { whereClauses, whereParams };
}
```

Wire it into `buildNodeQuery`:

```ts
export function buildNodeQuery(filter: NodeQueryFilter, db?: Database.Database): NodeQueryResult {
  const idx = { n: 0 };
  const base = buildFilterClauses(filter, 'n', idx, db);

  const joinsFilterClauses = buildJoinExistsClauses(filter.join_filters, 'n', idx, db, false);
  const withoutJoinsClauses = buildJoinExistsClauses(filter.without_joins, 'n', idx, db, true);

  const joins = base.joins;
  const joinParams = base.joinParams;
  const whereClauses = [
    ...base.whereClauses,
    ...joinsFilterClauses.whereClauses,
    ...withoutJoinsClauses.whereClauses,
  ];
  const whereParams = [
    ...base.whereParams,
    ...joinsFilterClauses.whereParams,
    ...withoutJoinsClauses.whereParams,
  ];

  const joinSql = joins.length ? ' ' + joins.join(' ') : '';
  const whereSql = whereClauses.length ? ' WHERE ' + whereClauses.join(' AND ') : '';
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body FROM nodes n${joinSql}${whereSql}`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total FROM nodes n${joinSql}${whereSql}`;
  return { sql, countSql, params: [...joinParams, ...whereParams] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/query-builder.test.ts`
Expected: PASS for all new cases.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/query-builder.ts tests/mcp/query-builder.test.ts
git commit -m "feat(query-builder): add join_filters and without_joins support"
```

---

### Task 12: Extend `query-nodes` zod schema and add `notice` detection

**Files:**
- Modify: `src/mcp/tools/query-nodes.ts` (zod schema, handler, response)
- Test: inline in Task 13's integration tests (end-to-end validates zod + notice together)

- [ ] **Step 1: Extend the zod schema**

In `src/mcp/tools/query-nodes.ts`, add to the `paramsShape` definition (around lines 12–44):

```ts
// Recursive NodeQueryFilter is awkward in zod; define the target schema here
// explicitly without join_filters/without_joins (nested joins deferred).

const fieldFilterSchema = z.object({
  eq: z.unknown().optional(),
  ne: z.unknown().optional(),
  gt: z.unknown().optional(),
  lt: z.unknown().optional(),
  gte: z.unknown().optional(),
  lte: z.unknown().optional(),
  contains: z.string().optional(),
  includes: z.unknown().optional(),
  exists: z.boolean().optional(),
}).strict();

const referenceSchema = z.object({
  target: z.string(),
  rel_type: z.string().optional(),
  direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
});

const targetFilterSchema = z.object({
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), fieldFilterSchema).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  references: referenceSchema.optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  // NOT included: join_filters, without_joins (nested joins deferred)
}).strict();

const joinFilterSchema = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  rel_type: z.union([z.string(), z.array(z.string())]).optional(),
  target: targetFilterSchema.optional(),
}).strict().refine(
  (f) => f.rel_type !== undefined || f.target !== undefined,
  { message: 'INVALID_PARAMS: JoinFilter requires at least one of rel_type or target' },
);
```

Then add to `paramsShape`:

```ts
join_filters: z.array(joinFilterSchema).optional(),
without_joins: z.array(joinFilterSchema).optional(),
```

- [ ] **Step 2: Pass `join_filters` / `without_joins` through to `buildNodeQuery`**

In the handler body (look for where `buildNodeQuery(filter, db)` is called — around line 99+), make sure the filter object includes the new fields:

```ts
const filter: NodeQueryFilter = {
  types: params.types,
  without_types: params.without_types,
  fields: params.fields,
  without_fields: params.without_fields,
  title_eq: params.title_eq,
  title_contains: params.title_contains,
  references: params.references,
  path_prefix: params.path_prefix,
  without_path_prefix: params.without_path_prefix,
  path_dir: params.path_dir,
  modified_since: params.modified_since,
  join_filters: params.join_filters,
  without_joins: params.without_joins,
};
```

(If the handler already destructures `params` into `filter` — just add the two new lines.)

- [ ] **Step 3: Add `notice` detection**

After results are built, add:

```ts
const needsNotice =
  (params.join_filters?.some(f => f.target !== undefined) ?? false) ||
  (params.without_joins?.some(f => f.target !== undefined) ?? false);

let notice: string | undefined;
if (needsNotice) {
  // Collect rel_types that appeared in filters-with-target; null rel_type means "any".
  const relTypes = new Set<string>();
  let anyRelType = false;
  for (const f of [...(params.join_filters ?? []), ...(params.without_joins ?? [])]) {
    if (f.target === undefined) continue;
    if (f.rel_type === undefined) { anyRelType = true; break; }
    const types = Array.isArray(f.rel_type) ? f.rel_type : [f.rel_type];
    for (const t of types) relTypes.add(t);
  }

  let sql = 'SELECT COUNT(*) AS n FROM relationships WHERE resolved_target_id IS NULL';
  const p: unknown[] = [];
  if (!anyRelType && relTypes.size > 0) {
    const placeholders = Array.from(relTypes, () => '?').join(', ');
    sql += ` AND rel_type IN (${placeholders})`;
    p.push(...relTypes);
  }
  const { n } = db.prepare(sql).get(...p) as { n: number };
  if (n > 0) {
    notice = `Cross-node join filters applied. ${n} candidate edge${n === 1 ? '' : 's'} had unresolved targets and were excluded.`;
  }
}

const response: Record<string, unknown> = {
  nodes: enrichedNodes,
  total,
};
if (notice) response.notice = notice;
return toolResult(response);
```

(Adapt `enrichedNodes`, `total`, `toolResult` to whatever the handler currently uses.)

- [ ] **Step 4: Build to catch TS errors**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/query-nodes.ts
git commit -m "feat(mcp): accept join_filters/without_joins on query-nodes with notice"
```

---

### Task 13: Cross-node query integration tests

**Files:**
- Create: `tests/integration/cross-node-query.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/cross-node-query.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

let db: Database.Database;
let vault: string;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function captureHandler() {
  let h!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, cb: (...a: unknown[]) => unknown) => {
      h = (args) => cb(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerQueryNodes(fakeServer, db, vault);
  return h;
}

function seedNode(id: string, filePath: string, title: string, types: string[], fields: Record<string, string>) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, '', null, null, null);
  const ty = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const t of types) ty.run(id, t);
  const fld = db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [k, v] of Object.entries(fields)) fld.run(id, k, v, null, null, null, 'yaml');
}

function seedRel(src: string, target: string, relType: string, resolved: string | null) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
  ).run(src, target, relType, resolved);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'xq-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  // Fixture: tasks + projects + people + companies.
  seedNode('p1', 'Projects/P1.md', 'P1', ['project'], { status: 'done' });
  seedNode('p2', 'Projects/P2.md', 'P2', ['project'], { status: 'todo' });
  seedNode('t1', 'Tasks/T1.md', 'T1', ['task'], { status: 'open' });
  seedNode('t2', 'Tasks/T2.md', 'T2', ['task'], { status: 'open' });
  seedNode('t3', 'Tasks/T3.md', 'T3', ['task'], { status: 'open' });
  seedNode('acme', 'People/Acme.md', 'Acme Corp', ['company'], {});
  seedNode('alice', 'People/Alice.md', 'Alice', ['person'], { company: 'Acme' });
  seedNode('m1', 'Meetings/M1.md', 'M1', ['meeting'], {});
  seedRel('t1', 'P1', 'project', 'p1');
  seedRel('t2', 'P2', 'project', 'p2');
  seedRel('t3', 'GhostProject', 'project', null); // unresolved
  seedRel('m1', 'Alice', 'wiki-link', 'alice');

  handler = captureHandler();
});

afterEach(() => {
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

describe('cross-node query integration', () => {
  it('open tasks whose linked project is done', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      fields: { status: { eq: 'open' } },
      join_filters: [{ rel_type: 'project', target: { types: ['project'], fields: { status: { eq: 'done' } } } }],
    }));
    const ids = (r.nodes as Array<{ node_id: string }>).map(n => n.node_id).sort();
    expect(ids).toEqual(['t1']);
  });

  it('without_joins: tasks with no done-project edge', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      without_joins: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
    }));
    const ids = (r.nodes as Array<{ node_id: string }>).map(n => n.node_id).sort();
    expect(ids).toEqual(['t2', 't3']);
  });

  it('incoming: projects with ≥1 open task', async () => {
    const r = parseResult(await handler({
      types: ['project'],
      join_filters: [{
        direction: 'incoming',
        rel_type: 'project',
        target: { types: ['task'], fields: { status: { eq: 'open' } } },
      }],
    }));
    const ids = (r.nodes as Array<{ node_id: string }>).map(n => n.node_id).sort();
    expect(ids).toEqual(['p1', 'p2']);
  });

  it('no rel_type: meetings linked to any person at Acme', async () => {
    const r = parseResult(await handler({
      types: ['meeting'],
      join_filters: [{
        target: { types: ['person'], fields: { company: { eq: 'Acme' } } },
      }],
    }));
    const ids = (r.nodes as Array<{ node_id: string }>).map(n => n.node_id).sort();
    expect(ids).toEqual(['m1']);
  });

  it('surfaces notice when unresolved edges could have affected results', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
    }));
    expect(r.notice).toContain('unresolved');
    expect((r.notice as string)).toMatch(/1 candidate edge/);
  });

  it('no notice when join_filter has no target (only rel_type filter)', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      join_filters: [{ rel_type: 'project' }],
    }));
    expect(r.notice).toBeUndefined();
  });

  it('composition: top-level fields + join_filters + without_joins in one query', async () => {
    // Add a task linked to a done project AND an engineer assignee — t1 only qualifies.
    seedNode('u1', 'People/U1.md', 'U1', ['person'], { role: 'engineer' });
    seedRel('t1', 'U1', 'assignee', 'u1');
    seedRel('t2', 'U1', 'assignee', 'u1');

    const r = parseResult(await handler({
      types: ['task'],
      fields: { status: { eq: 'open' } },
      join_filters: [
        { rel_type: 'project', target: { fields: { status: { eq: 'done' } } } },
        { rel_type: 'assignee', target: { fields: { role: { eq: 'engineer' } } } },
      ],
      without_joins: [
        { rel_type: 'project', target: { fields: { status: { eq: 'todo' } } } },
      ],
    }));
    const ids = (r.nodes as Array<{ node_id: string }>).map(n => n.node_id).sort();
    expect(ids).toEqual(['t1']);
  });

  it('references still works (backward compat via resolved_target_id internally)', async () => {
    const r = parseResult(await handler({
      references: { target: 'P1', direction: 'outgoing' },
    }));
    const ids = (r.nodes as Array<{ node_id: string }>).map(n => n.node_id).sort();
    expect(ids).toEqual(['t1']);
  });

  it('pagination count is correct with join_filters', async () => {
    const r = parseResult(await handler({
      types: ['task'],
      join_filters: [{ rel_type: 'project' }],
      limit: 1,
    }));
    expect(r.total).toBe(2); // t1 and t2, not t3 (unresolved edge invisible)
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/integration/cross-node-query.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/cross-node-query.test.ts
git commit -m "test(integration): add cross-node query end-to-end tests"
```

---

### Task 14: Update `query-nodes` tool description

**Files:**
- Modify: `src/mcp/tools/query-nodes.ts` (tool description string)

- [ ] **Step 1: Update the tool description**

Find the description string passed to `server.tool(...)` for `query-nodes`. Extend it with:

```
...
Cross-node filtering: `join_filters` constrains results to nodes linked to a target
matching a pattern. `without_joins` excludes them. Each filter specifies a direction
('outgoing' default, or 'incoming'), an optional `rel_type` (string or array for OR),
and an optional `target` (a nested NodeQueryFilter without its own `join_filters`).
Example: open tasks whose linked project is done:
  { "types": ["task"], "fields": { "status": { "eq": "open" } },
    "join_filters": [{ "rel_type": "project",
      "target": { "types": ["project"], "fields": { "status": { "eq": "done" } } } }] }

Differs from `references`: `references` matches by identity (specific target node);
`join_filters` matches by pattern (any node matching the target filter).

When a join filter has a `target`, unresolved edges (raw target text that doesn't
match any node) are invisible to the filter. A `notice` field surfaces in the result
if such edges existed and could have affected the answer.
```

- [ ] **Step 2: Build to ensure no TS errors**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/query-nodes.ts
git commit -m "docs(mcp): document join_filters in query-nodes tool description"
```

---

## Block 3 — `update-node` Query-Mode Inheritance

### Task 15: Extend `update-node` query-mode zod schema

**Files:**
- Modify: `src/mcp/tools/update-node.ts` (zod schema around lines 39–54, dry-run response around line 434+)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/bulk-mutate-join-filters.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../../src/db/schema.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';

let db: Database.Database;
let vault: string;
let cleanup: () => void;
let lock: WriteLockManager;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function seedNode(id: string, file: string, title: string, types: string[], fields: Record<string, string>) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, file, title, '', null, null, null);
  const ty = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const t of types) ty.run(id, t);
  const fld = db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [k, v] of Object.entries(fields)) fld.run(id, k, v, null, null, null, 'yaml');
}

function seedRel(src: string, target: string, relType: string, resolved: string | null) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, NULL, ?)'
  ).run(src, target, relType, resolved);
}

function captureHandler() {
  let h!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, cb: (...a: unknown[]) => unknown) => {
      h = (args) => cb(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerUpdateNode(fakeServer, db, lock, vault);
  return h;
}

beforeEach(() => {
  ({ vaultPath: vault, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  lock = new WriteLockManager();
  // Fixture.
  seedNode('p1', 'Projects/P1.md', 'P1', ['project'], { status: 'done' });
  seedNode('p2', 'Projects/P2.md', 'P2', ['project'], { status: 'todo' });
  seedNode('t1', 'Tasks/T1.md', 'T1', ['task'], { status: 'open' });
  seedNode('t2', 'Tasks/T2.md', 'T2', ['task'], { status: 'open' });
  seedRel('t1', 'P1', 'project', 'p1');
  seedRel('t2', 'P2', 'project', 'p2');

  handler = captureHandler();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node query mode with join_filters', () => {
  it('dry_run with join_filters returns correct affected set + notice', async () => {
    const r = parseResult(await handler({
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['urgent'],
      dry_run: true,
    }));
    expect(r.dry_run).toBe(true);
    expect(r.matched).toBe(1);
    const preview = r.preview as Array<{ node_id: string }>;
    expect(preview.map(p => p.node_id)).toEqual(['t1']);
    expect(r.notice).toMatch(/cross-node join filters/i);
  });

  it('without_joins query mode returns correct affected set', async () => {
    const r = parseResult(await handler({
      query: {
        types: ['task'],
        without_joins: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['deprioritized'],
      dry_run: true,
    }));
    expect(r.matched).toBe(1);
    expect((r.preview as Array<{ node_id: string }>).map(p => p.node_id)).toEqual(['t2']);
  });

  it('dry_run: false applies mutation to exactly the previewed set', async () => {
    // First, check what dry_run returns.
    const dry = parseResult(await handler({
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['urgent'],
      dry_run: true,
    }));
    expect(dry.matched).toBe(1);

    // Apply.
    parseResult(await handler({
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { fields: { status: { eq: 'done' } } } }],
      },
      add_types: ['urgent'],
      dry_run: false,
    }));

    // Only t1 should have 'urgent' type added.
    const types1 = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all('t1') as Array<{ schema_type: string }>;
    const types2 = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all('t2') as Array<{ schema_type: string }>;
    expect(types1.map(t => t.schema_type).sort()).toContain('urgent');
    expect(types2.map(t => t.schema_type)).not.toContain('urgent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/bulk-mutate-join-filters.test.ts`
Expected: FAIL — query-mode zod schema doesn't accept `join_filters` / `without_joins`.

- [ ] **Step 3: Extend the zod schema for query mode**

In `src/mcp/tools/update-node.ts`, find the query zod schema (around lines 39–54) and extend with:

```ts
// Define locally to avoid coupling two MCP tool modules.

const _fieldFilterSchema = z.object({
  eq: z.unknown().optional(),
  ne: z.unknown().optional(),
  gt: z.unknown().optional(),
  lt: z.unknown().optional(),
  gte: z.unknown().optional(),
  lte: z.unknown().optional(),
  contains: z.string().optional(),
  includes: z.unknown().optional(),
  exists: z.boolean().optional(),
}).strict();

const _targetFilterSchema = z.object({
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), _fieldFilterSchema).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  references: z.object({
    target: z.string(),
    rel_type: z.string().optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  }).optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
}).strict();

const _joinFilterSchema = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  rel_type: z.union([z.string(), z.array(z.string())]).optional(),
  target: _targetFilterSchema.optional(),
}).strict().refine(
  (f) => f.rel_type !== undefined || f.target !== undefined,
  { message: 'INVALID_PARAMS: JoinFilter requires at least one of rel_type or target' },
);
```

Then in the existing `query` zod schema, add:

```ts
query: z.object({
  // ... existing fields ...
  join_filters: z.array(_joinFilterSchema).optional(),
  without_joins: z.array(_joinFilterSchema).optional(),
}).optional(),
```

- [ ] **Step 4: Pass them through to `buildNodeQuery`**

Find where `buildNodeQuery(query, db)` is called (around line 310). The existing `query` object is already passed straight through — if zod parsed the new fields, they'll be on the object. No extra wiring needed beyond the schema change.

- [ ] **Step 5: Emit the bulk notice in dry-run**

In `handleDryRun()` (around line 434+), after computing `matchedNodes.length` and the preview, add:

```ts
const hasJoinFilters =
  (query?.join_filters?.length ?? 0) > 0 || (query?.without_joins?.length ?? 0) > 0;

const response: Record<string, unknown> = {
  dry_run: true,
  matched: matchedNodes.length,
  preview,
  would_update: countUpdate,
  would_skip: countSkip,
  would_fail: countFail,
  batch_id: batchId,
};
if (hasJoinFilters) {
  response.notice = 'Bulk mutation via cross-node join filters — review affected set carefully.';
}
return toolResult(response);
```

(Adapt to actual variable names in `handleDryRun`.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/integration/bulk-mutate-join-filters.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/update-node.ts tests/integration/bulk-mutate-join-filters.test.ts
git commit -m "feat(mcp): inherit join_filters on update-node query mode with bulk notice"
```

---

### Task 16: Update `update-node` tool description

**Files:**
- Modify: `src/mcp/tools/update-node.ts` (tool description)

- [ ] **Step 1: Extend the description**

Find the `server.tool(...)` description string for update-node and add:

```
...
Query mode accepts `join_filters` and `without_joins` (same shape as query-nodes).
Example — bump all tasks whose project is done to priority high:
  { "query": { "types": ["task"],
    "join_filters": [{ "rel_type": "project",
      "target": { "fields": { "status": { "eq": "done" } } } }] },
    "set_fields": { "priority": "high" },
    "dry_run": true }

Dry-run responses include a `notice` when join filters are present, flagging the
caller to review the affected set. Dry-run defaults to true in query mode.
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/update-node.ts
git commit -m "docs(mcp): document join_filters in update-node tool description"
```

---

## Final Verification

### Task 17: Full-suite green + smoke test

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: exits 0 with no errors.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all PASS, including every test added by this plan plus every pre-existing test.

- [ ] **Step 3: Spot-check against the live vault (smoke)**

Against the production DB (read-only spot-check; DO NOT mutate):

Run (from a shell): `VAULT_PATH=/path/to/vault npm run dev` in a terminal, then use the MCP inspector or an interactive client to issue:

```json
// tier-1 charter query
{ "tool": "query-nodes", "args": {
  "types": ["task"],
  "fields": { "status": { "eq": "open" } },
  "join_filters": [{ "rel_type": "project",
    "target": { "types": ["project"], "fields": { "status": { "eq": "done" } } } }]
}}
```

Expected: returns a reasonable number of tasks. Eyeball against spot checks in Obsidian. Note the `notice` count.

```json
// without_joins
{ "tool": "query-nodes", "args": {
  "types": ["task"],
  "without_joins": [{ "rel_type": "project",
    "target": { "fields": { "status": { "eq": "done" } } } }]
}}
```

Expected: returns tasks *without* a done-project edge, including tasks with no project at all.

```json
// bulk dry-run
{ "tool": "update-node", "args": {
  "query": { "types": ["task"],
    "join_filters": [{ "rel_type": "project",
      "target": { "fields": { "status": { "eq": "done" } } } }] },
  "add_types": ["archive-candidate"],
  "dry_run": true
}}
```

Expected: dry-run response includes `notice`, `matched`, and a sensible preview.

Do not proceed to `dry_run: false` during smoke — verify the preview looks right manually.

- [ ] **Step 4: Final commit (if any smoke-fixes were needed) and summary**

No further commits if everything works. Otherwise, commit fixes with descriptive messages.

End of plan.

---

## Plan Self-Review Notes

- **Spec coverage:** Every numbered item in the spec's Phasing & Delivery section maps to a task (or cluster of tasks) above. Block 1 covers Tasks 1–9. Block 2 covers Tasks 10–14. Block 3 covers Tasks 15–16. Testing blocks in the spec map to the test files created in each task.
- **Known gap (acknowledged in spec):** Delete re-resolution and "better match supersedes on create" are v1 limitations, implemented as documented. Task 5 tests the no-supersede behavior explicitly so future-us knows when it was last verified.
- **Type consistency:** `JoinFilter`, `NodeQueryFilter`, `buildFilterClauses`, `buildJoinExistsClauses`, `CURRENT_RESOLVED_TARGETS_VERSION`, `refreshOnCreate`/`Rename`/`Delete`, `backfillResolvedTargets` — all names consistent across tasks.
- **Watcher + reconciler wiring:** Covered indirectly. Both call `deleteNodeByPath` (modified in Task 8) and `processFileChange` → `doIndex` (modified in Task 6). Watcher/reconciler create + rename paths go through `executeMutation` via the indexer + pipeline-aware code paths — confirm during Task 7 tests.
- **Bulk-mutate inheritance:** Explicitly confirmed — `batch-mutate.ts` calls `executeMutation`, so refresh helpers fire automatically. No separate task needed.
