# Phase 1 Implementation Plan — Core Data Model and Read Path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an indexed, queryable vault with 8 read-only MCP tools, file watcher, and reconciler.

**Architecture:** Markdown files are parsed into a SQLite database with stable nanoid node IDs. Relationships store raw target strings and resolve at query time. The file watcher and periodic reconciler keep the DB in sync with disk changes. MCP tools query the DB directly.

**Tech Stack:** TypeScript (ESM), better-sqlite3, unified/remark/remark-gfm/remark-frontmatter, yaml, chokidar, nanoid, vitest

**Spec:** `docs/superpowers/specs/2026-04-10-phase1-design.md`

**Branch:** `phase-1`

---

## File Structure

### New files to create

```
src/db/schema.ts              — createSchema(db), all DDL
src/parser/types.ts            — YamlValue, WikiLink, ParsedNode interfaces
src/parser/frontmatter.ts      — YAML parsing, frontmatter wiki-link extraction
src/parser/wiki-links.ts       — remark plugin for body wiki-links
src/parser/parse.ts            — main parseMarkdown(raw, filePath) function
src/parser/index.ts            — re-exports
src/indexer/indexer.ts         — fullIndex, indexFile, deleteNode
src/indexer/ignore.ts          — shouldIgnore(filePath) predicate
src/indexer/hash.ts            — SHA-256 content hashing
src/indexer/index.ts           — re-exports
src/resolver/resolve.ts        — resolveTarget(db, rawTarget) four-tier lookup
src/mcp/tools/vault-stats.ts   — vault-stats tool
src/mcp/tools/list-types.ts    — list-types tool
src/mcp/tools/query-nodes.ts   — query-nodes tool (dynamic SQL builder)
src/mcp/tools/get-node.ts      — get-node tool
src/mcp/tools/list-schemas.ts  — list-schemas tool
src/mcp/tools/describe-schema.ts — describe-schema tool
src/mcp/tools/list-global-fields.ts — list-global-fields tool
src/mcp/tools/describe-global-field.ts — describe-global-field tool
src/mcp/tools/errors.ts        — ToolError class, error codes
src/mcp/tools/index.ts         — registerAllTools(server, db)
src/sync/watcher.ts            — file watcher with debounce
src/sync/reconciler.ts         — periodic fullIndex runner
src/sync/mutex.ts              — IndexMutex with queue, dedup, onIdle
src/sync/write-lock.ts         — withLock / isLocked scaffolding
src/sync/index.ts              — re-exports
tests/fixtures/vault/          — fixture .md files (13 files)
tests/helpers/db.ts            — createTestDb() in-memory helper
tests/helpers/vault.ts         — createTempVault() helper
tests/db/schema.test.ts
tests/parser/parse.test.ts
tests/indexer/indexer.test.ts
tests/resolver/resolve.test.ts
tests/mcp/tools.test.ts
tests/sync/watcher.test.ts
tests/sync/write-lock.test.ts
tests/integration/end-to-end.test.ts
```

### Existing files to modify

```
src/index.ts                   — add VAULT_PATH env, fullIndex at startup, watcher, reconciler
src/mcp/server.ts              — replace stub with registerAllTools
src/db/connection.ts           — no changes needed
src/transport/args.ts           — no changes needed
package.json                   — add remark-gfm, nanoid dependencies
```

---

## Task 1: Feature Branch and Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b phase-1
```

- [ ] **Step 2: Install new dependencies**

```bash
npm install remark-gfm nanoid
```

- [ ] **Step 3: Add vitest config for test:perf script**

Add to `package.json` scripts:

```json
"test:perf": "vitest run tests/perf/"
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add remark-gfm and nanoid dependencies for Phase 1"
```

---

## Task 2: SQLite Schema

**Files:**
- Create: `src/db/schema.ts`
- Test: `tests/db/schema.test.ts`
- Test helper: `tests/helpers/db.ts`

- [ ] **Step 1: Create test helper for in-memory DB**

Create `tests/helpers/db.ts`:

```typescript
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  return db;
}
```

- [ ] **Step 2: Write failing tests for schema**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createSchema } from '../../src/db/schema.js';

describe('createSchema', () => {
  it('creates all required tables', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('nodes');
    expect(names).toContain('node_types');
    expect(names).toContain('global_fields');
    expect(names).toContain('schemas');
    expect(names).toContain('node_fields');
    expect(names).toContain('relationships');
    expect(names).toContain('edits_log');
    expect(names).toContain('embeddings');
  });

  it('creates nodes_fts virtual table', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('enforces nodes.file_path uniqueness', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('id1', 'test.md', 'Test', '', 'hash1', 1000, 1000);

    expect(() =>
      db.prepare(
        "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('id2', 'test.md', 'Test 2', '', 'hash2', 1000, 1000)
    ).toThrow();
  });

  it('cascades node deletion to node_types', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare("INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)").run('n1', 'note');

    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');

    const types = db.prepare("SELECT * FROM node_types WHERE node_id = ?").all('n1');
    expect(types).toHaveLength(0);
  });

  it('cascades node deletion to node_fields', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare(
      "INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)"
    ).run('n1', 'project', 'Vault Engine', 'frontmatter');

    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');

    const fields = db.prepare("SELECT * FROM node_fields WHERE node_id = ?").all('n1');
    expect(fields).toHaveLength(0);
  });

  it('cascades node deletion to relationships', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)"
    ).run('n1', 'Other Note', 'wiki-link');

    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');

    const rels = db.prepare("SELECT * FROM relationships WHERE source_id = ?").all('n1');
    expect(rels).toHaveLength(0);
  });

  it('enforces relationship uniqueness on (source_id, target, rel_type)', () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('n1', 'test.md', 'Test', '', 'hash', 1000, 1000);
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)"
    ).run('n1', 'Other', 'wiki-link');

    expect(() =>
      db.prepare(
        "INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)"
      ).run('n1', 'Other', 'wiki-link')
    ).toThrow();
  });

  it('is idempotent (calling createSchema twice does not error)', () => {
    const db = createTestDb();
    expect(() => createSchema(db)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/db/schema.test.ts
```

Expected: FAIL — `src/db/schema.ts` does not exist.

- [ ] **Step 4: Implement createSchema**

Create `src/db/schema.ts`:

```typescript
import type Database from 'better-sqlite3';

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      title TEXT,
      body TEXT,
      content_hash TEXT,
      file_mtime INTEGER,
      indexed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS node_types (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      schema_type TEXT NOT NULL,
      PRIMARY KEY (node_id, schema_type)
    );
    CREATE INDEX IF NOT EXISTS idx_node_types_schema_type ON node_types(schema_type);

    CREATE TABLE IF NOT EXISTS global_fields (
      name TEXT PRIMARY KEY,
      field_type TEXT NOT NULL,
      enum_values TEXT,
      reference_target TEXT,
      description TEXT,
      default_value TEXT
    );

    CREATE TABLE IF NOT EXISTS schemas (
      name TEXT PRIMARY KEY,
      display_name TEXT,
      icon TEXT,
      filename_template TEXT,
      field_claims TEXT NOT NULL DEFAULT '[]',
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS node_fields (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_date TEXT,
      value_json TEXT,
      source TEXT NOT NULL DEFAULT 'frontmatter',
      PRIMARY KEY (node_id, field_name)
    );
    CREATE INDEX IF NOT EXISTS idx_node_fields_field_name ON node_fields(field_name);
    CREATE INDEX IF NOT EXISTS idx_node_fields_value_number ON node_fields(value_number);
    CREATE INDEX IF NOT EXISTS idx_node_fields_value_date ON node_fields(value_date);

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      context TEXT,
      UNIQUE(source_id, target, rel_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source_id ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
    CREATE INDEX IF NOT EXISTS idx_relationships_rel_type ON relationships(rel_type);

    CREATE TABLE IF NOT EXISTS edits_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      content_text TEXT,
      embedded_at INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      title,
      body,
      content='',
      contentless_delete=1
    );
  `);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- tests/db/schema.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts tests/helpers/db.ts
git commit -m "feat: add SQLite schema with all Phase 1 tables and FTS5"
```

---

## Task 3: Test Fixture Vault

**Files:**
- Create: 13 fixture files in `tests/fixtures/vault/`
- Create: `tests/helpers/vault.ts`

- [ ] **Step 1: Create fixture files**

Create `tests/fixtures/vault/plain-no-frontmatter.md`:

```markdown
# A Plain Note

This file has no YAML frontmatter at all. Just body content.

It references [[Some Other Note]] in the body.
```

Create `tests/fixtures/vault/multi-type.md`:

```markdown
---
title: Project Kickoff Meeting
types:
  - meeting
  - note
date: "[[2026-03-15]]"
project: "[[Vault Engine]]"
priority: 1
attendees:
  - "[[Alice]]"
  - "[[Bob]]"
---

# Project Kickoff Meeting

Discussion about the new vault engine architecture.

We agreed to use [[SQLite]] as the database backend.
```

Create `tests/fixtures/vault/frontmatter-wikilinks.md`:

```markdown
---
title: Frontmatter Links Test
types:
  - note
project: "[[Vault Engine]]"
people:
  - "[[Alice]]"
  - "[[Bob]]"
company: "[[Acme Corp]]"
---

Body content with no wiki-links here.
```

Create `tests/fixtures/vault/body-wikilinks.md`:

```markdown
---
title: Body Links Test
types:
  - note
---

This note links to [[Alice Smith]] and also to [[Bob Jones|Bob]].

Another paragraph mentioning [[Vault Engine]] again.
```

Create `tests/fixtures/vault/code-block-links.md`:

````markdown
---
title: Code Block Test
types:
  - note
---

Real link to [[Alice Smith]] here.

```javascript
// This [[Fake Link]] should NOT be extracted
const x = "[[Another Fake]]";
```

Another real link to [[Bob Jones]].
````

Create `tests/fixtures/vault/malformed-yaml.md`:

```markdown
---
title: "Broken YAML
types: [note
this is not valid yaml
---

Body content after malformed frontmatter.
```

Create `tests/fixtures/vault/gfm-tables.md`:

```markdown
---
title: GFM Table Test
types:
  - note
---

| Name | Role |
|------|------|
| [[Alice]] | Lead |
| [[Bob]] | Dev |

- [x] Completed task
- [ ] Pending task with [[Charlie]] assigned
```

Create `tests/fixtures/vault/unicode-title.md`:

```markdown
---
title: "Cafe\u0301 Meeting \u2014 \u6771\u4eac"
types:
  - meeting
---

Meeting notes with unicode characters.
```

Create `tests/fixtures/vault/alias-wikilink.md`:

```markdown
---
title: Alias Test
types:
  - note
contact: "[[Alice Smith|our contact]]"
---

Body references [[Bob Jones|BJ]] as well.
```

Create `tests/fixtures/vault/nested/deep/path/note.md`:

```markdown
---
title: Deeply Nested Note
types:
  - note
---

A note in a deeply nested directory.
```

Create `tests/fixtures/vault/references-target.md`:

```markdown
---
title: References Target
types:
  - project
status: active
---

This node is the target of links from other fixtures.
```

Create `tests/fixtures/vault/dangling-reference.md`:

```markdown
---
title: Dangling Ref Test
types:
  - note
related: "[[Nonexistent Note]]"
---

This links to [[Another Missing Page]] which does not exist.
```

Create `tests/fixtures/vault/empty-frontmatter.md`:

```markdown
---
---

Body content after empty frontmatter block.
```

- [ ] **Step 2: Create temp vault helper**

Create `tests/helpers/vault.ts`:

```typescript
import { mkdirSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_VAULT = join(__dirname, '..', 'fixtures', 'vault');

export function createTempVault(): { vaultPath: string; cleanup: () => void } {
  const vaultPath = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
  cpSync(FIXTURE_VAULT, vaultPath, { recursive: true });
  return {
    vaultPath,
    cleanup: () => rmSync(vaultPath, { recursive: true, force: true }),
  };
}

export function addFileToVault(vaultPath: string, relativePath: string, content: string): void {
  const fullPath = join(vaultPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

export { FIXTURE_VAULT };
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/vault/ tests/helpers/vault.ts
git commit -m "feat: add test fixture vault and temp vault helper"
```

---

## Task 4: Parser — Types and Frontmatter

**Files:**
- Create: `src/parser/types.ts`
- Create: `src/parser/frontmatter.ts`
- Test: `tests/parser/parse.test.ts` (first section)

- [ ] **Step 1: Create parser type definitions**

Create `src/parser/types.ts`:

```typescript
export type YamlValue =
  | string
  | number
  | boolean
  | Date
  | null
  | YamlValue[]
  | Record<string, YamlValue>;

export interface WikiLink {
  target: string;
  alias: string | null;
  context: string;
}

export interface ParsedNode {
  title: string | null;
  types: string[];
  fields: Map<string, YamlValue>;
  body: string;
  wikiLinks: WikiLink[];
  parseError: string | null;
}
```

- [ ] **Step 2: Write failing tests for frontmatter parsing**

Create `tests/parser/parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_VAULT } from '../helpers/vault.js';
import { parseMarkdown } from '../../src/parser/parse.js';

function parseFixture(name: string): ReturnType<typeof parseMarkdown> {
  const content = readFileSync(join(FIXTURE_VAULT, name), 'utf-8');
  return parseMarkdown(content, name);
}

describe('parseMarkdown', () => {
  describe('frontmatter extraction', () => {
    it('extracts types as string array', () => {
      const result = parseFixture('multi-type.md');
      expect(result.types).toEqual(['meeting', 'note']);
    });

    it('extracts title from frontmatter', () => {
      const result = parseFixture('multi-type.md');
      expect(result.title).toBe('Project Kickoff Meeting');
    });

    it('preserves native JS types from YAML', () => {
      const result = parseFixture('multi-type.md');
      expect(result.fields.get('priority')).toBe(1);
      expect(typeof result.fields.get('priority')).toBe('number');
    });

    it('preserves arrays in fields', () => {
      const result = parseFixture('multi-type.md');
      const attendees = result.fields.get('attendees');
      expect(Array.isArray(attendees)).toBe(true);
      expect(attendees).toEqual(['Alice', 'Bob']);
    });

    it('strips wiki-link brackets from string field values', () => {
      const result = parseFixture('multi-type.md');
      expect(result.fields.get('project')).toBe('Vault Engine');
    });

    it('strips wiki-link brackets from date field values', () => {
      const result = parseFixture('multi-type.md');
      expect(result.fields.get('date')).toBe('2026-03-15');
    });

    it('does not include title or types in fields map', () => {
      const result = parseFixture('multi-type.md');
      expect(result.fields.has('title')).toBe(false);
      expect(result.fields.has('types')).toBe(false);
    });

    it('returns empty types for no frontmatter', () => {
      const result = parseFixture('plain-no-frontmatter.md');
      expect(result.types).toEqual([]);
      expect(result.fields.size).toBe(0);
    });

    it('returns empty types for empty frontmatter', () => {
      const result = parseFixture('empty-frontmatter.md');
      expect(result.types).toEqual([]);
      expect(result.fields.size).toBe(0);
    });

    it('returns parseError for malformed YAML', () => {
      const result = parseFixture('malformed-yaml.md');
      expect(result.parseError).not.toBeNull();
      expect(result.types).toEqual([]);
      expect(result.fields.size).toBe(0);
    });

    it('preserves body content on malformed YAML', () => {
      const result = parseFixture('malformed-yaml.md');
      expect(result.body).toContain('Body content after malformed frontmatter');
    });

    it('handles aliased wiki-link in frontmatter field', () => {
      const result = parseFixture('alias-wikilink.md');
      expect(result.fields.get('contact')).toBe('Alice Smith');
    });
  });

  describe('title resolution', () => {
    it('uses frontmatter title when present', () => {
      const result = parseFixture('multi-type.md');
      expect(result.title).toBe('Project Kickoff Meeting');
    });

    it('falls back to first H1 when no frontmatter title', () => {
      const result = parseFixture('plain-no-frontmatter.md');
      expect(result.title).toBe('A Plain Note');
    });

    it('falls back to filename when no title or H1', () => {
      const result = parseFixture('empty-frontmatter.md');
      expect(result.title).toBe('empty-frontmatter');
    });
  });

  describe('body extraction', () => {
    it('separates body from frontmatter', () => {
      const result = parseFixture('multi-type.md');
      expect(result.body).not.toContain('types:');
      expect(result.body).toContain('Discussion about the new vault engine architecture');
    });

    it('uses entire content as body when no frontmatter', () => {
      const result = parseFixture('plain-no-frontmatter.md');
      expect(result.body).toContain('# A Plain Note');
      expect(result.body).toContain('This file has no YAML frontmatter');
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/parser/parse.test.ts
```

Expected: FAIL — `src/parser/parse.ts` does not exist.

- [ ] **Step 4: Implement frontmatter parsing**

Create `src/parser/frontmatter.ts`:

```typescript
import { parse as parseYaml } from 'yaml';
import type { YamlValue, WikiLink } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface FrontmatterResult {
  title: string | null;
  types: string[];
  fields: Map<string, YamlValue>;
  wikiLinks: WikiLink[];
  parseError: string | null;
}

export function parseFrontmatter(yamlString: string): FrontmatterResult {
  const result: FrontmatterResult = {
    title: null,
    types: [],
    fields: new Map(),
    wikiLinks: [],
    parseError: null,
  };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(yamlString);
  } catch (err) {
    result.parseError = err instanceof Error ? err.message : String(err);
    return result;
  }

  if (parsed == null || typeof parsed !== 'object') {
    return result;
  }

  // Extract title
  if (typeof parsed.title === 'string') {
    result.title = stripWikiLinks(parsed.title);
  }

  // Extract types
  if (Array.isArray(parsed.types)) {
    result.types = parsed.types.filter((t): t is string => typeof t === 'string');
  } else if (typeof parsed.types === 'string') {
    result.types = [parsed.types];
  }

  // Extract fields (everything except title and types)
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'title' || key === 'types') continue;
    const processed = processFieldValue(value as YamlValue, key, result.wikiLinks);
    result.fields.set(key, processed);
  }

  return result;
}

function processFieldValue(value: YamlValue, fieldName: string, wikiLinks: WikiLink[]): YamlValue {
  if (typeof value === 'string') {
    return processStringValue(value, fieldName, wikiLinks);
  }
  if (Array.isArray(value)) {
    return value.map(item => processFieldValue(item, fieldName, wikiLinks));
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, YamlValue> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = processFieldValue(v, fieldName, wikiLinks);
    }
    return result;
  }
  return value;
}

function processStringValue(value: string, fieldName: string, wikiLinks: WikiLink[]): string {
  const matches = [...value.matchAll(WIKI_LINK_RE)];
  for (const match of matches) {
    const target = match[1].trim();
    const alias = match[2]?.trim() ?? null;
    wikiLinks.push({ target, alias, context: fieldName });
  }
  return stripWikiLinks(value);
}

function stripWikiLinks(value: string): string {
  return value.replace(WIKI_LINK_RE, (_, target) => target.trim());
}
```

- [ ] **Step 5: Run tests to verify they still fail (parse.ts not yet created)**

```bash
npm test -- tests/parser/parse.test.ts
```

Expected: FAIL — `src/parser/parse.ts` does not exist.

- [ ] **Step 6: Commit frontmatter module**

```bash
git add src/parser/types.ts src/parser/frontmatter.ts
git commit -m "feat: add parser types and frontmatter extraction"
```

---

## Task 5: Parser — Wiki-Link Plugin and Main Parse Function

**Files:**
- Create: `src/parser/wiki-links.ts`
- Create: `src/parser/parse.ts`
- Create: `src/parser/index.ts`
- Test: `tests/parser/parse.test.ts` (add remaining tests)

- [ ] **Step 1: Add wiki-link and combined tests to the test file**

Append these describe blocks to `tests/parser/parse.test.ts`, inside the outer `describe('parseMarkdown')`:

```typescript
  describe('body wiki-link extraction', () => {
    it('extracts simple wiki-links from body', () => {
      const result = parseFixture('body-wikilinks.md');
      const bodyLinks = result.wikiLinks.filter(l =>
        !['project', 'people', 'company', 'contact', 'related', 'date', 'attendees'].includes(l.context)
      );
      expect(bodyLinks.map(l => l.target)).toContain('Alice Smith');
      expect(bodyLinks.map(l => l.target)).toContain('Bob Jones');
      expect(bodyLinks.map(l => l.target)).toContain('Vault Engine');
    });

    it('extracts alias from aliased body wiki-links', () => {
      const result = parseFixture('body-wikilinks.md');
      const bobLink = result.wikiLinks.find(l => l.target === 'Bob Jones');
      expect(bobLink).toBeDefined();
      expect(bobLink!.alias).toBe('Bob');
    });

    it('does NOT extract wiki-links from fenced code blocks', () => {
      const result = parseFixture('code-block-links.md');
      const targets = result.wikiLinks.map(l => l.target);
      expect(targets).toContain('Alice Smith');
      expect(targets).toContain('Bob Jones');
      expect(targets).not.toContain('Fake Link');
      expect(targets).not.toContain('Another Fake');
    });

    it('extracts wiki-links from GFM table cells', () => {
      const result = parseFixture('gfm-tables.md');
      const targets = result.wikiLinks.map(l => l.target);
      expect(targets).toContain('Alice');
      expect(targets).toContain('Bob');
      expect(targets).toContain('Charlie');
    });

    it('provides context for body wiki-links', () => {
      const result = parseFixture('body-wikilinks.md');
      const aliceLink = result.wikiLinks.find(l => l.target === 'Alice Smith');
      expect(aliceLink).toBeDefined();
      expect(aliceLink!.context).toBeTruthy();
      expect(typeof aliceLink!.context).toBe('string');
    });
  });

  describe('frontmatter wiki-link extraction', () => {
    it('extracts wiki-links from frontmatter string values', () => {
      const result = parseFixture('frontmatter-wikilinks.md');
      const fmLinks = result.wikiLinks.filter(l => l.context === 'project');
      expect(fmLinks).toHaveLength(1);
      expect(fmLinks[0].target).toBe('Vault Engine');
    });

    it('extracts wiki-links from frontmatter arrays', () => {
      const result = parseFixture('frontmatter-wikilinks.md');
      const peopleLinks = result.wikiLinks.filter(l => l.context === 'people');
      expect(peopleLinks).toHaveLength(2);
      expect(peopleLinks.map(l => l.target)).toEqual(['Alice', 'Bob']);
    });

    it('extracts alias from frontmatter wiki-link', () => {
      const result = parseFixture('alias-wikilink.md');
      const contactLink = result.wikiLinks.find(l => l.context === 'contact');
      expect(contactLink).toBeDefined();
      expect(contactLink!.target).toBe('Alice Smith');
      expect(contactLink!.alias).toBe('our contact');
    });
  });

  describe('combined wiki-links', () => {
    it('collects both frontmatter and body wiki-links', () => {
      const result = parseFixture('multi-type.md');
      const targets = result.wikiLinks.map(l => l.target);
      expect(targets).toContain('Vault Engine');
      expect(targets).toContain('Alice');
      expect(targets).toContain('Bob');
      expect(targets).toContain('SQLite');
    });
  });

  describe('unicode handling', () => {
    it('preserves unicode in title', () => {
      const result = parseFixture('unicode-title.md');
      expect(result.title).toContain('Caf');
      expect(result.title).toContain('\u6771\u4eac');
    });
  });
```

- [ ] **Step 2: Implement wiki-link remark plugin**

Create `src/parser/wiki-links.ts`:

```typescript
import type { Root, Text, Parent } from 'mdast';
import type { WikiLink } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function extractBodyWikiLinks(tree: Root): WikiLink[] {
  const links: WikiLink[] = [];
  visitTextNodes(tree, (text, parentContext) => {
    for (const match of text.matchAll(WIKI_LINK_RE)) {
      links.push({
        target: match[1].trim(),
        alias: match[2]?.trim() ?? null,
        context: parentContext,
      });
    }
  });
  return links;
}

function visitTextNodes(
  node: Root | Parent,
  visitor: (text: string, context: string) => void,
  parentContext: string = '',
): void {
  for (const child of node.children) {
    // Skip code blocks and inline code
    if (child.type === 'code' || child.type === 'inlineCode') continue;
    // Skip YAML frontmatter node
    if (child.type === 'yaml') continue;

    if (child.type === 'text') {
      const ctx = parentContext || getParentContext(node);
      visitor((child as Text).value, ctx);
    } else if ('children' in child) {
      const ctx = parentContext || getParentContext(node);
      visitTextNodes(child as Parent, visitor, ctx);
    }
  }
}

function getParentContext(node: Root | Parent): string {
  const texts: string[] = [];
  collectText(node, texts, 200);
  return texts.join('').trim();
}

function collectText(node: Root | Parent, texts: string[], limit: number): void {
  for (const child of node.children) {
    if (texts.join('').length >= limit) return;
    if (child.type === 'text') {
      texts.push((child as Text).value);
    } else if (child.type === 'code' || child.type === 'inlineCode' || child.type === 'yaml') {
      // skip
    } else if ('children' in child) {
      collectText(child as Parent, texts, limit);
    }
  }
}
```

- [ ] **Step 3: Implement main parse function**

Create `src/parser/parse.ts`:

```typescript
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { Root, Yaml, Heading, Text } from 'mdast';
import { parseFrontmatter } from './frontmatter.js';
import { extractBodyWikiLinks } from './wiki-links.js';
import type { ParsedNode } from './types.js';
import { basename } from 'node:path';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm);

export function parseMarkdown(raw: string, filePath: string): ParsedNode {
  const tree = processor.parse(raw) as Root;

  // Extract YAML frontmatter node
  const yamlNode = tree.children.find((n): n is Yaml => n.type === 'yaml');
  const yamlString = yamlNode?.value ?? '';

  // Parse frontmatter
  const fm = parseFrontmatter(yamlString);

  // Extract body (everything after frontmatter)
  const body = extractBody(raw, yamlNode);

  // Extract body wiki-links from AST (separate code path from frontmatter)
  const bodyWikiLinks = extractBodyWikiLinks(tree);

  // Resolve title: frontmatter -> first H1 -> filename
  let title = fm.title;
  if (title == null) {
    title = extractFirstH1(tree);
  }
  if (title == null) {
    title = basename(filePath, '.md');
  }

  return {
    title,
    types: fm.types,
    fields: fm.fields,
    body,
    wikiLinks: [...fm.wikiLinks, ...bodyWikiLinks],
    parseError: fm.parseError,
  };
}

function extractBody(raw: string, yamlNode: Yaml | undefined): string {
  if (!yamlNode) return raw;

  const endOffset = yamlNode.position?.end?.offset;
  if (endOffset == null) return raw;

  // Skip past the closing ---
  let bodyStart = endOffset;
  const rest = raw.slice(bodyStart);
  const closingMatch = rest.match(/^---\r?\n?/);
  if (closingMatch) {
    bodyStart += closingMatch[0].length;
  }

  return raw.slice(bodyStart).trim();
}

function extractFirstH1(tree: Root): string | null {
  for (const child of tree.children) {
    if (child.type === 'heading' && (child as Heading).depth === 1) {
      const heading = child as Heading;
      const texts: string[] = [];
      for (const c of heading.children) {
        if (c.type === 'text') texts.push((c as Text).value);
      }
      if (texts.length > 0) return texts.join('');
    }
  }
  return null;
}
```

- [ ] **Step 4: Create parser barrel export**

Create `src/parser/index.ts`:

```typescript
export { parseMarkdown } from './parse.js';
export type { ParsedNode, WikiLink, YamlValue } from './types.js';
```

- [ ] **Step 5: Run all parser tests**

```bash
npm test -- tests/parser/parse.test.ts
```

Expected: all PASS. If any fail, fix the implementation.

- [ ] **Step 6: Commit**

```bash
git add src/parser/ tests/parser/parse.test.ts
git commit -m "feat: add markdown parser with frontmatter and wiki-link extraction"
```

---

## Task 6: Indexer — Core Implementation

**Files:**
- Create: `src/indexer/hash.ts`
- Create: `src/indexer/ignore.ts`
- Create: `src/indexer/indexer.ts`
- Create: `src/indexer/index.ts`
- Test: `tests/indexer/indexer.test.ts`

- [ ] **Step 1: Create hash utility**

Create `src/indexer/hash.ts`:

```typescript
import { createHash } from 'node:crypto';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
```

- [ ] **Step 2: Create ignore predicate**

Create `src/indexer/ignore.ts`:

```typescript
const IGNORED_DIRS = new Set([
  '.vault-engine',
  '.schemas',
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
]);

export function shouldIgnore(relativePath: string): boolean {
  if (!relativePath.endsWith('.md')) return true;
  if (relativePath.includes('.sync-conflict-')) return true;

  const segments = relativePath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '.') return true;
    if (IGNORED_DIRS.has(segment)) return true;
  }

  return false;
}
```

- [ ] **Step 3: Write failing indexer tests**

Create `tests/indexer/indexer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex, indexFile } from '../../src/indexer/indexer.js';
import { createTempVault } from '../helpers/vault.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  const tmp = createTempVault();
  vaultPath = tmp.vaultPath;
  cleanup = tmp.cleanup;
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('fullIndex', () => {
  it('indexes all fixture files', async () => {
    await fullIndex(vaultPath, db);
    const count = (db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count;
    expect(count).toBe(13);
  });

  it('generates stable nanoid IDs', async () => {
    await fullIndex(vaultPath, db);
    const nodes = db.prepare('SELECT id, file_path FROM nodes').all() as { id: string; file_path: string }[];
    for (const node of nodes) {
      expect(node.id).toBeTruthy();
      expect(node.id.length).toBeGreaterThan(0);
      expect(node.file_path).toBeTruthy();
    }
  });

  it('preserves IDs on re-index', async () => {
    await fullIndex(vaultPath, db);
    const before = db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as { id: string; file_path: string }[];

    await fullIndex(vaultPath, db);
    const after = db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as { id: string; file_path: string }[];

    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].id).toBe(before[i].id);
      expect(after[i].file_path).toBe(before[i].file_path);
    }
  });

  it('stores types in node_types table', async () => {
    await fullIndex(vaultPath, db);
    const multiTypeNode = db.prepare("SELECT id FROM nodes WHERE file_path LIKE '%multi-type.md'").get() as { id: string };
    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type')
      .all(multiTypeNode.id) as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'note']);
  });

  it('stores string fields in value_text', async () => {
    await fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path LIKE '%frontmatter-wikilinks.md'").get() as { id: string };
    const field = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.id, 'company') as { value_text: string };
    expect(field.value_text).toBe('Acme Corp');
  });

  it('stores numeric fields in value_number', async () => {
    await fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path LIKE '%multi-type.md'").get() as { id: string };
    const field = db.prepare('SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(node.id, 'priority') as { value_number: number };
    expect(field.value_number).toBe(1);
  });

  it('stores relationships with raw target strings', async () => {
    await fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path LIKE '%body-wikilinks.md'").get() as { id: string };
    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ? ORDER BY target')
      .all(node.id) as { target: string; rel_type: string }[];
    const wikiLinks = rels.filter(r => r.rel_type === 'wiki-link');
    expect(wikiLinks.map(r => r.target)).toContain('Alice Smith');
    expect(wikiLinks.map(r => r.target)).toContain('Bob Jones');
    expect(wikiLinks.map(r => r.target)).toContain('Vault Engine');
  });

  it('stores frontmatter references with field name as rel_type', async () => {
    await fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path LIKE '%frontmatter-wikilinks.md'").get() as { id: string };
    const projectRels = db.prepare("SELECT target FROM relationships WHERE source_id = ? AND rel_type = 'project'")
      .all(node.id) as { target: string }[];
    expect(projectRels.map(r => r.target)).toContain('Vault Engine');
  });

  it('detects deleted files on re-index', async () => {
    await fullIndex(vaultPath, db);
    const countBefore = (db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count;

    unlinkSync(join(vaultPath, 'plain-no-frontmatter.md'));

    await fullIndex(vaultPath, db);
    const countAfter = (db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count;
    expect(countAfter).toBe(countBefore - 1);
  });

  it('skips unchanged files on re-index (mtime check)', async () => {
    await fullIndex(vaultPath, db);

    const node = db.prepare("SELECT id, indexed_at FROM nodes WHERE file_path LIKE '%references-target.md'")
      .get() as { id: string; indexed_at: number };

    await fullIndex(vaultPath, db);

    const nodeAfter = db.prepare('SELECT indexed_at FROM nodes WHERE id = ?')
      .get(node.id) as { indexed_at: number };

    expect(nodeAfter.indexed_at).toBe(node.indexed_at);
  });

  it('writes edits_log entries', async () => {
    await fullIndex(vaultPath, db);
    const logs = db.prepare('SELECT event_type FROM edits_log').all() as { event_type: string }[];
    expect(logs.some(l => l.event_type === 'file-indexed')).toBe(true);
  });

  it('populates FTS5 index', async () => {
    await fullIndex(vaultPath, db);
    const results = db.prepare(
      "SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'architecture'"
    ).all();
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles malformed YAML without crashing', async () => {
    await fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id, title FROM nodes WHERE file_path LIKE '%malformed-yaml.md'")
      .get() as { id: string; title: string };
    expect(node).toBeDefined();
    expect(node.title).toBe('malformed-yaml');
  });
});

describe('indexFile', () => {
  it('indexes a single file', async () => {
    await indexFile(join(vaultPath, 'multi-type.md'), vaultPath, db);
    const count = (db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count;
    expect(count).toBe(1);
  });

  it('re-indexes a changed file preserving ID', async () => {
    await indexFile(join(vaultPath, 'multi-type.md'), vaultPath, db);
    const before = db.prepare('SELECT id FROM nodes').get() as { id: string };

    writeFileSync(join(vaultPath, 'multi-type.md'), '---\ntitle: Updated\ntypes:\n  - note\n---\nNew body.');

    await indexFile(join(vaultPath, 'multi-type.md'), vaultPath, db);
    const after = db.prepare('SELECT id, title FROM nodes').get() as { id: string; title: string };

    expect(after.id).toBe(before.id);
    expect(after.title).toBe('Updated');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
npm test -- tests/indexer/indexer.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Implement the indexer**

Create `src/indexer/indexer.ts`:

```typescript
import type Database from 'better-sqlite3';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, basename as pathBasename } from 'node:path';
import { nanoid } from 'nanoid';
import { parseMarkdown } from '../parser/parse.js';
import { sha256 } from './hash.js';
import { shouldIgnore } from './ignore.js';
import type { YamlValue } from '../parser/types.js';

const BATCH_SIZE = 100;

export async function fullIndex(vaultPath: string, db: Database.Database): Promise<void> {
  const diskPaths = new Set<string>();
  walkDir(vaultPath, vaultPath, diskPaths);

  // Delete nodes not on disk
  const dbPaths = db.prepare('SELECT id, file_path FROM nodes').all() as { id: string; file_path: string }[];
  const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');
  const logEvent = db.prepare(
    'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)'
  );
  const deleteFts = db.prepare('DELETE FROM nodes_fts WHERE rowid = ?');

  for (const row of dbPaths) {
    if (!diskPaths.has(row.file_path)) {
      const rowid = getRowid(db, row.id);
      db.transaction(() => {
        if (rowid != null) deleteFts.run(rowid);
        deleteNode.run(row.id);
        logEvent.run(row.id, Date.now(), 'file-deleted', JSON.stringify({ file_path: row.file_path }));
      })();
    }
  }

  // Index new/changed files in batches
  const allPaths = [...diskPaths];
  for (let i = 0; i < allPaths.length; i += BATCH_SIZE) {
    const batch = allPaths.slice(i, i + BATCH_SIZE);
    db.transaction(() => {
      for (const filePath of batch) {
        try {
          indexFileInTransaction(join(vaultPath, filePath), filePath, db, true);
        } catch (err) {
          logEvent.run(
            null,
            Date.now(),
            'index-error',
            JSON.stringify({ file_path: filePath, error: String(err) })
          );
        }
      }
    })();
  }
}

export async function indexFile(
  absolutePath: string,
  vaultPath: string,
  db: Database.Database,
): Promise<void> {
  const filePath = relative(vaultPath, absolutePath);
  db.transaction(() => {
    indexFileInTransaction(absolutePath, filePath, db, false);
  })();
}

export function deleteNodeByPath(filePath: string, db: Database.Database): void {
  const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string } | undefined;
  if (!node) return;

  const rowid = getRowid(db, node.id);
  db.transaction(() => {
    if (rowid != null) {
      db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowid);
    }
    db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)'
    ).run(node.id, Date.now(), 'file-deleted', JSON.stringify({ file_path: filePath }));
  })();
}

function indexFileInTransaction(
  absolutePath: string,
  filePath: string,
  db: Database.Database,
  checkMtime: boolean,
): void {
  const stat = statSync(absolutePath);
  const fileMtime = Math.floor(stat.mtimeMs);

  if (checkMtime) {
    const existing = db.prepare('SELECT id, file_mtime, content_hash FROM nodes WHERE file_path = ?')
      .get(filePath) as { id: string; file_mtime: number; content_hash: string } | undefined;

    if (existing && existing.file_mtime === fileMtime) {
      return;
    }

    const raw = readFileSync(absolutePath, 'utf-8');
    const hash = sha256(raw);

    if (existing && existing.content_hash === hash) {
      db.prepare('UPDATE nodes SET file_mtime = ? WHERE id = ?').run(fileMtime, existing.id);
      return;
    }

    doIndex(raw, hash, fileMtime, filePath, db, existing?.id);
    return;
  }

  const raw = readFileSync(absolutePath, 'utf-8');
  const hash = sha256(raw);
  const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?')
    .get(filePath) as { id: string } | undefined;
  doIndex(raw, hash, fileMtime, filePath, db, existing?.id);
}

function doIndex(
  raw: string,
  hash: string,
  fileMtime: number,
  filePath: string,
  db: Database.Database,
  existingId: string | undefined,
): void {
  const parsed = parseMarkdown(raw, filePath);
  const nodeId = existingId ?? nanoid();
  const now = Date.now();

  // Delete existing data if re-indexing
  if (existingId) {
    const rowid = getRowid(db, existingId);
    if (rowid != null) {
      db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowid);
    }
    db.prepare('DELETE FROM node_types WHERE node_id = ?').run(existingId);
    db.prepare('DELETE FROM node_fields WHERE node_id = ?').run(existingId);
    db.prepare('DELETE FROM relationships WHERE source_id = ?').run(existingId);
  }

  // Upsert node
  db.prepare(`
    INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      title = excluded.title,
      body = excluded.body,
      content_hash = excluded.content_hash,
      file_mtime = excluded.file_mtime,
      indexed_at = excluded.indexed_at
  `).run(nodeId, filePath, parsed.title, parsed.body, hash, fileMtime, now);

  // Insert into FTS
  const rowid = getRowid(db, nodeId);
  if (rowid != null) {
    db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)')
      .run(rowid, parsed.title ?? '', parsed.body);
  }

  // Insert types
  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const type of parsed.types) {
    insertType.run(nodeId, type);
  }

  // Insert fields
  const insertField = db.prepare(`
    INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source)
    VALUES (?, ?, ?, ?, ?, ?, 'frontmatter')
  `);
  for (const [key, value] of parsed.fields) {
    const { text, number: num, date, json } = classifyValue(value);
    insertField.run(nodeId, key, text, num, date, json);
  }

  // Insert relationships
  const insertRel = db.prepare(`
    INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context)
    VALUES (?, ?, ?, ?)
  `);
  for (const link of parsed.wikiLinks) {
    const isFieldName = parsed.fields.has(link.context);
    const relType = isFieldName ? link.context : 'wiki-link';
    insertRel.run(nodeId, link.target, relType, link.context);
  }

  // Log
  db.prepare(
    'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)'
  ).run(nodeId, now, 'file-indexed', JSON.stringify({
    file_path: filePath,
    parse_error: parsed.parseError,
  }));
}

function classifyValue(value: YamlValue): {
  text: string | null;
  number: number | null;
  date: string | null;
  json: string | null;
} {
  if (typeof value === 'string') {
    return { text: value, number: null, date: null, json: null };
  }
  if (typeof value === 'number') {
    return { text: null, number: value, date: null, json: null };
  }
  if (value instanceof Date) {
    return { text: null, number: null, date: value.toISOString().slice(0, 10), json: null };
  }
  return { text: null, number: null, date: null, json: JSON.stringify(value) };
}

function getRowid(db: Database.Database, nodeId: string): number | null {
  const row = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(nodeId) as { rowid: number } | undefined;
  return row?.rowid ?? null;
}

function walkDir(dir: string, vaultRoot: string, result: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(vaultRoot, fullPath);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walkDir(fullPath, vaultRoot, result);
      }
    } else if (!shouldIgnore(relPath)) {
      result.add(relPath);
    }
  }
}
```

- [ ] **Step 6: Create indexer barrel export**

Create `src/indexer/index.ts`:

```typescript
export { fullIndex, indexFile, deleteNodeByPath } from './indexer.js';
export { shouldIgnore } from './ignore.js';
export { sha256 } from './hash.js';
```

- [ ] **Step 7: Run indexer tests**

```bash
npm test -- tests/indexer/indexer.test.ts
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/indexer/ tests/indexer/indexer.test.ts
git commit -m "feat: add indexer with fullIndex, indexFile, change detection, and FTS5 sync"
```

---

## Task 7: Target Resolver

**Files:**
- Create: `src/resolver/resolve.ts`
- Test: `tests/resolver/resolve.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/resolver/resolve.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { resolveTarget } from '../../src/resolver/resolve.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  const insert = db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insert.run('n1', 'Notes/Alice Smith.md', 'Alice Smith', '', 'h1', 1000, 1000);
  insert.run('n2', 'Notes/Bob Jones.md', 'Bob Jones', '', 'h2', 1000, 1000);
  insert.run('n3', 'Projects/Vault Engine.md', 'Vault Engine', '', 'h3', 1000, 1000);
  insert.run('n4', 'Notes/caf\u00e9.md', 'Caf\u00e9 Notes', '', 'h4', 1000, 1000);
  insert.run('n5', 'Archive/Old/Meeting.md', 'Meeting', '', 'h5', 1000, 1000);
  insert.run('n6', 'Notes/Meeting.md', 'Meeting', '', 'h6', 1000, 1000);
});

describe('resolveTarget', () => {
  it('resolves exact file_path match', () => {
    const result = resolveTarget(db, 'Notes/Alice Smith.md');
    expect(result).toEqual({ id: 'n1', title: 'Alice Smith' });
  });

  it('resolves basename match (without .md)', () => {
    const result = resolveTarget(db, 'Alice Smith');
    expect(result).toEqual({ id: 'n1', title: 'Alice Smith' });
  });

  it('resolves case-insensitive basename match', () => {
    const result = resolveTarget(db, 'alice smith');
    expect(result).toEqual({ id: 'n1', title: 'Alice Smith' });
  });

  it('resolves Unicode NFC-normalized match', () => {
    const result = resolveTarget(db, 'cafe\u0301');
    expect(result).toEqual({ id: 'n4', title: 'Caf\u00e9 Notes' });
  });

  it('resolves ambiguous basename to shortest path', () => {
    const result = resolveTarget(db, 'Meeting');
    expect(result).toEqual({ id: 'n6', title: 'Meeting' });
  });

  it('returns null for unresolvable target', () => {
    const result = resolveTarget(db, 'Nonexistent Note');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/resolver/resolve.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement resolver**

Create `src/resolver/resolve.ts`:

```typescript
import type Database from 'better-sqlite3';
import { basename } from 'node:path';

export interface ResolvedTarget {
  id: string;
  title: string | null;
}

export function resolveTarget(db: Database.Database, rawTarget: string): ResolvedTarget | null {
  // Tier 1: Exact file_path match
  const exact = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?')
    .get(rawTarget) as ResolvedTarget | undefined;
  if (exact) return exact;

  const allNodes = db.prepare('SELECT id, file_path, title FROM nodes')
    .all() as { id: string; file_path: string; title: string | null }[];

  const target = rawTarget.endsWith('.md') ? rawTarget.slice(0, -3) : rawTarget;

  // Tier 2: Exact basename match
  const exactBasename = allNodes.filter(n => basename(n.file_path, '.md') === target);
  if (exactBasename.length === 1) return { id: exactBasename[0].id, title: exactBasename[0].title };
  if (exactBasename.length > 1) return pickShortest(exactBasename);

  // Tier 3: Case-insensitive basename match
  const targetLower = target.toLowerCase();
  const caseInsensitive = allNodes.filter(n => basename(n.file_path, '.md').toLowerCase() === targetLower);
  if (caseInsensitive.length === 1) return { id: caseInsensitive[0].id, title: caseInsensitive[0].title };
  if (caseInsensitive.length > 1) return pickShortest(caseInsensitive);

  // Tier 4: Unicode NFC-normalized case-insensitive match
  const targetNormalized = target.normalize('NFC').toLowerCase();
  const normalized = allNodes.filter(n =>
    basename(n.file_path, '.md').normalize('NFC').toLowerCase() === targetNormalized
  );
  if (normalized.length === 1) return { id: normalized[0].id, title: normalized[0].title };
  if (normalized.length > 1) return pickShortest(normalized);

  return null;
}

function pickShortest(
  candidates: { id: string; file_path: string; title: string | null }[],
): ResolvedTarget {
  const sorted = candidates.sort((a, b) => a.file_path.length - b.file_path.length);
  return { id: sorted[0].id, title: sorted[0].title };
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/resolver/resolve.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resolver/ tests/resolver/resolve.test.ts
git commit -m "feat: add four-tier target resolver with Unicode NFC normalization"
```

---

## Task 8: MCP Tools — Error Types and Simple Tools

**Files:**
- Create: `src/mcp/tools/errors.ts`
- Create: `src/mcp/tools/vault-stats.ts`
- Create: `src/mcp/tools/list-types.ts`
- Create: `src/mcp/tools/list-schemas.ts`
- Create: `src/mcp/tools/describe-schema.ts`
- Create: `src/mcp/tools/list-global-fields.ts`
- Create: `src/mcp/tools/describe-global-field.ts`
- Test: `tests/mcp/tools.test.ts`

- [ ] **Step 1: Create error types**

Create `src/mcp/tools/errors.ts`:

```typescript
export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR';

export function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function toolErrorResult(code: ErrorCode, message: string) {
  return toolResult({ error: message, code });
}
```

- [ ] **Step 2: Write failing tests for simple tools**

Create `tests/mcp/tools.test.ts`. This file tests all tools. It uses a helper that captures the handler function registered via `server.tool()`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { registerListTypes } from '../../src/mcp/tools/list-types.js';
import { registerListSchemas } from '../../src/mcp/tools/list-schemas.js';
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';
import { registerListGlobalFields } from '../../src/mcp/tools/list-global-fields.js';
import { registerDescribeGlobalField } from '../../src/mcp/tools/describe-global-field.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let db: Database.Database;

function parseToolResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// Captures the handler from a register function
function getToolHandler(registerFn: (server: McpServer, db: Database.Database) => void) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db);
  return capturedHandler!;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

function seedTestData() {
  const insertNode = db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertNode.run('n1', 'meeting.md', 'Team Meeting', 'body1', 'h1', 1000, 1000);
  insertNode.run('n2', 'note.md', 'Quick Note', 'body2', 'h2', 2000, 2000);
  insertNode.run('n3', 'task.md', 'Fix Bug', 'body3', 'h3', 3000, 3000);

  db.prepare('INSERT INTO node_types VALUES (?, ?)').run('n1', 'meeting');
  db.prepare('INSERT INTO node_types VALUES (?, ?)').run('n1', 'note');
  db.prepare('INSERT INTO node_types VALUES (?, ?)').run('n2', 'note');
  db.prepare('INSERT INTO node_types VALUES (?, ?)').run('n3', 'task');

  db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, 'frontmatter')")
    .run('n1', 'project', 'Vault Engine');
  db.prepare("INSERT INTO node_fields (node_id, field_name, value_number, source) VALUES (?, ?, ?, 'frontmatter')")
    .run('n3', 'priority', 1);
  db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, 'orphan')")
    .run('n2', 'old_field', 'leftover');

  db.prepare("INSERT INTO relationships (source_id, target, rel_type) VALUES (?, ?, ?)")
    .run('n1', 'Quick Note', 'wiki-link');
}

describe('vault-stats', () => {
  it('returns correct counts', async () => {
    seedTestData();
    const handler = getToolHandler(registerVaultStats);
    const result = parseToolResult(await handler({})) as Record<string, unknown>;
    expect(result.node_count).toBe(3);
    expect(result.relationship_count).toBe(1);
    expect(result.orphan_count).toBe(1);
    expect(result.schema_count).toBe(0);
  });

  it('returns zero counts on empty DB', async () => {
    const handler = getToolHandler(registerVaultStats);
    const result = parseToolResult(await handler({})) as Record<string, unknown>;
    expect(result.node_count).toBe(0);
  });
});

describe('list-types', () => {
  it('returns types with counts', async () => {
    seedTestData();
    const handler = getToolHandler(registerListTypes);
    const result = parseToolResult(await handler({})) as Array<{ type: string; count: number }>;
    expect(result).toContainEqual({ type: 'meeting', count: 1 });
    expect(result).toContainEqual({ type: 'note', count: 2 });
    expect(result).toContainEqual({ type: 'task', count: 1 });
  });

  it('returns empty array on empty DB', async () => {
    const handler = getToolHandler(registerListTypes);
    const result = parseToolResult(await handler({})) as unknown[];
    expect(result).toEqual([]);
  });
});

describe('list-schemas', () => {
  it('returns empty array when no schemas defined', async () => {
    const handler = getToolHandler(registerListSchemas);
    const result = parseToolResult(await handler({})) as unknown[];
    expect(result).toEqual([]);
  });
});

describe('describe-schema', () => {
  it('returns NOT_FOUND for nonexistent schema', async () => {
    const handler = getToolHandler(registerDescribeSchema);
    const result = parseToolResult(await handler({ name: 'meeting' })) as Record<string, unknown>;
    expect(result.code).toBe('NOT_FOUND');
  });
});

describe('list-global-fields', () => {
  it('returns empty array when no global fields defined', async () => {
    const handler = getToolHandler(registerListGlobalFields);
    const result = parseToolResult(await handler({})) as unknown[];
    expect(result).toEqual([]);
  });
});

describe('describe-global-field', () => {
  it('returns NOT_FOUND for nonexistent field', async () => {
    const handler = getToolHandler(registerDescribeGlobalField);
    const result = parseToolResult(await handler({ name: 'due_date' })) as Record<string, unknown>;
    expect(result.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/mcp/tools.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement all simple tools**

Create `src/mcp/tools/vault-stats.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';

export function registerVaultStats(server: McpServer, db: Database.Database): void {
  server.tool(
    'vault-stats',
    'Returns vault statistics: node counts, type counts, field counts, relationship counts, schema counts.',
    {},
    async () => {
      const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
      const typeCounts = db.prepare(
        'SELECT schema_type as type, COUNT(*) as count FROM node_types GROUP BY schema_type ORDER BY schema_type'
      ).all();
      const fieldCount = (db.prepare('SELECT COUNT(DISTINCT field_name) as c FROM node_fields').get() as { c: number }).c;
      const relationshipCount = (db.prepare('SELECT COUNT(*) as c FROM relationships').get() as { c: number }).c;
      const orphanCount = (db.prepare("SELECT COUNT(*) as c FROM node_fields WHERE source = 'orphan'").get() as { c: number }).c;
      const schemaCount = (db.prepare('SELECT COUNT(*) as c FROM schemas').get() as { c: number }).c;

      return toolResult({
        node_count: nodeCount,
        type_counts: typeCounts,
        field_count: fieldCount,
        relationship_count: relationshipCount,
        orphan_count: orphanCount,
        schema_count: schemaCount,
      });
    },
  );
}
```

Create `src/mcp/tools/list-types.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';

export function registerListTypes(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-types',
    'Lists all distinct types found in node frontmatter with their node counts.',
    {},
    async () => {
      const types = db.prepare(
        'SELECT schema_type as type, COUNT(*) as count FROM node_types GROUP BY schema_type ORDER BY schema_type'
      ).all();
      return toolResult(types);
    },
  );
}
```

Create `src/mcp/tools/list-schemas.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';

export function registerListSchemas(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-schemas',
    'Lists all formal schema definitions. Returns empty array if no schemas are defined yet. Use list-types to see what types exist in frontmatter.',
    {},
    async () => {
      const schemas = db.prepare('SELECT name, display_name, icon FROM schemas ORDER BY name').all();
      return toolResult(schemas);
    },
  );
}
```

Create `src/mcp/tools/describe-schema.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult, toolErrorResult } from './errors.js';
import { z } from 'zod';

export function registerDescribeSchema(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-schema',
    'Returns the full definition of a named schema including its field claims.',
    { name: z.string().describe('Schema name to describe') },
    async ({ name }) => {
      const schema = db.prepare('SELECT * FROM schemas WHERE name = ?').get(name);
      if (!schema) return toolErrorResult('NOT_FOUND', `Schema '${name}' not found`);
      const parsed = schema as Record<string, unknown>;
      if (typeof parsed.field_claims === 'string') parsed.field_claims = JSON.parse(parsed.field_claims as string);
      if (typeof parsed.metadata === 'string' && parsed.metadata) parsed.metadata = JSON.parse(parsed.metadata as string);
      return toolResult(parsed);
    },
  );
}
```

Create `src/mcp/tools/list-global-fields.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';

export function registerListGlobalFields(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-global-fields',
    'Lists all fields in the global field pool with their types. Returns empty array if no global fields are defined.',
    {},
    async () => {
      const fields = db.prepare('SELECT name, field_type, description FROM global_fields ORDER BY name').all();
      return toolResult(fields);
    },
  );
}
```

Create `src/mcp/tools/describe-global-field.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult, toolErrorResult } from './errors.js';
import { z } from 'zod';

export function registerDescribeGlobalField(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-global-field',
    'Returns the full definition of a named global field.',
    { name: z.string().describe('Field name to describe') },
    async ({ name }) => {
      const field = db.prepare('SELECT * FROM global_fields WHERE name = ?').get(name);
      if (!field) return toolErrorResult('NOT_FOUND', `Global field '${name}' not found`);
      const parsed = field as Record<string, unknown>;
      if (typeof parsed.enum_values === 'string' && parsed.enum_values) parsed.enum_values = JSON.parse(parsed.enum_values as string);
      if (typeof parsed.default_value === 'string' && parsed.default_value) parsed.default_value = JSON.parse(parsed.default_value as string);
      return toolResult(parsed);
    },
  );
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/mcp/tools.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/ tests/mcp/tools.test.ts
git commit -m "feat: add vault-stats, list-types, and schema/global-field introspection tools"
```

---

## Task 9: MCP Tools — query-nodes and get-node

**Files:**
- Create: `src/mcp/tools/query-nodes.ts`
- Create: `src/mcp/tools/get-node.ts`
- Test: `tests/mcp/tools.test.ts` (extend)

- [ ] **Step 1: Add query-nodes and get-node tests**

Append to `tests/mcp/tools.test.ts`, adding these imports at the top:

```typescript
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
```

And these describe blocks:

```typescript
describe('query-nodes', () => {
  beforeEach(() => seedTestData());

  it('returns all nodes with no filters', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({})) as { nodes: unknown[]; total: number };
    expect(result.total).toBe(3);
    expect(result.nodes).toHaveLength(3);
  });

  it('filters by type', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({ types: ['meeting'] })) as { nodes: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by multiple types (intersection)', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({ types: ['meeting', 'note'] })) as { nodes: unknown[]; total: number };
    expect(result.total).toBe(1);
  });

  it('filters by field equality', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({
      fields: { project: { eq: 'Vault Engine' } },
    })) as { nodes: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('filters by numeric field comparison', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({
      fields: { priority: { lte: 2 } },
    })) as { nodes: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n3');
  });

  it('filters by field exists', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({
      fields: { priority: { exists: true } },
    })) as { nodes: unknown[]; total: number };
    expect(result.total).toBe(1);
  });

  it('supports pagination with limit and offset', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const page1 = parseToolResult(await handler({ limit: 2, offset: 0 })) as { nodes: unknown[]; total: number };
    expect(page1.nodes).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = parseToolResult(await handler({ limit: 2, offset: 2 })) as { nodes: unknown[]; total: number };
    expect(page2.nodes).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it('supports sort_by and sort_order', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({
      sort_by: 'file_mtime',
      sort_order: 'desc',
    })) as { nodes: Array<{ file_path: string }> };
    expect(result.nodes[0].file_path).toBe('task.md');
  });

  it('supports path_prefix filter', async () => {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('n4', 'Projects/readme.md', 'Readme', '', 'h4', 4000, 4000);

    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({ path_prefix: 'Projects/' })) as { nodes: unknown[]; total: number };
    expect(result.total).toBe(1);
  });

  it('supports FTS5 full_text search', async () => {
    const nodes = db.prepare('SELECT rowid, title, body FROM nodes').all() as { rowid: number; title: string; body: string }[];
    for (const n of nodes) {
      db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(n.rowid, n.title, n.body);
    }

    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({ full_text: 'Bug' })) as { nodes: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n3');
  });

  it('supports outgoing reference filter', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({
      references: { target: 'Quick Note', direction: 'outgoing' },
    })) as { nodes: Array<{ id: string }>; total: number };
    expect(result.total).toBe(1);
    expect(result.nodes[0].id).toBe('n1');
  });

  it('enforces max limit of 200', async () => {
    const handler = getToolHandler(registerQueryNodes);
    const result = parseToolResult(await handler({ limit: 500 })) as { nodes: unknown[] };
    expect(result.nodes.length).toBeLessThanOrEqual(200);
  });
});

describe('get-node', () => {
  beforeEach(() => seedTestData());

  it('retrieves node by node_id', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ node_id: 'n1' })) as Record<string, unknown>;
    expect(result.id).toBe('n1');
    expect(result.title).toBe('Team Meeting');
  });

  it('retrieves node by file_path', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ file_path: 'meeting.md' })) as Record<string, unknown>;
    expect(result.id).toBe('n1');
  });

  it('retrieves node by title', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ title: 'Team Meeting' })) as Record<string, unknown>;
    expect(result.id).toBe('n1');
  });

  it('returns INVALID_PARAMS when no params given', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({})) as Record<string, unknown>;
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('returns INVALID_PARAMS when multiple params given', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ node_id: 'n1', title: 'Team Meeting' })) as Record<string, unknown>;
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('returns NOT_FOUND for missing node', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ node_id: 'nonexistent' })) as Record<string, unknown>;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('returns fields with typed values', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ node_id: 'n1' })) as { fields: Record<string, { value: unknown; type: string; source: string }> };
    expect(result.fields.project.value).toBe('Vault Engine');
    expect(result.fields.project.type).toBe('text');
    expect(result.fields.project.source).toBe('frontmatter');
  });

  it('returns types array', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ node_id: 'n1' })) as { types: string[] };
    expect(result.types).toContain('meeting');
    expect(result.types).toContain('note');
  });

  it('returns grouped outgoing relationships', async () => {
    const handler = getToolHandler(registerGetNode);
    const result = parseToolResult(await handler({ node_id: 'n1' })) as {
      relationships: { outgoing: Record<string, unknown[]> };
    };
    expect(result.relationships.outgoing['wiki-link']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/mcp/tools.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement query-nodes**

Create `src/mcp/tools/query-nodes.ts`. This is the most complex tool — it builds SQL dynamically with parameterized queries:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';
import { z } from 'zod';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function registerQueryNodes(server: McpServer, db: Database.Database): void {
  server.tool(
    'query-nodes',
    'Query nodes with structured filters: types, fields (eq/gt/lt/gte/lte/contains/exists), full-text search, references, path prefix, modified_since. Supports pagination and sorting.',
    {
      types: z.array(z.string()).optional().describe('Filter by type (intersection)'),
      fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('Field filters'),
      full_text: z.string().optional().describe('FTS5 full-text search'),
      references: z.object({
        target: z.string(),
        rel_type: z.string().optional(),
        direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
      }).optional().describe('Filter by relationship'),
      path_prefix: z.string().optional(),
      modified_since: z.string().optional(),
      sort_by: z.string().optional(),
      sort_order: z.enum(['asc', 'desc']).default('asc').optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    },
    async (args) => {
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const offset = args.offset ?? 0;
      const sortOrder = args.sort_order ?? 'asc';

      const whereClauses: string[] = [];
      const params: unknown[] = [];
      const joins: string[] = [];
      let joinIdx = 0;

      // Type filter (intersection)
      if (args.types && args.types.length > 0) {
        for (const type of args.types) {
          const alias = `nt${joinIdx++}`;
          joins.push(`INNER JOIN node_types ${alias} ON ${alias}.node_id = n.id AND ${alias}.schema_type = ?`);
          params.push(type);
        }
      }

      // Field filters
      if (args.fields) {
        for (const [fieldName, ops] of Object.entries(args.fields)) {
          const opsObj = ops as Record<string, unknown>;
          const alias = `nf${joinIdx++}`;

          if ('exists' in opsObj) {
            if (opsObj.exists) {
              joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
            } else {
              joins.push(`LEFT JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
              whereClauses.push(`${alias}.node_id IS NULL`);
            }
            params.push(fieldName);
            continue;
          }

          joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
          params.push(fieldName);

          for (const [op, value] of Object.entries(opsObj)) {
            const { column, sqlOp } = resolveFilterColumn(op, value, alias);
            whereClauses.push(`${column} ${sqlOp} ?`);
            params.push(value);
          }
        }
      }

      // FTS5
      if (args.full_text) {
        joins.push(`INNER JOIN nodes_fts ON nodes_fts.rowid = n.rowid`);
        whereClauses.push(`nodes_fts MATCH ?`);
        params.push(args.full_text);
      }

      // Reference filter
      if (args.references) {
        const { target, rel_type, direction } = args.references;
        const dir = direction ?? 'outgoing';

        if (dir === 'outgoing' || dir === 'both') {
          const alias = `r_out${joinIdx++}`;
          let joinClause = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target = ?`;
          joins.push(joinClause);
          params.push(target);
          if (rel_type) {
            whereClauses.push(`${alias}.rel_type = ?`);
            params.push(rel_type);
          }
        }
        if (dir === 'incoming') {
          // Find nodes that are targets of relationships with matching target string
          // The node's title or basename must match the target parameter
          whereClauses.push(`(n.title = ? OR n.file_path LIKE ?)`);
          params.push(target, `%${target}.md`);
          whereClauses.push(`EXISTS (SELECT 1 FROM relationships r WHERE r.target = ? AND r.source_id != n.id)`);
          params.push(target);
        }
      }

      // Path prefix
      if (args.path_prefix) {
        whereClauses.push(`n.file_path LIKE ?`);
        params.push(`${args.path_prefix}%`);
      }

      // Modified since
      if (args.modified_since) {
        const ms = new Date(args.modified_since).getTime();
        whereClauses.push(`n.file_mtime >= ?`);
        params.push(ms);
      }

      // Sort
      let orderBy = 'n.title ASC';
      if (args.sort_by) {
        const builtins = ['title', 'file_mtime', 'indexed_at'];
        if (builtins.includes(args.sort_by)) {
          orderBy = `n.${args.sort_by} ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;
        }
      }

      const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const joinStr = joins.join('\n');

      // Count
      const countSql = `SELECT COUNT(DISTINCT n.id) as total FROM nodes n ${joinStr} ${whereStr}`;
      const total = (db.prepare(countSql).get(...params) as { total: number }).total;

      // Data
      const dataSql = `
        SELECT DISTINCT n.id, n.file_path, n.title, n.file_mtime, n.indexed_at
        FROM nodes n ${joinStr} ${whereStr}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?
      `;
      const rows = db.prepare(dataSql).all(...params, limit, offset) as Array<{
        id: string; file_path: string; title: string | null;
      }>;

      const getTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?');
      const getFieldCount = db.prepare('SELECT COUNT(*) as c FROM node_fields WHERE node_id = ?');

      const nodes = rows.map(row => ({
        id: row.id,
        file_path: row.file_path,
        title: row.title,
        types: (getTypes.all(row.id) as { schema_type: string }[]).map(t => t.schema_type),
        field_count: (getFieldCount.get(row.id) as { c: number }).c,
      }));

      return toolResult({ nodes, total });
    },
  );
}

function resolveFilterColumn(op: string, value: unknown, alias: string): { column: string; sqlOp: string } {
  if (op === 'contains') return { column: `${alias}.value_text`, sqlOp: 'LIKE' };

  if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
    const isDate = typeof value === 'string' && ISO_DATE_RE.test(value);
    const column = isDate ? `${alias}.value_date` : `${alias}.value_number`;
    const sqlOps: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };
    return { column, sqlOp: sqlOps[op] };
  }

  if (op === 'eq') {
    if (typeof value === 'number') return { column: `${alias}.value_number`, sqlOp: '=' };
    if (typeof value === 'string' && ISO_DATE_RE.test(value)) return { column: `${alias}.value_date`, sqlOp: '=' };
    return { column: `${alias}.value_text`, sqlOp: '=' };
  }

  return { column: `${alias}.value_text`, sqlOp: '=' };
}
```

- [ ] **Step 4: Implement get-node**

Create `src/mcp/tools/get-node.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult, toolErrorResult } from './errors.js';
import { resolveTarget } from '../../resolver/resolve.js';
import { z } from 'zod';
import { basename } from 'node:path';

export function registerGetNode(server: McpServer, db: Database.Database): void {
  server.tool(
    'get-node',
    'Get full details of a single node by ID, file path, or title. Returns fields, types, relationships, body, and metadata.',
    {
      node_id: z.string().optional().describe('Node ID (nanoid)'),
      file_path: z.string().optional().describe('Vault-relative file path'),
      title: z.string().optional().describe('Node title (uses four-tier resolution)'),
    },
    async (args) => {
      const provided = [args.node_id, args.file_path, args.title].filter(Boolean);
      if (provided.length === 0) {
        return toolErrorResult('INVALID_PARAMS', 'Exactly one of node_id, file_path, or title is required');
      }
      if (provided.length > 1) {
        return toolErrorResult('INVALID_PARAMS', 'Only one of node_id, file_path, or title may be provided');
      }

      type NodeRow = { id: string; file_path: string; title: string | null; body: string; content_hash: string; file_mtime: number; indexed_at: number };
      let node: NodeRow | undefined;

      if (args.node_id) {
        node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(args.node_id) as NodeRow | undefined;
      } else if (args.file_path) {
        node = db.prepare('SELECT * FROM nodes WHERE file_path = ?').get(args.file_path) as NodeRow | undefined;
      } else if (args.title) {
        const resolved = resolveTarget(db, args.title);
        if (!resolved) return toolErrorResult('NOT_FOUND', `No node found matching title '${args.title}'`);
        node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(resolved.id) as NodeRow | undefined;
      }

      if (!node) return toolErrorResult('NOT_FOUND', 'Node not found');

      // Types
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type')
        .all(node.id) as { schema_type: string }[]).map(t => t.schema_type);

      // Fields
      const fieldRows = db.prepare('SELECT * FROM node_fields WHERE node_id = ?')
        .all(node.id) as Array<{
          field_name: string; value_text: string | null; value_number: number | null;
          value_date: string | null; value_json: string | null; source: string;
        }>;

      const fields: Record<string, { value: unknown; type: string; source: string }> = {};
      for (const row of fieldRows) {
        if (row.value_text !== null) fields[row.field_name] = { value: row.value_text, type: 'text', source: row.source };
        else if (row.value_number !== null) fields[row.field_name] = { value: row.value_number, type: 'number', source: row.source };
        else if (row.value_date !== null) fields[row.field_name] = { value: row.value_date, type: 'date', source: row.source };
        else if (row.value_json !== null) fields[row.field_name] = { value: JSON.parse(row.value_json), type: 'json', source: row.source };
      }

      // Outgoing relationships
      const outgoing = db.prepare('SELECT target, rel_type, context FROM relationships WHERE source_id = ?')
        .all(node.id) as Array<{ target: string; rel_type: string; context: string | null }>;

      const outGrouped: Record<string, Array<{ target_id: string; target_title: string | null; context?: string }>> = {};
      for (const rel of outgoing) {
        if (!outGrouped[rel.rel_type]) outGrouped[rel.rel_type] = [];
        const resolved = resolveTarget(db, rel.target);
        outGrouped[rel.rel_type].push({
          target_id: resolved?.id ?? rel.target,
          target_title: resolved?.title ?? null,
          ...(rel.context ? { context: rel.context } : {}),
        });
      }

      // Incoming relationships
      const nodeBasename = basename(node.file_path, '.md');
      const incoming = db.prepare(`
        SELECT DISTINCT r.source_id, r.rel_type, r.context, n2.title as source_title
        FROM relationships r
        JOIN nodes n2 ON n2.id = r.source_id
        WHERE (r.target = ? OR r.target = ? OR LOWER(r.target) = LOWER(?) OR r.target = ?)
          AND r.source_id != ?
      `).all(node.file_path, nodeBasename, nodeBasename, node.title ?? '', node.id) as Array<{
        source_id: string; rel_type: string; context: string | null; source_title: string | null;
      }>;

      const inGrouped: Record<string, Array<{ source_id: string; source_title: string | null; context?: string }>> = {};
      const seen = new Set<string>();
      for (const rel of incoming) {
        const key = `${rel.source_id}:${rel.rel_type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!inGrouped[rel.rel_type]) inGrouped[rel.rel_type] = [];
        inGrouped[rel.rel_type].push({
          source_id: rel.source_id,
          source_title: rel.source_title,
          ...(rel.context ? { context: rel.context } : {}),
        });
      }

      return toolResult({
        id: node.id,
        file_path: node.file_path,
        title: node.title,
        types,
        fields,
        relationships: { outgoing: outGrouped, incoming: inGrouped },
        body: node.body,
        file_mtime: node.file_mtime,
        indexed_at: node.indexed_at,
        content_hash: node.content_hash,
      });
    },
  );
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/mcp/tools.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/query-nodes.ts src/mcp/tools/get-node.ts tests/mcp/tools.test.ts
git commit -m "feat: add query-nodes and get-node tools with filtering and resolution"
```

---

## Task 10: MCP Tool Registration and Server Update

**Files:**
- Create: `src/mcp/tools/index.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Create tool registration barrel**

Create `src/mcp/tools/index.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerVaultStats } from './vault-stats.js';
import { registerListTypes } from './list-types.js';
import { registerQueryNodes } from './query-nodes.js';
import { registerGetNode } from './get-node.js';
import { registerListSchemas } from './list-schemas.js';
import { registerDescribeSchema } from './describe-schema.js';
import { registerListGlobalFields } from './list-global-fields.js';
import { registerDescribeGlobalField } from './describe-global-field.js';

export function registerAllTools(server: McpServer, db: Database.Database): void {
  registerVaultStats(server, db);
  registerListTypes(server, db);
  registerQueryNodes(server, db);
  registerGetNode(server, db);
  registerListSchemas(server, db);
  registerDescribeSchema(server, db);
  registerListGlobalFields(server, db);
  registerDescribeGlobalField(server, db);
}
```

- [ ] **Step 2: Update server.ts**

Replace `src/mcp/server.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerAllTools } from './tools/index.js';

export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({
    name: 'vault-engine',
    version: '0.1.0',
  });

  registerAllTools(server, db);

  return server;
}
```

- [ ] **Step 3: Verify build compiles**

```bash
npm run build
```

Expected: may show errors for `src/index.ts` (needs updating in Task 12), but `src/mcp/` should compile cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/index.ts src/mcp/server.ts
git commit -m "feat: wire up all 8 MCP tools and update server factory"
```

---

## Task 11: Sync — Write Lock, Mutex, Watcher, Reconciler

**Files:**
- Create: `src/sync/write-lock.ts`
- Create: `src/sync/mutex.ts`
- Create: `src/sync/watcher.ts`
- Create: `src/sync/reconciler.ts`
- Create: `src/sync/index.ts`
- Test: `tests/sync/write-lock.test.ts`
- Test: `tests/sync/watcher.test.ts`

- [ ] **Step 1: Write failing write-lock tests**

Create `tests/sync/write-lock.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { WriteLockManager } from '../../src/sync/write-lock.js';

describe('WriteLockManager', () => {
  it('isLocked returns false when not locked', () => {
    const wl = new WriteLockManager();
    expect(wl.isLocked('test.md')).toBe(false);
  });

  it('withLock sets isLocked during execution', async () => {
    const wl = new WriteLockManager();
    let wasLocked = false;
    await wl.withLock('test.md', async () => {
      wasLocked = wl.isLocked('test.md');
    });
    expect(wasLocked).toBe(true);
    expect(wl.isLocked('test.md')).toBe(false);
  });

  it('withLock unlocks on error', async () => {
    const wl = new WriteLockManager();
    await expect(
      wl.withLock('test.md', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    expect(wl.isLocked('test.md')).toBe(false);
  });

  it('withLock returns the function result', async () => {
    const wl = new WriteLockManager();
    const result = await wl.withLock('test.md', async () => 42);
    expect(result).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/sync/write-lock.test.ts
```

- [ ] **Step 3: Implement write lock**

Create `src/sync/write-lock.ts`:

```typescript
export class WriteLockManager {
  private locks = new Set<string>();

  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    this.locks.add(filePath);
    try {
      return await fn();
    } finally {
      this.locks.delete(filePath);
    }
  }
}
```

- [ ] **Step 4: Run write-lock tests**

```bash
npm test -- tests/sync/write-lock.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Implement mutex**

Create `src/sync/mutex.ts`:

```typescript
type PendingEvent = { type: 'add' | 'change' | 'unlink'; path: string };

export class IndexMutex {
  private running = false;
  private queue = new Map<string, PendingEvent>();
  private idleResolvers: Array<() => void> = [];
  processEvent: (event: PendingEvent) => Promise<void> = async () => {};

  async run(fn: () => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await fn();
      while (this.queue.size > 0) {
        const events = [...this.queue.values()];
        this.queue.clear();
        for (const event of events) {
          await this.processEvent(event);
        }
      }
    } finally {
      this.running = false;
      this.notifyIdle();
    }
  }

  enqueue(event: PendingEvent): void {
    this.queue.set(event.path, event);
  }

  isRunning(): boolean {
    return this.running;
  }

  onIdle(): Promise<void> {
    if (!this.running && this.queue.size === 0) return Promise.resolve();
    return new Promise(resolve => { this.idleResolvers.push(resolve); });
  }

  private notifyIdle(): void {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
```

- [ ] **Step 6: Implement watcher**

Create `src/sync/watcher.ts`:

```typescript
import chokidar from 'chokidar';
import type Database from 'better-sqlite3';
import { relative, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { indexFile, deleteNodeByPath } from '../indexer/indexer.js';
import { shouldIgnore } from '../indexer/ignore.js';
import { sha256 } from '../indexer/hash.js';
import type { IndexMutex } from './mutex.js';
import type { WriteLockManager } from './write-lock.js';

export interface WatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
}

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  options: WatcherOptions = {},
): chokidar.FSWatcher {
  const debounceMs = options.debounceMs ?? 500;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const timers = new Map<string, { debounce: ReturnType<typeof setTimeout>; maxWait: ReturnType<typeof setTimeout> }>();

  function scheduleProcess(eventType: 'add' | 'change' | 'unlink', absolutePath: string): void {
    const relPath = relative(vaultPath, absolutePath);
    if (shouldIgnore(relPath)) return;
    if (writeLock.isLocked(absolutePath)) return;

    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing.debounce);

    const fire = () => {
      const t = timers.get(relPath);
      if (t) { clearTimeout(t.debounce); clearTimeout(t.maxWait); timers.delete(relPath); }

      if (mutex.isRunning()) {
        mutex.enqueue({ type: eventType, path: relPath });
      } else {
        mutex.run(async () => {
          await processFileEvent(eventType, relPath, absolutePath, vaultPath, db);
        });
      }
    };

    const debounce = setTimeout(fire, debounceMs);
    const maxWait = existing?.maxWait ?? setTimeout(fire, maxWaitMs);
    timers.set(relPath, { debounce, maxWait });
  }

  mutex.processEvent = async (event) => {
    const absolutePath = join(vaultPath, event.path);
    await processFileEvent(event.type, event.path, absolutePath, vaultPath, db);
  };

  const watcher = chokidar.watch(vaultPath, {
    ignored: [/(^|[/\\])\./, '**/node_modules/**'],
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on('add', path => scheduleProcess('add', path));
  watcher.on('change', path => scheduleProcess('change', path));
  watcher.on('unlink', path => {
    const relPath = relative(vaultPath, path);
    if (shouldIgnore(relPath)) return;
    if (mutex.isRunning()) {
      mutex.enqueue({ type: 'unlink', path: relPath });
    } else {
      mutex.run(async () => { deleteNodeByPath(relPath, db); });
    }
  });

  return watcher;
}

async function processFileEvent(
  eventType: string, relPath: string, absolutePath: string,
  vaultPath: string, db: Database.Database,
): Promise<void> {
  if (eventType === 'unlink') { deleteNodeByPath(relPath, db); return; }
  try {
    const raw = readFileSync(absolutePath, 'utf-8');
    const hash = sha256(raw);
    const existing = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?')
      .get(relPath) as { content_hash: string } | undefined;
    if (existing && existing.content_hash === hash) return;
    await indexFile(absolutePath, vaultPath, db);
  } catch { /* file may have been deleted between event and processing */ }
}
```

- [ ] **Step 7: Implement reconciler**

Create `src/sync/reconciler.ts`:

```typescript
import type Database from 'better-sqlite3';
import { fullIndex } from '../indexer/indexer.js';
import type { IndexMutex } from './mutex.js';

export interface ReconcilerOptions {
  initialDelayMs?: number;
  intervalMs?: number;
}

export function startReconciler(
  vaultPath: string, db: Database.Database, mutex: IndexMutex,
  options: ReconcilerOptions = {},
): { stop: () => void } {
  const initialDelayMs = options.initialDelayMs ?? 2 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 15 * 60 * 1000;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  const runSweep = () => {
    mutex.run(async () => {
      await fullIndex(vaultPath, db);
      db.prepare('INSERT INTO edits_log (timestamp, event_type, details) VALUES (?, ?, ?)')
        .run(Date.now(), 'reconciler-sweep', JSON.stringify({ vault_path: vaultPath }));
    });
  };

  const initialTimeout = setTimeout(() => {
    runSweep();
    intervalHandle = setInterval(runSweep, intervalMs);
  }, initialDelayMs);

  return {
    stop: () => { clearTimeout(initialTimeout); if (intervalHandle) clearInterval(intervalHandle); },
  };
}
```

- [ ] **Step 8: Create sync barrel export**

Create `src/sync/index.ts`:

```typescript
export { WriteLockManager } from './write-lock.js';
export { IndexMutex } from './mutex.js';
export { startWatcher } from './watcher.js';
export type { WatcherOptions } from './watcher.js';
export { startReconciler } from './reconciler.js';
export type { ReconcilerOptions } from './reconciler.js';
```

- [ ] **Step 9: Write watcher integration tests**

Create `tests/sync/watcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startWatcher } from '../../src/sync/watcher.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type { FSWatcher } from 'chokidar';

let db: Database.Database;
let vaultPath: string;
let watcher: FSWatcher;
let mutex: IndexMutex;

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-watcher-test-'));
  mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
  const dbPath = join(vaultPath, '.vault-engine', 'test.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  writeFileSync(join(vaultPath, 'initial.md'), '---\ntitle: Initial\ntypes:\n  - note\n---\nBody.');
  await fullIndex(vaultPath, db);

  mutex = new IndexMutex();
  watcher = startWatcher(vaultPath, db, mutex, new WriteLockManager(), {
    debounceMs: 50, maxWaitMs: 200,
  });
  await new Promise(r => setTimeout(r, 100));
});

afterEach(async () => {
  await watcher.close();
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('watcher', () => {
  it('indexes a new file', async () => {
    writeFileSync(join(vaultPath, 'new-file.md'), '---\ntitle: New\ntypes:\n  - note\n---\nNew body.');
    await new Promise(r => setTimeout(r, 150));
    await mutex.onIdle();

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('re-indexes a changed file', async () => {
    writeFileSync(join(vaultPath, 'initial.md'), '---\ntitle: Updated\ntypes:\n  - note\n---\nUpdated body.');
    await new Promise(r => setTimeout(r, 150));
    await mutex.onIdle();

    const node = db.prepare("SELECT title FROM nodes WHERE file_path = 'initial.md'").get() as { title: string };
    expect(node.title).toBe('Updated');
  });

  it('deletes a removed file', async () => {
    unlinkSync(join(vaultPath, 'initial.md'));
    await new Promise(r => setTimeout(r, 150));
    await mutex.onIdle();

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('ignores non-.md files', async () => {
    writeFileSync(join(vaultPath, 'readme.txt'), 'not markdown');
    await new Promise(r => setTimeout(r, 150));
    await mutex.onIdle();

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 10: Run all sync tests**

```bash
npm test -- tests/sync/
```

Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add src/sync/ tests/sync/
git commit -m "feat: add file watcher, reconciler, mutex, and write lock scaffolding"
```

---

## Task 12: Wire Up Startup Sequence

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update index.ts**

Replace `src/index.ts`:

```typescript
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/connection.js';
import { createSchema } from './db/schema.js';
import { createServer } from './mcp/server.js';
import { parseArgs } from './transport/args.js';
import { startHttpTransport } from './transport/http.js';
import { createAuthSchema } from './auth/schema.js';
import { validateAuthEnv } from './auth/env.js';
import { fullIndex } from './indexer/indexer.js';
import { startWatcher } from './sync/watcher.js';
import { startReconciler } from './sync/reconciler.js';
import { IndexMutex } from './sync/mutex.js';
import { WriteLockManager } from './sync/write-lock.js';

const args = parseArgs(process.argv.slice(2));

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}

const dbPath = args.dbPath ?? process.env.DB_PATH ?? resolve(vaultPath, '.vault-engine', 'vault.db');
const db = openDatabase(dbPath);
createSchema(db);

console.log(`Indexing vault at ${vaultPath}...`);
const indexStart = Date.now();
await fullIndex(vaultPath, db);
console.log(`Indexing complete in ${Date.now() - indexStart}ms`);

const mutex = new IndexMutex();
const writeLock = new WriteLockManager();
const watcher = startWatcher(vaultPath, db, mutex, writeLock);
const reconciler = startReconciler(vaultPath, db, mutex);

const serverFactory = () => createServer(db);

if (args.transport === 'stdio' || args.transport === 'both') {
  const server = serverFactory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (args.transport === 'http' || args.transport === 'both') {
  const authEnv = validateAuthEnv(process.env.OAUTH_OWNER_PASSWORD, process.env.OAUTH_ISSUER_URL);
  createAuthSchema(db);
  await startHttpTransport(serverFactory, args.port, {
    db, ownerPassword: authEnv.ownerPassword, issuerUrl: authEnv.issuerUrl,
  });
}

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  reconciler.stop();
  await watcher.close();
  db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  reconciler.stop();
  await watcher.close();
  db.close();
  process.exit(0);
});
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up Phase 1 startup with indexer, watcher, and reconciler"
```

---

## Task 13: End-to-End Integration Test

**Files:**
- Create: `tests/integration/end-to-end.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/end-to-end.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startWatcher } from '../../src/sync/watcher.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import type { FSWatcher } from 'chokidar';

let db: Database.Database;
let vaultPath: string;
let watcher: FSWatcher;
let mutex: IndexMutex;

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'vault-e2e-'));
  mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
  db = new Database(join(vaultPath, '.vault-engine', 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  writeFileSync(join(vaultPath, 'meeting.md'), `---
title: Team Standup
types:
  - meeting
  - note
project: "[[Vault Engine]]"
attendees:
  - "[[Alice]]"
---

Discussed Phase 1 with [[Bob]].
`);

  writeFileSync(join(vaultPath, 'project.md'), `---
title: Vault Engine
types:
  - project
status: active
---

The vault engine project.
`);

  await fullIndex(vaultPath, db);

  mutex = new IndexMutex();
  watcher = startWatcher(vaultPath, db, mutex, new WriteLockManager(), {
    debounceMs: 50, maxWaitMs: 200,
  });
  await new Promise(r => setTimeout(r, 100));
});

afterEach(async () => {
  await watcher.close();
  db.close();
  rmSync(vaultPath, { recursive: true, force: true });
});

describe('end-to-end', () => {
  it('indexes vault, stores correct data, detects new files', async () => {
    // Verify initial index
    expect((db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c).toBe(2);

    // Verify types
    const types = db.prepare('SELECT DISTINCT schema_type FROM node_types ORDER BY schema_type')
      .all() as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'note', 'project']);

    // Verify relationships
    const rels = db.prepare('SELECT target, rel_type FROM relationships ORDER BY target')
      .all() as { target: string; rel_type: string }[];
    expect(rels.some(r => r.target === 'Vault Engine')).toBe(true);
    expect(rels.some(r => r.target === 'Alice')).toBe(true);
    expect(rels.some(r => r.target === 'Bob' && r.rel_type === 'wiki-link')).toBe(true);

    // Verify typed field storage
    const statusField = db.prepare(
      "SELECT value_text FROM node_fields nf JOIN nodes n ON n.id = nf.node_id WHERE n.title = 'Vault Engine' AND nf.field_name = 'status'"
    ).get() as { value_text: string };
    expect(statusField.value_text).toBe('active');

    // Add a new file, verify watcher picks it up
    writeFileSync(join(vaultPath, 'new-note.md'), `---
title: New Discovery
types:
  - note
project: "[[Vault Engine]]"
---

Found something about [[SQLite FTS5]].
`);

    await new Promise(r => setTimeout(r, 150));
    await mutex.onIdle();

    expect((db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c).toBe(3);

    const newNode = db.prepare("SELECT id FROM nodes WHERE title = 'New Discovery'").get() as { id: string };
    expect(newNode).toBeDefined();

    const newRels = db.prepare('SELECT target FROM relationships WHERE source_id = ?')
      .all(newNode.id) as { target: string }[];
    expect(newRels.some(r => r.target === 'Vault Engine')).toBe(true);
    expect(newRels.some(r => r.target === 'SQLite FTS5')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
npm test -- tests/integration/end-to-end.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/end-to-end.test.ts
git commit -m "test: add end-to-end integration test for index-query-watcher pipeline"
```

---

## Task 14: Full Test Suite and Build Verification

- [ ] **Step 1: Run the complete test suite**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 2: Run the build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Smoke test with real vault**

```bash
VAULT_PATH=~/Documents/archbrain npm run dev
```

Expected: indexes the real vault, prints timing, starts without errors. Ctrl+C to stop.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address test suite and build issues"
```

(Skip if no fixes needed.)

---

## Task 15: Performance Smoke Test

**Files:**
- Create: `tests/perf/full-index.test.ts`

- [ ] **Step 1: Create performance test**

Create `tests/perf/full-index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';

const REAL_VAULT = resolve(homedir(), 'Documents', 'archbrain');

describe('performance', () => {
  it('indexes the real vault in under 60 seconds', async () => {
    if (!existsSync(REAL_VAULT)) {
      console.log('Skipping: real vault not found at', REAL_VAULT);
      return;
    }

    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const start = Date.now();
    await fullIndex(REAL_VAULT, db);
    const elapsed = Date.now() - start;

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    console.log(`Indexed ${count} nodes in ${elapsed}ms`);

    expect(elapsed).toBeLessThan(60_000);
    expect(count).toBeGreaterThan(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run the performance test**

```bash
npm run test:perf
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/perf/full-index.test.ts
git commit -m "test: add performance smoke test for real vault indexing"
```
