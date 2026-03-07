# SQLite Schema Creation + DB Connection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the SQLite database layer — connection factory with WAL mode + pragmas, and schema creation with all 7 tables, FTS5, triggers, and indices.

**Architecture:** Factory function `openDatabase(dbPath)` returns a configured `better-sqlite3` instance. Separate `createSchema(db)` runs idempotent DDL. No migration tracking — the DB is a rebuildable index.

**Tech Stack:** better-sqlite3, SQLite FTS5, vitest

---

### Task 1: Connection Module

**Files:**
- Create: `tests/db/connection.test.ts`
- Create: `src/db/connection.ts`

**Step 1: Write the failing tests**

```typescript
// tests/db/connection.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('openDatabase', () => {
  const dbs: { close(): void }[] = [];
  const tmps: string[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
    for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
    tmps.length = 0;
  });

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const row = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(row[0].foreign_keys).toBe(1);
  });

  it('sets busy timeout', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const row = db.pragma('busy_timeout') as { busy_timeout: number }[];
    expect(row[0].busy_timeout).toBe(5000);
  });

  it('enables WAL mode on file-based database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    tmps.push(dir);
    const db = openDatabase(join(dir, 'test.db'));
    dbs.push(db);
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(row[0].journal_mode).toBe('wal');
  });

  it('creates parent directories if they do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    tmps.push(dir);
    const db = openDatabase(join(dir, 'sub', 'dir', 'test.db'));
    dbs.push(db);
    const row = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(row[0].foreign_keys).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: FAIL — cannot find module `../../src/db/connection.js`

**Step 3: Write the implementation**

```typescript
// src/db/connection.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/db/connection.ts tests/db/connection.test.ts
git commit -m "add openDatabase factory with WAL mode, foreign keys, and busy timeout"
```

---

### Task 2: Schema Module

**Files:**
- Create: `tests/db/schema.test.ts`
- Create: `src/db/schema.ts`

**Step 1: Write failing test — all tables exist after createSchema**

```typescript
// tests/db/schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';

describe('createSchema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  const expectedTables = [
    'nodes',
    'node_types',
    'fields',
    'relationships',
    'schemas',
    'files',
  ];

  it('creates all tables', () => {
    createSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    for (const table of expectedTables) {
      expect(tables).toContain(table);
    }
  });

  it('creates the FTS5 virtual table', () => {
    createSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates all indices', () => {
    createSchema(db);
    const indices = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((r: any) => r.name);
    const expectedIndices = [
      'idx_nodes_file',
      'idx_nodes_parent',
      'idx_node_types_schema',
      'idx_fields_key_value',
      'idx_fields_key_number',
      'idx_fields_key_date',
      'idx_rel_source',
      'idx_rel_target',
      'idx_rel_type',
    ];
    for (const idx of expectedIndices) {
      expect(indices).toContain(idx);
    }
  });

  it('is idempotent — running twice does not throw', () => {
    createSchema(db);
    expect(() => createSchema(db)).not.toThrow();
  });

  it('creates FTS5 triggers for content sync', () => {
    createSchema(db);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((r: any) => r.name);
    expect(triggers).toContain('nodes_fts_insert');
    expect(triggers).toContain('nodes_fts_delete');
    expect(triggers).toContain('nodes_fts_update');
  });

  it('FTS5 indexes content inserted into nodes', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'hello world search test', '# Hello')`
    ).run();

    const results = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'search'")
      .all();
    expect(results).toHaveLength(1);
  });

  it('FTS5 reflects deletions from nodes', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'unique findme text', '# Test')`
    ).run();

    db.prepare("DELETE FROM nodes WHERE id = 'n1'").run();

    const results = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'findme'")
      .all();
    expect(results).toHaveLength(0);
  });

  it('FTS5 reflects updates to nodes', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'original text', '# Test')`
    ).run();

    db.prepare(
      "UPDATE nodes SET content_text = 'updated replacement' WHERE id = 'n1'"
    ).run();

    const old = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'original'")
      .all();
    expect(old).toHaveLength(0);

    const updated = db
      .prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'replacement'")
      .all();
    expect(updated).toHaveLength(1);
  });

  it('enforces foreign key on node_types', () => {
    createSchema(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO node_types (node_id, schema_type) VALUES ('nonexistent', 'task')"
        )
        .run()
    ).toThrow(/FOREIGN KEY/);
  });

  it('cascades deletes from nodes to node_types and fields', () => {
    createSchema(db);

    db.prepare(
      `INSERT INTO nodes (id, file_path, node_type, content_text, content_md)
       VALUES ('n1', 'test.md', 'file', 'text', '# Test')`
    ).run();
    db.prepare(
      "INSERT INTO node_types (node_id, schema_type) VALUES ('n1', 'task')"
    ).run();
    db.prepare(
      "INSERT INTO fields (node_id, key, value_text, value_type) VALUES ('n1', 'status', 'todo', 'string')"
    ).run();

    db.prepare("DELETE FROM nodes WHERE id = 'n1'").run();

    const types = db
      .prepare("SELECT * FROM node_types WHERE node_id = 'n1'")
      .all();
    const fields = db
      .prepare("SELECT * FROM fields WHERE node_id = 'n1'")
      .all();
    expect(types).toHaveLength(0);
    expect(fields).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: FAIL — cannot find module `../../src/db/schema.js`

**Step 3: Write the implementation**

```typescript
// src/db/schema.ts
import type Database from 'better-sqlite3';

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id              TEXT PRIMARY KEY,
      file_path       TEXT NOT NULL,
      node_type       TEXT NOT NULL,
      parent_id       TEXT,
      position_start  INTEGER,
      position_end    INTEGER,
      depth           INTEGER DEFAULT 0,
      content_text    TEXT,
      content_md      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS node_types (
      node_id         TEXT NOT NULL,
      schema_type     TEXT NOT NULL,
      PRIMARY KEY (node_id, schema_type),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      content_text,
      content='nodes',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS fields (
      node_id         TEXT NOT NULL,
      key             TEXT NOT NULL,
      value_text      TEXT,
      value_type      TEXT NOT NULL,
      value_number    REAL,
      value_date      TEXT,
      PRIMARY KEY (node_id, key),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id       TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      rel_type        TEXT NOT NULL,
      context         TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schemas (
      name            TEXT PRIMARY KEY,
      definition      TEXT NOT NULL,
      file_path       TEXT,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      path            TEXT PRIMARY KEY,
      mtime           TEXT NOT NULL,
      hash            TEXT NOT NULL,
      indexed_at      TEXT DEFAULT (datetime('now'))
    );

    -- Indices
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_node_types_schema ON node_types(schema_type);
    CREATE INDEX IF NOT EXISTS idx_fields_key_value ON fields(key, value_text);
    CREATE INDEX IF NOT EXISTS idx_fields_key_number ON fields(key, value_number);
    CREATE INDEX IF NOT EXISTS idx_fields_key_date ON fields(key, value_date);
    CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
    CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(rel_type);

    -- FTS5 sync triggers
    CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES('delete', old.rowid, old.content_text);
      INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
    END;
  `);
}
```

**Step 4: Run test to verify all pass**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts
git commit -m "add createSchema with all tables, FTS5, triggers, and indices"
```

---

### Task 3: Index Re-exports + Final Verification

**Files:**
- Create: `src/db/index.ts`

**Step 1: Create index.ts**

```typescript
// src/db/index.ts
export { openDatabase } from './connection.js';
export { createSchema } from './schema.js';
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass (parser tests + new db tests)

**Step 4: Commit**

```bash
git add src/db/index.ts
git commit -m "add db module index with re-exports"
```

---

### Task 4: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add DB module section to Architecture in CLAUDE.md**

Add under the Parser Pipeline section:

```markdown
### DB Layer (`src/db/`)

Database connection and schema management.

- **`connection.ts`** — `openDatabase(dbPath)` factory. Configures WAL mode, foreign keys, busy timeout. Creates parent directories for file-based DBs.
- **`schema.ts`** — `createSchema(db)` runs idempotent DDL: 7 tables (nodes, node_types, nodes_fts, fields, relationships, schemas, files), 9 indices, 3 FTS5 sync triggers. No migration tracking — DB is rebuildable.
- **`index.ts`** — Re-exports `openDatabase` and `createSchema`.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "update CLAUDE.md with db module documentation"
```
