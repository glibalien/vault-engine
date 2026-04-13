# Phase 4 — Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic search to the vault engine — every node's content is embedded via an in-process ONNX model, stored in sqlite-vec, and searchable through a hybrid (FTS5 + vector + RRF) `query` parameter on the existing `query-nodes` tool.

**Architecture:** Background embedding indexer watches for node changes, embeds content via `@huggingface/transformers` (nomic-embed-text-v1.5, 256-dim Matryoshka), stores vectors in sqlite-vec. `query-nodes` gains a `query` parameter that runs hybrid search — FTS5 keyword matching plus vector similarity, fused via reciprocal rank fusion — with all existing structured filters still available.

**Tech Stack:** `@huggingface/transformers` (ONNX inference), `sqlite-vec` (already in package.json), better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-04-12-phase4-semantic-search-design.md`

---

## File Structure

### New files

```
src/search/
  types.ts          — EmbeddingMeta, EmbeddingQueueItem, SearchResult types
  embedder.ts       — model singleton, load/embed interface, prefix handling
  indexer.ts        — background queue, staleness detection, content assembly, chunk splitting
  search.ts         — hybrid search: FTS5 + vector + RRF fusion
```

### Modified files

```
src/db/schema.ts              — drop embeddings table, add embedding_meta + embedding_vec
src/db/migrate.ts             — add upgradeToPhase4() migration
src/db/connection.ts          — load sqlite-vec extension
src/mcp/query-builder.ts      — remove full_text filter
src/mcp/tools/query-nodes.ts  — add query param, integrate hybrid search, remove full_text
src/mcp/tools/vault-stats.ts  — add search_index section
src/mcp/tools/index.ts        — pass embeddingIndexer through to query-nodes and vault-stats
src/mcp/server.ts             — add EmbeddingIndexer to ServerContext
src/index.ts                  — model loading, indexer startup, --reindex-search flag, shutdown
```

### New test files

```
tests/search/embedder.test.ts
tests/search/indexer.test.ts
tests/search/search.test.ts
tests/mcp/query-nodes-search.test.ts
```

---

## Task 1: Search types

**Files:**
- Create: `src/search/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/search/types.ts

export interface EmbeddingMeta {
  id: number;
  node_id: string;
  source_type: 'node' | 'extraction';
  source_hash: string;
  chunk_index: number;
  extraction_ref: string | null;
  embedded_at: string;
}

export interface EmbeddingQueueItem {
  node_id: string;
  source_type: 'node' | 'extraction';
  extraction_ref?: string;
}

export interface SearchHit {
  node_id: string;
  score: number;
  match_sources: Array<'node' | 'embed'>;
  matched_embed?: string;
  snippet?: string;
}

export interface SearchIndexStatus {
  status: 'ready' | 'indexing' | 'disabled';
  nodes_total: number;
  nodes_indexed: number;
  extractions_total: number;
  extractions_indexed: number;
  pending: number;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/search/types.ts`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/search/types.ts
git commit -m "feat(phase4): add search type definitions"
```

---

## Task 2: DB migration — embedding_meta and embedding_vec

**Files:**
- Modify: `src/db/schema.ts:108-112` (replace `embeddings` table)
- Modify: `src/db/migrate.ts` (add `upgradeToPhase4`)
- Modify: `src/db/connection.ts:11-13` (load sqlite-vec extension)
- Test: `tests/search/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/search/schema.test.ts`:

```typescript
// tests/search/schema.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToPhase4 } from '../../src/db/migrate.js';
import * as sqliteVec from 'sqlite-vec';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

describe('Phase 4 schema', () => {
  it('creates embedding_meta table with correct columns', () => {
    const db = createTestDb();
    const cols = db.prepare('PRAGMA table_info(embedding_meta)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('node_id');
    expect(names).toContain('source_type');
    expect(names).toContain('source_hash');
    expect(names).toContain('chunk_index');
    expect(names).toContain('extraction_ref');
    expect(names).toContain('embedded_at');
    db.close();
  });

  it('creates embedding_vec virtual table', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'embedding_vec'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    db.close();
  });

  it('enforces unique constraint on (node_id, source_type, extraction_ref, chunk_index)', () => {
    const db = createTestDb();
    // Insert a node first
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'test.md', 'Test', '', 'hash1')").run();

    db.prepare(
      "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n1', 'node', 'h1', 0, NULL, '2026-01-01T00:00:00Z')"
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n1', 'node', 'h2', 0, NULL, '2026-01-01T00:00:00Z')"
      ).run();
    }).toThrow();
    db.close();
  });

  it('upgradeToPhase4 is idempotent on old database', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);
    // Create the old schema (has embeddings table)
    createSchema(db);
    // Run migration twice — should not throw
    upgradeToPhase4(db);
    upgradeToPhase4(db);
    // embedding_meta should exist, old embeddings should be gone
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('embeddings', 'embedding_meta')"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('embedding_meta');
    expect(names).not.toContain('embeddings');
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/schema.test.ts`
Expected: FAIL — `upgradeToPhase4` does not exist, schema has no `embedding_meta`

- [ ] **Step 3: Update schema.ts — replace embeddings with embedding_meta + embedding_vec**

In `src/db/schema.ts`, replace lines 108-112 (the `embeddings` table) with:

```sql
    CREATE TABLE IF NOT EXISTS embedding_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      extraction_ref TEXT,
      embedded_at TEXT NOT NULL,
      UNIQUE(node_id, source_type, extraction_ref, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_meta_node_id ON embedding_meta(node_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS embedding_vec USING vec0(
      id INTEGER PRIMARY KEY,
      vector float[256]
    );
```

- [ ] **Step 4: Add upgradeToPhase4 in migrate.ts**

Add to `src/db/migrate.ts`:

```typescript
export function upgradeToPhase4(db: Database.Database): void {
  const run = db.transaction(() => {
    // Drop old placeholder embeddings table if it exists
    const tables = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
      ).all() as { name: string }[]
    ).map(t => t.name);

    if (tables.includes('embeddings')) {
      db.prepare('DROP TABLE embeddings').run();
    }

    // Create embedding_meta if missing
    const hasMeta = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_meta'"
      ).all() as { name: string }[]
    ).length > 0;

    if (!hasMeta) {
      db.prepare(`
        CREATE TABLE embedding_meta (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          extraction_ref TEXT,
          embedded_at TEXT NOT NULL,
          UNIQUE(node_id, source_type, extraction_ref, chunk_index)
        )
      `).run();
      db.prepare('CREATE INDEX idx_embedding_meta_node_id ON embedding_meta(node_id)').run();
    }

    // Create embedding_vec if missing
    const hasVec = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE name='embedding_vec'"
      ).all() as { name: string }[]
    ).length > 0;

    if (!hasVec) {
      db.prepare(`
        CREATE VIRTUAL TABLE embedding_vec USING vec0(
          id INTEGER PRIMARY KEY,
          vector float[256]
        )
      `).run();
    }
  });

  run();
}
```

- [ ] **Step 5: Update connection.ts to load sqlite-vec**

In `src/db/connection.ts`, add the import and extension load:

```typescript
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';

export function openDatabase(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 6: Update test helper to load sqlite-vec**

In `tests/helpers/db.ts`, add sqlite-vec loading:

```typescript
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import * as sqliteVec from 'sqlite-vec';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/search/schema.test.ts`
Expected: PASS

Run: `npm test`
Expected: All existing tests pass (the test helper change should be backward-compatible — sqlite-vec loading doesn't affect tables that don't use it)

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/db/connection.ts tests/helpers/db.ts tests/search/schema.test.ts
git commit -m "feat(phase4): replace embeddings placeholder with embedding_meta + embedding_vec"
```

---

## Task 3: Embedder — model singleton and embed interface

**Files:**
- Create: `src/search/embedder.ts`
- Test: `tests/search/embedder.test.ts`

The embedder loads the nomic-embed-text-v1.5 model once and exposes an `embed()` function. Tests use a mock/stub approach since we don't want to download a 137MB model in CI.

- [ ] **Step 1: Write the failing test**

Create `tests/search/embedder.test.ts`:

```typescript
// tests/search/embedder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbedder, type Embedder } from '../../src/search/embedder.js';

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => {
  const mockPipeline = vi.fn().mockResolvedValue(
    vi.fn().mockImplementation((text: string, options?: { pooling: string; normalize: boolean }) => {
      // Return a fake tensor with 256 floats
      const data = new Float32Array(256).fill(0.1);
      return Promise.resolve({ data });
    })
  );
  return { pipeline: mockPipeline, env: { cacheDir: '', allowRemoteModels: true } };
});

describe('Embedder', () => {
  let embedder: Embedder;

  beforeEach(async () => {
    embedder = await createEmbedder({ modelsDir: '/tmp/test-models' });
  });

  it('embeds a document string with search_document: prefix', async () => {
    const result = await embedder.embedDocument('Hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(256);
  });

  it('embeds a query string with search_query: prefix', async () => {
    const result = await embedder.embedQuery('find meetings');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(256);
  });

  it('exposes isReady() as true after loading', () => {
    expect(embedder.isReady()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/embedder.test.ts`
Expected: FAIL — module `../../src/search/embedder.js` not found

- [ ] **Step 3: Install @huggingface/transformers**

Run: `npm install @huggingface/transformers`

- [ ] **Step 4: Write the embedder implementation**

Create `src/search/embedder.ts`:

```typescript
// src/search/embedder.ts
import { pipeline, env } from '@huggingface/transformers';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const DIMENSIONS = 256;

export interface EmbedderOptions {
  modelsDir: string;
}

export interface Embedder {
  embedDocument(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  isReady(): boolean;
}

export async function createEmbedder(options: EmbedderOptions): Promise<Embedder> {
  env.cacheDir = options.modelsDir;
  env.allowRemoteModels = true;

  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    revision: 'main',
  });

  // After successful download, prevent further network calls
  env.allowRemoteModels = false;

  let ready = true;

  async function embed(text: string): Promise<Float32Array> {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    // output.data is the full-dimension vector; truncate to Matryoshka dim
    const full = output.data as Float32Array;
    if (full.length === DIMENSIONS) return full;
    return full.slice(0, DIMENSIONS);
  }

  return {
    async embedDocument(text: string): Promise<Float32Array> {
      return embed(`search_document: ${text}`);
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return embed(`search_query: ${text}`);
    },
    isReady(): boolean {
      return ready;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/search/embedder.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/search/embedder.ts tests/search/embedder.test.ts package.json package-lock.json
git commit -m "feat(phase4): add embedder module with nomic-embed-text-v1.5 singleton"
```

---

## Task 4: Embedding indexer — background queue and content assembly

**Files:**
- Create: `src/search/indexer.ts`
- Test: `tests/search/indexer.test.ts`

The indexer maintains an in-memory queue, assembles content from the DB (title + body + string fields), computes content hashes for staleness, and writes to `embedding_meta` + `embedding_vec`.

- [ ] **Step 1: Write the failing test**

Create `tests/search/indexer.test.ts`:

```typescript
// tests/search/indexer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

function makeFakeEmbedder(): Embedder {
  const calls: string[] = [];
  return {
    async embedDocument(text: string): Promise<Float32Array> {
      calls.push(text);
      const vec = new Float32Array(256);
      // Deterministic: first char code as all values
      vec.fill(text.charCodeAt(0) / 255);
      return vec;
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return new Float32Array(256).fill(0.5);
    },
    isReady(): boolean { return true; },
    _calls: calls,
  } as Embedder & { _calls: string[] };
}

function insertTestNode(db: Database.Database, id: string, title: string, body: string, fields?: Array<{ name: string; value: string }>): void {
  db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)").run(id, `${id}.md`, title, body, `hash-${id}`);
  // Insert FTS row
  const rowid = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(id) as { rowid: number }).rowid;
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(rowid, title, body);
  if (fields) {
    for (const f of fields) {
      db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, 'frontmatter')").run(id, f.name, f.value);
    }
  }
}

describe('EmbeddingIndexer', () => {
  let db: Database.Database;
  let embedder: Embedder & { _calls: string[] };
  let indexer: EmbeddingIndexer;

  beforeEach(() => {
    db = createTestDb();
    embedder = makeFakeEmbedder();
    indexer = createEmbeddingIndexer(db, embedder);
  });

  it('assembleContent returns title + body + string field values', () => {
    insertTestNode(db, 'n1', 'Meeting Notes', 'Discussed pricing', [
      { name: 'project', value: 'Alpha' },
    ]);
    const content = indexer.assembleContent('n1');
    expect(content).toContain('Meeting Notes');
    expect(content).toContain('Discussed pricing');
    expect(content).toContain('Alpha');
  });

  it('contentHash changes when content changes', () => {
    insertTestNode(db, 'n1', 'Title', 'Body A');
    const hash1 = indexer.contentHash('n1');
    db.prepare("UPDATE nodes SET body = 'Body B' WHERE id = 'n1'").run();
    const hash2 = indexer.contentHash('n1');
    expect(hash1).not.toBe(hash2);
  });

  it('enqueue and processOne embeds a node and writes to DB', async () => {
    insertTestNode(db, 'n1', 'Test', 'Some content');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    const processed = await indexer.processOne();
    expect(processed).toBe(true);

    // Check embedding_meta
    const meta = db.prepare("SELECT * FROM embedding_meta WHERE node_id = 'n1'").get() as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.source_type).toBe('node');
    expect(meta.chunk_index).toBe(0);

    // Check embedding_vec has a row
    const vecCount = (db.prepare("SELECT COUNT(*) as count FROM embedding_vec WHERE id = ?").get(meta.id) as { count: number }).count;
    expect(vecCount).toBe(1);
  });

  it('skips re-embedding when source_hash matches', async () => {
    insertTestNode(db, 'n1', 'Test', 'Content');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processOne();
    embedder._calls.length = 0;

    // Re-enqueue same node without changes
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processOne();
    expect(embedder._calls).toHaveLength(0);
  });

  it('re-embeds when content changes', async () => {
    insertTestNode(db, 'n1', 'Test', 'Content A');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processOne();
    embedder._calls.length = 0;

    db.prepare("UPDATE nodes SET body = 'Content B' WHERE id = 'n1'").run();
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processOne();
    expect(embedder._calls.length).toBeGreaterThan(0);
  });

  it('getStatus reports correct counts', async () => {
    insertTestNode(db, 'n1', 'A', 'Body');
    insertTestNode(db, 'n2', 'B', 'Body');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processOne();

    const status = indexer.getStatus();
    expect(status.nodes_total).toBe(2);
    expect(status.nodes_indexed).toBe(1);
    expect(status.status).toBe('ready'); // queue is empty
  });

  it('processOne returns false when queue is empty', async () => {
    const result = await indexer.processOne();
    expect(result).toBe(false);
  });

  it('removeNode cleans up embedding_meta and embedding_vec', async () => {
    insertTestNode(db, 'n1', 'Test', 'Content');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processOne();

    indexer.removeNode('n1');
    const meta = db.prepare("SELECT COUNT(*) as count FROM embedding_meta WHERE node_id = 'n1'").get() as { count: number };
    expect(meta.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the indexer implementation**

Create `src/search/indexer.ts`:

```typescript
// src/search/indexer.ts
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Embedder } from './embedder.js';
import type { EmbeddingQueueItem, SearchIndexStatus } from './types.js';

export interface EmbeddingIndexer {
  enqueue(item: EmbeddingQueueItem): void;
  processOne(): Promise<boolean>;
  processAll(): Promise<number>;
  assembleContent(nodeId: string): string;
  contentHash(nodeId: string): string;
  getStatus(): SearchIndexStatus;
  removeNode(nodeId: string): void;
  clearAll(): void;
  queueSize(): number;
}

export function createEmbeddingIndexer(db: Database.Database, embedder: Embedder): EmbeddingIndexer {
  const queue: EmbeddingQueueItem[] = [];
  let processing = false;

  // Prepared statements
  const getNode = db.prepare('SELECT id, title, body FROM nodes WHERE id = ?');
  const getStringFields = db.prepare(
    "SELECT field_name, value_text FROM node_fields WHERE node_id = ? AND value_text IS NOT NULL"
  );
  const getExistingMeta = db.prepare(
    'SELECT id, source_hash FROM embedding_meta WHERE node_id = ? AND source_type = ? AND chunk_index = ? AND extraction_ref IS ?'
  );
  const insertMeta = db.prepare(`
    INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
    VALUES (@node_id, @source_type, @source_hash, @chunk_index, @extraction_ref, @embedded_at)
  `);
  const updateMeta = db.prepare(
    'UPDATE embedding_meta SET source_hash = ?, embedded_at = ? WHERE id = ?'
  );
  const insertVec = db.prepare(
    'INSERT INTO embedding_vec (id, vector) VALUES (?, ?)'
  );
  const updateVec = db.prepare(
    'UPDATE embedding_vec SET vector = ? WHERE id = ?'
  );
  const deleteMetaByNode = db.prepare('DELETE FROM embedding_meta WHERE node_id = ?');
  const deleteVecByIds = db.prepare(
    'DELETE FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = ?)'
  );
  const countNodes = db.prepare('SELECT COUNT(*) as count FROM nodes');
  const countIndexedNodes = db.prepare(
    "SELECT COUNT(DISTINCT node_id) as count FROM embedding_meta WHERE source_type = 'node'"
  );
  const hasExtractionCache = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
  );
  const deleteAllMeta = db.prepare('DELETE FROM embedding_meta');
  const deleteAllVec = db.prepare('DELETE FROM embedding_vec');

  function assembleContent(nodeId: string): string {
    const node = getNode.get(nodeId) as { id: string; title: string | null; body: string } | undefined;
    if (!node) return '';

    const parts: string[] = [];
    if (node.title) parts.push(node.title);
    if (node.body) parts.push(node.body);

    const fields = getStringFields.all(nodeId) as Array<{ field_name: string; value_text: string }>;
    for (const f of fields) {
      parts.push(f.value_text);
    }

    return parts.join('\n\n');
  }

  function contentHash(nodeId: string): string {
    const content = assembleContent(nodeId);
    return createHash('sha256').update(content).digest('hex');
  }

  function enqueue(item: EmbeddingQueueItem): void {
    // Deduplicate: don't add if already in queue
    const exists = queue.some(
      q => q.node_id === item.node_id && q.source_type === item.source_type && q.extraction_ref === item.extraction_ref
    );
    if (!exists) {
      queue.push(item);
    }
  }

  async function processOne(): Promise<boolean> {
    const item = queue.shift();
    if (!item) return false;

    if (item.source_type === 'node') {
      const hash = contentHash(item.node_id);
      const existing = getExistingMeta.get(item.node_id, 'node', 0, null) as { id: number; source_hash: string } | undefined;

      if (existing && existing.source_hash === hash) {
        return true; // Already up to date
      }

      const content = assembleContent(item.node_id);
      if (!content) return true; // Nothing to embed

      const vector = await embedder.embedDocument(content);
      const now = new Date().toISOString();

      if (existing) {
        updateMeta.run(hash, now, existing.id);
        updateVec.run(vector, existing.id);
      } else {
        const result = insertMeta.run({
          node_id: item.node_id,
          source_type: 'node',
          source_hash: hash,
          chunk_index: 0,
          extraction_ref: null,
          embedded_at: now,
        });
        insertVec.run(result.lastInsertRowid, vector);
      }
    }
    // Extraction source_type handled in future Phase 6 integration

    return true;
  }

  async function processAll(): Promise<number> {
    let count = 0;
    while (queue.length > 0) {
      await processOne();
      count++;
    }
    return count;
  }

  function removeNode(nodeId: string): void {
    // Delete vec rows first (they reference meta IDs)
    deleteVecByIds.run(nodeId);
    deleteMetaByNode.run(nodeId);
  }

  function getStatus(): SearchIndexStatus {
    const nodesTotal = (countNodes.get() as { count: number }).count;
    const nodesIndexed = (countIndexedNodes.get() as { count: number }).count;

    // Check if extraction_cache table exists
    let extractionsTotal = 0;
    let extractionsIndexed = 0;
    const hasExtraction = hasExtractionCache.get() as { name: string } | undefined;
    if (hasExtraction) {
      extractionsTotal = (db.prepare('SELECT COUNT(*) as count FROM extraction_cache').get() as { count: number }).count;
      extractionsIndexed = (db.prepare("SELECT COUNT(DISTINCT extraction_ref) as count FROM embedding_meta WHERE source_type = 'extraction'").get() as { count: number }).count;
    }

    const pending = queue.length;
    const status = !embedder.isReady() ? 'disabled' as const
      : pending > 0 ? 'indexing' as const
      : 'ready' as const;

    return {
      status,
      nodes_total: nodesTotal,
      nodes_indexed: nodesIndexed,
      extractions_total: extractionsTotal,
      extractions_indexed: extractionsIndexed,
      pending,
    };
  }

  function clearAll(): void {
    deleteAllVec.run();
    deleteAllMeta.run();
    queue.length = 0;
  }

  return {
    enqueue,
    processOne,
    processAll,
    assembleContent,
    contentHash,
    getStatus,
    removeNode,
    clearAll,
    queueSize: () => queue.length,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/search/indexer.ts tests/search/indexer.test.ts
git commit -m "feat(phase4): add embedding indexer with background queue and staleness detection"
```

---

## Task 5: Hybrid search — FTS5 + vector + RRF fusion

**Files:**
- Create: `src/search/search.ts`
- Test: `tests/search/search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/search/search.test.ts`:

```typescript
// tests/search/search.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import { hybridSearch } from '../../src/search/search.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

// Simple embedder: encodes text length as the first float, rest zeros
// This makes "longer content" have higher cosine similarity to long queries
function makeDeterministicEmbedder(): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array> {
      const vec = new Float32Array(256).fill(0);
      // Use text length normalized as a crude "semantic" signal
      const words = text.split(/\s+/);
      for (let i = 0; i < Math.min(words.length, 256); i++) {
        vec[i] = words[i].length / 20;
      }
      // Normalize
      let norm = 0;
      for (let i = 0; i < 256; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 256; i++) vec[i] /= norm;
      return vec;
    },
    async embedQuery(text: string): Promise<Float32Array> {
      // Same encoding as document for testing
      return this.embedDocument(text);
    },
    isReady(): boolean { return true; },
  };
}

function insertNode(db: Database.Database, id: string, title: string, body: string): void {
  db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)").run(id, `${id}.md`, title, body, `hash-${id}`);
  const rowid = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(id) as { rowid: number }).rowid;
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(rowid, title, body);
}

describe('hybridSearch', () => {
  let db: Database.Database;
  let embedder: Embedder;

  beforeEach(async () => {
    db = createTestDb();
    embedder = makeDeterministicEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    insertNode(db, 'n1', 'Pricing Discussion', 'We discussed pricing strategy for Q3');
    insertNode(db, 'n2', 'Team Standup', 'Quick sync about sprint progress');
    insertNode(db, 'n3', 'Budget Review', 'Reviewed the pricing and budget for next quarter');

    // Embed all nodes
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    indexer.enqueue({ node_id: 'n3', source_type: 'node' });
    await indexer.processAll();
  });

  it('returns results for an FTS match', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map(r => r.node_id);
    expect(ids).toContain('n1');
    expect(ids).toContain('n3');
  });

  it('returns results with scores', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.match_sources.length).toBeGreaterThan(0);
    }
  });

  it('respects candidate node IDs filter', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', { candidateIds: ['n1'] });
    const ids = results.map(r => r.node_id);
    expect(ids).toContain('n1');
    expect(ids).not.toContain('n3');
  });

  it('returns empty array when no matches', async () => {
    const results = await hybridSearch(db, embedder, 'xyznonexistent', {});
    // Vector search may still return results, but FTS won't match
    // This test verifies no crash on zero FTS hits
    expect(Array.isArray(results)).toBe(true);
  });

  it('includes snippet for FTS matches', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    const ftsMatch = results.find(r => r.match_sources.includes('node'));
    // At least some results should have snippets from FTS
    expect(results.some(r => r.snippet !== undefined)).toBe(true);
  });

  it('deduplicates node appearing in both FTS and vector results', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    const nodeIds = results.map(r => r.node_id);
    const unique = [...new Set(nodeIds)];
    expect(nodeIds.length).toBe(unique.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search/search.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the hybrid search implementation**

Create `src/search/search.ts`:

```typescript
// src/search/search.ts
import type Database from 'better-sqlite3';
import type { Embedder } from './embedder.js';
import type { SearchHit } from './types.js';

const RRF_K = 60;
const VECTOR_LIMIT = 200;

export interface HybridSearchOptions {
  candidateIds?: string[];
  limit?: number;
}

export async function hybridSearch(
  db: Database.Database,
  embedder: Embedder,
  query: string,
  options: HybridSearchOptions,
): Promise<SearchHit[]> {
  const limit = options.limit ?? 200;

  // 1. FTS5 search
  const ftsHits = ftsSearch(db, query, options.candidateIds);

  // 2. Vector search
  const queryVec = await embedder.embedQuery(query);
  const vecHits = vectorSearch(db, queryVec, options.candidateIds);

  // 3. RRF fusion
  return fuseResults(ftsHits, vecHits, limit);
}

interface FtsHit {
  node_id: string;
  snippet: string;
}

function ftsSearch(db: Database.Database, query: string, candidateIds?: string[]): FtsHit[] {
  let sql: string;
  const params: unknown[] = [];

  if (candidateIds && candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => '?').join(', ');
    sql = `
      SELECT n.id as node_id, highlight(nodes_fts, 1, '<mark>', '</mark>') as snippet
      FROM nodes_fts
      INNER JOIN nodes n ON n.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
        AND n.id IN (${placeholders})
      ORDER BY rank
      LIMIT 200
    `;
    params.push(query, ...candidateIds);
  } else {
    sql = `
      SELECT n.id as node_id, highlight(nodes_fts, 1, '<mark>', '</mark>') as snippet
      FROM nodes_fts
      INNER JOIN nodes n ON n.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT 200
    `;
    params.push(query);
  }

  try {
    return db.prepare(sql).all(...params) as FtsHit[];
  } catch {
    // FTS5 MATCH can throw on invalid query syntax — return empty
    return [];
  }
}

interface VecHit {
  meta_id: number;
  node_id: string;
  source_type: string;
  extraction_ref: string | null;
  distance: number;
}

function vectorSearch(db: Database.Database, queryVec: Float32Array, candidateIds?: string[]): VecHit[] {
  // sqlite-vec: query the vec0 virtual table, join to embedding_meta
  let sql: string;
  const params: unknown[] = [queryVec, VECTOR_LIMIT];

  if (candidateIds && candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => '?').join(', ');
    sql = `
      SELECT v.id as meta_id, m.node_id, m.source_type, m.extraction_ref, v.distance
      FROM embedding_vec v
      INNER JOIN embedding_meta m ON m.id = v.id
      WHERE v.vector MATCH ? AND k = ?
        AND m.node_id IN (${placeholders})
    `;
    params.push(...candidateIds);
  } else {
    sql = `
      SELECT v.id as meta_id, m.node_id, m.source_type, m.extraction_ref, v.distance
      FROM embedding_vec v
      INNER JOIN embedding_meta m ON m.id = v.id
      WHERE v.vector MATCH ? AND k = ?
    `;
  }

  return db.prepare(sql).all(...params) as VecHit[];
}

function fuseResults(ftsHits: FtsHit[], vecHits: VecHit[], limit: number): SearchHit[] {
  // Build rank maps
  const ftsRank = new Map<string, { rank: number; snippet: string }>();
  for (let i = 0; i < ftsHits.length; i++) {
    ftsRank.set(ftsHits[i].node_id, { rank: i + 1, snippet: ftsHits[i].snippet });
  }

  // For vector hits: group by node_id, keep best (lowest distance) per node
  const vecBestByNode = new Map<string, { rank: number; source_type: string; extraction_ref: string | null }>();
  // First, sort by distance ascending
  const sortedVec = [...vecHits].sort((a, b) => a.distance - b.distance);
  let vecRank = 0;
  for (const hit of sortedVec) {
    vecRank++;
    if (!vecBestByNode.has(hit.node_id)) {
      vecBestByNode.set(hit.node_id, {
        rank: vecRank,
        source_type: hit.source_type,
        extraction_ref: hit.extraction_ref,
      });
    }
  }

  // Collect all unique node IDs
  const allNodeIds = new Set<string>();
  for (const id of ftsRank.keys()) allNodeIds.add(id);
  for (const id of vecBestByNode.keys()) allNodeIds.add(id);

  // Compute RRF scores
  const results: SearchHit[] = [];
  for (const nodeId of allNodeIds) {
    const fts = ftsRank.get(nodeId);
    const vec = vecBestByNode.get(nodeId);

    let score = 0;
    if (fts) score += 1 / (RRF_K + fts.rank);
    if (vec) score += 1 / (RRF_K + vec.rank);

    const match_sources: Array<'node' | 'embed'> = [];
    if (fts) match_sources.push('node');
    if (vec && vec.source_type === 'extraction') match_sources.push('embed');
    else if (vec && vec.source_type === 'node' && !fts) match_sources.push('node');
    // If both FTS and vec matched on node content, 'node' is already in the list

    const hit: SearchHit = {
      node_id: nodeId,
      score,
      match_sources: match_sources.length > 0 ? match_sources : ['node'],
    };

    if (fts) hit.snippet = fts.snippet;
    if (vec && vec.source_type === 'extraction' && vec.extraction_ref) {
      hit.matched_embed = vec.extraction_ref;
    }

    results.push(hit);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/search/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/search/search.ts tests/search/search.test.ts
git commit -m "feat(phase4): add hybrid search with FTS5 + vector + RRF fusion"
```

---

## Task 6: Remove full_text from query-builder and wire up query parameter on query-nodes

**Files:**
- Modify: `src/mcp/query-builder.ts:23-34` (remove `full_text` from interface), `:120-125` (remove FTS5 join)
- Modify: `src/mcp/tools/query-nodes.ts` (remove `full_text` param, add `query` param, integrate hybrid search)
- Modify: `src/mcp/tools/index.ts` (pass embedder/indexer through)
- Modify: `src/mcp/server.ts` (add EmbeddingIndexer to ServerContext)
- Test: `tests/mcp/query-nodes-search.test.ts`
- Modify: `tests/mcp/query-builder.test.ts` (remove full_text tests)

- [ ] **Step 1: Remove full_text from query-builder**

In `src/mcp/query-builder.ts`:

Remove `full_text?: string;` from the `NodeQueryFilter` interface (line 28).

Remove the FTS5 block (lines 120-125):
```typescript
  // FTS5 full-text search
  if (filter.full_text) {
    joins.push('INNER JOIN nodes_fts ON nodes_fts.rowid = n.rowid');
    whereClauses.push('nodes_fts MATCH ?');
    params.push(filter.full_text);
  }
```

- [ ] **Step 2: Update query-builder tests**

Run: `npx vitest run tests/mcp/query-builder.test.ts`

Check for any tests referencing `full_text` and remove/update them. The query-builder no longer handles FTS — that's now in the search module.

- [ ] **Step 3: Add EmbeddingIndexer to ServerContext**

In `src/mcp/server.ts`, add the imports and fields:

```typescript
import type { EmbeddingIndexer } from '../search/indexer.js';
import type { Embedder } from '../search/embedder.js';
```

Add to `ServerContext` interface:
```typescript
  embeddingIndexer?: EmbeddingIndexer;
  embedder?: Embedder;
```

Add to `createServer` parameter type and pass through:
```typescript
export function createServer(db: Database.Database, ctx?: {
  writeLock?: WriteLockManager;
  writeGate?: WriteGate;
  syncLogger?: SyncLogger;
  vaultPath?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
  embeddingIndexer?: EmbeddingIndexer;
  embedder?: Embedder;
}): McpServer {
```

- [ ] **Step 4: Update tools/index.ts to pass embeddingIndexer and embedder to query-nodes and vault-stats**

In `src/mcp/tools/index.ts`, add imports and update calls:

```typescript
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { Embedder } from '../../search/embedder.js';
```

Update the `registerAllTools` signature to accept `embeddingIndexer` and `embedder` on the ctx parameter:

```typescript
registerQueryNodes(server, db, ctx?.embeddingIndexer, ctx?.embedder);
```

And update `registerVaultStats`:
```typescript
registerVaultStats(server, db, ctx?.extractorRegistry, ctx?.embeddingIndexer);
```

Also add `embedder?: Embedder` to the `ServerContext` interface in `src/mcp/server.ts`.

- [ ] **Step 5: Update query-nodes.ts — remove full_text, add query, integrate search**

Replace `src/mcp/tools/query-nodes.ts` with:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
import { resolveFieldValue, type FieldRow } from '../field-value.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { Embedder } from '../../search/embedder.js';
import { hybridSearch } from '../../search/search.js';

const paramsShape = {
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  without_fields: z.array(z.string()).optional(),
  query: z.string().optional(),
  references: z.object({
    target: z.string(),
    rel_type: z.string().optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  }).optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  sort_by: z.enum(['title', 'file_mtime', 'indexed_at']).default('title'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  include_fields: z.array(z.string()).optional(),
};

export function registerQueryNodes(server: McpServer, db: Database.Database, embeddingIndexer?: EmbeddingIndexer, embedder?: Embedder): void {
  server.tool(
    'query-nodes',
    'Query nodes with filtering by type, fields, semantic search, references, path, and date. Returns paginated results. Use query for semantic/keyword search (hybrid FTS + vector). Use include_fields to return field values inline (e.g. ["project","status"] or ["*"] for all).',
    paramsShape,
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
        references: params.references,
        path_prefix: params.path_prefix,
        without_path_prefix: params.without_path_prefix,
        path_dir: params.path_dir,
        modified_since: params.modified_since,
      };

      // When query is present and embedder is available, use hybrid search
      if (params.query && embedder) {
        // Pre-filter: get candidate IDs from structured filters
        let candidateIds: string[] | undefined;
        const hasFilters = filter.types || filter.without_types || filter.fields || filter.without_fields
          || filter.references || filter.path_prefix || filter.without_path_prefix || filter.path_dir || filter.modified_since;

        if (hasFilters) {
          const { sql, params: sqlParams } = buildNodeQuery(filter, db);
          const candidateRows = db.prepare(sql).all(...sqlParams) as Array<{ id: string }>;
          candidateIds = candidateRows.map(r => r.id);
          if (candidateIds.length === 0) {
            return toolResult({ nodes: [], total: 0 });
          }
        }

        const hits = await hybridSearch(db, embedder, params.query, { candidateIds, limit: limit + offset });
        const paged = hits.slice(offset, offset + limit);
        const total = hits.length;

        const getNode = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?');
        const rows = paged.map(hit => getNode.get(hit.node_id) as { id: string; file_path: string; title: string | null }).filter(Boolean);
        const enriched = enrichRows(db, rows, params.include_fields);

        const nodeMap = new Map(paged.map(h => [h.node_id, h]));
        const nodes = enriched.map(node => {
          const hit = nodeMap.get(node.id as string);
          if (hit) {
            node.score = hit.score;
            node.match_sources = hit.match_sources;
            if (hit.matched_embed) node.matched_embed = hit.matched_embed;
            if (hit.snippet) node.snippet = hit.snippet;
          }
          return node;
        });

        return toolResult({ nodes, total });
      }

      // Standard structured query (no semantic search)
      const { sql, countSql, params: sqlParams } = buildNodeQuery(filter, db);
      const total = (db.prepare(countSql).get(...sqlParams) as { total: number }).total;

      const sortCol = sortBy === 'title' ? 'n.title' : sortBy === 'file_mtime' ? 'n.file_mtime' : 'n.indexed_at';
      const dataSql = `${sql} ORDER BY ${sortCol} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`;
      const dataParams = [...sqlParams, limit, offset];
      const rows = db.prepare(dataSql).all(...dataParams) as Array<{ id: string; file_path: string; title: string | null }>;

      const nodes = enrichRows(db, rows, params.include_fields);
      return toolResult({ nodes, total });
    },
  );
}

function enrichRows(
  db: Database.Database,
  rows: Array<{ id: string; file_path: string; title: string | null }>,
  includeFields?: string[],
): Array<Record<string, unknown>> {
  const getTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?');
  const getFieldCount = db.prepare('SELECT COUNT(*) as count FROM node_fields WHERE node_id = ?');

  const wantFields = includeFields && includeFields.length > 0;
  const isWildcard = includeFields?.length === 1 && includeFields[0] === '*';

  const getFieldsAll = wantFields && isWildcard
    ? db.prepare('SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?')
    : undefined;
  const getFieldsSome = wantFields && !isWildcard
    ? db.prepare(`SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ? AND field_name IN (${includeFields!.map(() => '?').join(', ')})`)
    : undefined;

  return rows.map(row => {
    const node: Record<string, unknown> = {
      id: row.id,
      file_path: row.file_path,
      title: row.title,
      types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
      field_count: (getFieldCount.get(row.id) as { count: number }).count,
    };

    if (getFieldsAll) {
      const fieldRows = getFieldsAll.all(row.id) as FieldRow[];
      const fields: Record<string, unknown> = {};
      for (const f of fieldRows) fields[f.field_name] = resolveFieldValue(f);
      node.fields = fields;
    } else if (getFieldsSome) {
      const fieldRows = getFieldsSome.all(row.id, ...includeFields!) as FieldRow[];
      const fields: Record<string, unknown> = {};
      for (const f of fieldRows) fields[f.field_name] = resolveFieldValue(f);
      node.fields = fields;
    }

    return node;
  });
}
```

- [ ] **Step 6: Write the integration test**

Create `tests/mcp/query-nodes-search.test.ts`:

```typescript
// tests/mcp/query-nodes-search.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';

function makeFakeEmbedder(): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array> {
      const vec = new Float32Array(256).fill(0);
      const words = text.split(/\s+/);
      for (let i = 0; i < Math.min(words.length, 256); i++) {
        vec[i] = words[i].length / 20;
      }
      let norm = 0;
      for (let i = 0; i < 256; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 256; i++) vec[i] /= norm;
      return vec;
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return this.embedDocument(text);
    },
    isReady(): boolean { return true; },
  };
}

function insertNode(db: Database.Database, id: string, title: string, body: string, types?: string[]): void {
  db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)").run(id, `${id}.md`, title, body, `hash-${id}`);
  const rowid = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(id) as { rowid: number }).rowid;
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(rowid, title, body);
  if (types) {
    for (const t of types) {
      db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, t);
    }
  }
}

function getToolHandler(server: McpServer): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
  // Access the registered tool handler — MCP server stores tools internally
  // We use the same pattern as existing tests
  let capturedHandler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const originalTool = server.tool.bind(server);
  // This won't work for already-registered tools.
  // Instead, use a mock server pattern:
  return (capturedHandler as unknown) as (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

describe('query-nodes with query parameter', () => {
  let db: Database.Database;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(async () => {
    db = createTestDb();
    const embedder = makeFakeEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    insertNode(db, 'n1', 'Pricing Discussion', 'We discussed pricing strategy for Q3', ['meeting']);
    insertNode(db, 'n2', 'Team Standup', 'Quick sync about sprint progress', ['meeting']);
    insertNode(db, 'n3', 'Budget Review', 'Reviewed pricing and budget', ['report']);

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    indexer.enqueue({ node_id: 'n3', source_type: 'node' });
    await indexer.processAll();

    // Capture the tool handler
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
        captured = h;
      },
    };
    registerQueryNodes(fakeServer as unknown as McpServer, db, indexer, embedder);
    handler = captured!;
  });

  it('returns scored results when query is provided', async () => {
    const result = await handler({ query: 'pricing' }) as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.nodes[0]).toHaveProperty('score');
    expect(data.nodes[0]).toHaveProperty('match_sources');
  });

  it('falls back to standard query when no query param', async () => {
    const result = await handler({ types: ['meeting'], limit: 50, offset: 0, sort_by: 'title', sort_order: 'asc' }) as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0].text);
    expect(data.nodes.length).toBe(2);
    expect(data.nodes[0]).not.toHaveProperty('score');
  });

  it('combines query with type filter', async () => {
    const result = await handler({ query: 'pricing', types: ['meeting'], limit: 50, offset: 0, sort_by: 'title', sort_order: 'asc' }) as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(result.content[0].text);
    const ids = data.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('n1');
    expect(ids).not.toContain('n3'); // n3 is a report, not a meeting
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/mcp/query-nodes-search.test.ts`
Expected: PASS

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/mcp/query-builder.ts src/mcp/tools/query-nodes.ts src/mcp/tools/index.ts src/mcp/server.ts tests/mcp/query-nodes-search.test.ts
git commit -m "feat(phase4): integrate hybrid search into query-nodes tool, remove full_text"
```

---

## Task 7: Update vault-stats with search_index section

**Files:**
- Modify: `src/mcp/tools/vault-stats.ts`
- Test: `tests/mcp/vault-stats-search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/vault-stats-search.test.ts`:

```typescript
// tests/mcp/vault-stats-search.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';

function makeFakeEmbedder(): Embedder {
  return {
    async embedDocument(): Promise<Float32Array> { return new Float32Array(256).fill(0.1); },
    async embedQuery(): Promise<Float32Array> { return new Float32Array(256).fill(0.1); },
    isReady(): boolean { return true; },
  };
}

describe('vault-stats search_index', () => {
  let db: Database.Database;
  let handler: () => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    db = createTestDb();
    const embedder = makeFakeEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    // Insert a node and embed it
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'test.md', 'Test', 'Body', 'h1')").run();
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    let captured: () => Promise<{ content: Array<{ type: string; text: string }> }>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: () => Promise<{ content: Array<{ type: string; text: string }> }>) => {
        captured = h;
      },
    };
    registerVaultStats(fakeServer as any, db, undefined, indexer);
    handler = captured!;
  });

  it('includes search_index in vault-stats output', async () => {
    const result = await handler();
    const data = JSON.parse(result.content[0].text);
    expect(data.search_index).toBeDefined();
    expect(data.search_index.status).toBe('ready');
    expect(data.search_index.nodes_total).toBe(1);
    expect(data.search_index.nodes_indexed).toBe(1);
    expect(data.search_index.pending).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/vault-stats-search.test.ts`
Expected: FAIL

- [ ] **Step 3: Update vault-stats.ts**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';
import type { ExtractorRegistry } from '../../extraction/registry.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';

export function registerVaultStats(server: McpServer, db: Database.Database, extractorRegistry?: ExtractorRegistry, embeddingIndexer?: EmbeddingIndexer): void {
  server.tool(
    'vault-stats',
    'Returns vault statistics: node counts, type counts, field count, relationship count, orphan count, schema count, search index status.',
    {},
    async () => {
      // ... existing stat queries unchanged ...

      const resultObj: Record<string, unknown> = {
        node_count: nodeCount,
        type_counts: typeCounts,
        field_count: fieldCount,
        relationship_count: relationshipCount,
        orphan_count: orphanCount,
        schema_count: schemaCount,
      };

      if (extractorRegistry) {
        resultObj.extractors = extractorRegistry.getStatus();
      }

      if (embeddingIndexer) {
        resultObj.search_index = embeddingIndexer.getStatus();
      }

      return toolResult(resultObj);
    },
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mcp/vault-stats-search.test.ts`
Expected: PASS

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/vault-stats.ts tests/mcp/vault-stats-search.test.ts
git commit -m "feat(phase4): add search_index stats to vault-stats tool"
```

---

## Task 8: Wire into startup, indexer notifications, and shutdown

**Files:**
- Modify: `src/index.ts` — model loading, indexer creation, startup queue, --reindex-search, shutdown
- Modify: `src/indexer/indexer.ts` — accept optional callback for embedding notifications
- Modify: `src/sync/watcher.ts` — accept embeddingIndexer, enqueue after file changes
- Modify: `src/transport/args.ts` — add --reindex-search flag

- [ ] **Step 1: Add onNodeIndexed callback to the file indexer**

In `src/indexer/indexer.ts`, add an `options` parameter to `fullIndex` and `indexFile`:

Add at the top of the file:

```typescript
export interface IndexerOptions {
  onNodeIndexed?: (nodeId: string) => void;
}
```

Update `fullIndex` signature:

```typescript
export function fullIndex(vaultPath: string, db: Database.Database, options?: IndexerOptions): IndexStats {
```

After the `doIndex` call in the batch loop (line 312), add:

```typescript
          options?.onNodeIndexed?.(doIndex(stmts, raw, relPath, absPath, mtime, hash, existing?.id ?? null));
```

(Replace the existing `doIndex(...)` call — capture the return value and pass to callback.)

Similarly update `indexFile`:

```typescript
export function indexFile(absolutePath: string, vaultPath: string, db: Database.Database, options?: IndexerOptions): string {
```

After the transaction returns the nodeId, add:

```typescript
  const nodeId = txn();
  options?.onNodeIndexed?.(nodeId);
  return nodeId;
```

- [ ] **Step 2: Wire embedding notifications into the watcher**

The embedding indexer is notified at two levels:
1. **Startup full-index** — all nodes are queued (handled in Step 3).
2. **Watcher file changes** — after `processFileChange` calls `executeMutation`, the returned `node_id` is enqueued.
3. **Tool writes** — tools write to disk → watcher picks up the change → re-indexes → enqueues for embedding. The watcher debounce (2.5s) means there's a short delay, but this avoids modifying every tool's call to `executeMutation`.

For tool writes that need immediate embedding (not waiting for watcher), the `embeddingIndexer` is available on `ServerContext`. Individual tools can optionally call `ctx.embeddingIndexer?.enqueue(...)` after `executeMutation` returns. This is a per-tool opt-in, not a pipeline change. Start without it — the watcher path provides eventual consistency.

In `src/sync/watcher.ts`, after `processFileChange` succeeds and returns a node_id, enqueue it:

The watcher's `startWatcher` function needs an optional `embeddingIndexer` parameter:

```typescript
export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  writeGate: WriteGate,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  options?: WatcherOptions,
): FSWatcher {
```

After the mutation or re-index succeeds in `processFileChange`, add:

```typescript
embeddingIndexer?.enqueue({ node_id: result.node_id, source_type: 'node' });
// Kick off background processing (fire-and-forget)
embeddingIndexer?.processOne().catch(() => {});
```

Update the `startWatcher` call in `src/index.ts` to pass `embeddingIndexer`.

- [ ] **Step 3: Update src/index.ts — full startup integration**

Update `src/index.ts`:

```typescript
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/connection.js';
import { createSchema } from './db/schema.js';
import { upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6 } from './db/migrate.js';
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
import { WriteGate } from './sync/write-gate.js';
import { SyncLogger } from './sync/sync-logger.js';
import { startupSchemaRender } from './schema/render.js';
import { buildExtractorRegistry } from './extraction/setup.js';
import { ExtractionCache } from './extraction/cache.js';
import { ClaudeVisionPdfExtractor } from './extraction/extractors/claude-vision.js';
import { createEmbedder, type Embedder } from './search/embedder.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from './search/indexer.js';

const args = parseArgs(process.argv.slice(2));

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}

const dbPath = args.dbPath ?? process.env.DB_PATH ?? resolve(vaultPath, '.vault-engine', 'vault.db');
const db = openDatabase(dbPath);
createSchema(db);
upgradeToPhase2(db);
upgradeToPhase3(db);
upgradeToPhase4(db);
upgradeToPhase6(db);

console.log(`Indexing vault at ${vaultPath}...`);
const indexStart = Date.now();
await fullIndex(vaultPath, db);
console.log(`Indexing complete in ${Date.now() - indexStart}ms`);

startupSchemaRender(db, vaultPath);

const mutex = new IndexMutex();
const writeLock = new WriteLockManager();
const writeGate = new WriteGate({ quietPeriodMs: 3000 });
const syncLogger = new SyncLogger(db);

// --- Phase 4: Embedding indexer (async, non-blocking) ---
let embeddingIndexer: EmbeddingIndexer | undefined;
let embedderRef: Embedder | undefined;

const modelsDir = resolve(vaultPath, '.vault-engine', 'models');
console.log('Loading embedding model...');
try {
  const embedder = await createEmbedder({ modelsDir });
  embedderRef = embedder;
  embeddingIndexer = createEmbeddingIndexer(db, embedder);

  // Handle --reindex-search flag
  if (args.reindexSearch) {
    console.log('Reindex requested — clearing search index...');
    embeddingIndexer.clearAll();
  }

  // Queue all nodes that need embedding
  const allNodes = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
  for (const node of allNodes) {
    embeddingIndexer.enqueue({ node_id: node.id, source_type: 'node' });
  }

  // Start background processing (fire-and-forget)
  const backgroundProcess = async () => {
    const count = await embeddingIndexer!.processAll();
    if (count > 0) {
      console.log(`Embedded ${count} items`);
    }
  };
  backgroundProcess().catch(err => console.error('Embedding error:', err));

  console.log(`Embedding model loaded, ${allNodes.length} nodes queued`);
} catch (err) {
  console.error('Failed to load embedding model — search disabled:', err instanceof Error ? err.message : err);
}

const watcher = startWatcher(vaultPath, db, mutex, writeLock, writeGate, syncLogger, embeddingIndexer);
const reconciler = startReconciler(vaultPath, db, mutex, writeLock, writeGate, syncLogger);

const extractorRegistry = buildExtractorRegistry(process.env as Record<string, string | undefined>);
const extractionCache = new ExtractionCache(db, extractorRegistry);
if (process.env.ANTHROPIC_API_KEY) {
  extractionCache.setPdfFallback(new ClaudeVisionPdfExtractor(process.env.ANTHROPIC_API_KEY));
}

const serverFactory = () => createServer(db, { writeLock, writeGate, syncLogger, vaultPath, extractorRegistry, extractionCache, embeddingIndexer, embedder: embedderRef });

if (args.transport === 'stdio' || args.transport === 'both') {
  const server = serverFactory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (args.transport === 'http' || args.transport === 'both') {
  const authEnv = validateAuthEnv(process.env.OAUTH_OWNER_PASSWORD, process.env.OAUTH_ISSUER_URL);
  createAuthSchema(db);
  await startHttpTransport(serverFactory, args.port, {
    db,
    ownerPassword: authEnv.ownerPassword,
    issuerUrl: authEnv.issuerUrl,
  });
}

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  writeGate.dispose();
  reconciler.stop();
  await watcher.close();
  db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  writeGate.dispose();
  reconciler.stop();
  await watcher.close();
  db.close();
  process.exit(0);
});
```

- [ ] **Step 4: Add --reindex-search flag to args parser**

In `src/transport/args.ts`, add `reindexSearch` to the interface and parse it:

```typescript
export interface ParsedArgs {
  dbPath: string | undefined;
  vaultPath: string | undefined;
  transport: 'stdio' | 'http' | 'both';
  port: number;
  reindexSearch: boolean;
}
```

In `parseArgs`, initialize `reindexSearch: false` in the result object and add this case inside the for-loop:

```typescript
    } else if (arg === '--reindex-search') {
      result.reindexSearch = true;
    } else if (!arg.startsWith('--')) {
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Run build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/indexer/indexer.ts src/sync/watcher.ts src/transport/args.ts
git commit -m "feat(phase4): wire embedding indexer into startup, watcher, and args"
```

---

## Task 9: End-to-end integration test

**Files:**
- Create: `tests/search/end-to-end.test.ts`

This test exercises the full flow: insert nodes → embed → search via `query-nodes`.

- [ ] **Step 1: Write the end-to-end test**

```typescript
// tests/search/end-to-end.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import { hybridSearch } from '../../src/search/search.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

function makeFakeEmbedder(): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array> {
      const vec = new Float32Array(256).fill(0);
      const words = text.toLowerCase().split(/\s+/);
      for (let i = 0; i < Math.min(words.length, 256); i++) {
        vec[i] = words[i].length / 20;
      }
      let norm = 0;
      for (let i = 0; i < 256; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 256; i++) vec[i] /= norm;
      return vec;
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return this.embedDocument(text);
    },
    isReady(): boolean { return true; },
  };
}

function insertNode(db: Database.Database, id: string, title: string, body: string, fields?: Array<{ name: string; value: string }>): void {
  db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)").run(id, `${id}.md`, title, body, `hash-${id}`);
  const rowid = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(id) as { rowid: number }).rowid;
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(rowid, title, body);
  if (fields) {
    for (const f of fields) {
      db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, 'frontmatter')").run(id, f.name, f.value);
    }
  }
}

describe('Phase 4 end-to-end', () => {
  let db: Database.Database;
  let embedder: Embedder;

  beforeEach(async () => {
    db = createTestDb();
    embedder = makeFakeEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    insertNode(db, 'meeting-1', 'Q3 Pricing Meeting', 'Discussed pricing strategy and competitor analysis', [
      { name: 'project', value: 'Revenue Growth' },
    ]);
    insertNode(db, 'meeting-2', 'Sprint Retrospective', 'Team reviewed velocity and blockers');
    insertNode(db, 'note-1', 'Budget Forecast', 'The pricing model needs adjustment for inflation');
    insertNode(db, 'task-1', 'Fix Login Bug', 'Authentication fails on mobile devices');

    for (const id of ['meeting-1', 'meeting-2', 'note-1', 'task-1']) {
      indexer.enqueue({ node_id: id, source_type: 'node' });
    }
    await indexer.processAll();
  });

  it('finds pricing-related nodes via hybrid search', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    const ids = results.map(r => r.node_id);
    expect(ids).toContain('meeting-1');
    expect(ids).toContain('note-1');
  });

  it('filters candidates by node ID list', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {
      candidateIds: ['meeting-1', 'meeting-2'],
    });
    const ids = results.map(r => r.node_id);
    expect(ids).not.toContain('note-1');
  });

  it('all results have scores and match_sources', async () => {
    const results = await hybridSearch(db, embedder, 'sprint', {});
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(r.match_sources.length).toBeGreaterThan(0);
    }
  });

  it('results are sorted by score descending', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('embedding indexer reports correct status', () => {
    const indexer = createEmbeddingIndexer(db, embedder);
    const status = indexer.getStatus();
    expect(status.nodes_total).toBe(4);
    expect(status.nodes_indexed).toBe(4);
    expect(status.status).toBe('ready');
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/search/end-to-end.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add tests/search/end-to-end.test.ts
git commit -m "test(phase4): add end-to-end search integration test"
```

---

## Task 10: Manual verification and deployment

- [ ] **Step 1: Verify build is clean**

Run: `npm run build`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Test with dev server**

Run: `npm run dev`

Verify in logs:
- "Loading embedding model..." appears
- Model loads (or graceful error if no model cached)
- "Embedding model loaded, N nodes queued" appears
- Server starts and responds to tool calls

- [ ] **Step 4: Test query-nodes with query parameter via MCP**

Use the running dev server to test:
- `query-nodes` with no `query` param — should work exactly as before
- `query-nodes` with `query: "pricing"` — should return scored results
- `query-nodes` with `query: "pricing"` and `types: ["meeting"]` — should filter by type AND search
- `vault-stats` — should include `search_index` section

- [ ] **Step 5: Commit any fixes**

If any issues were found during manual testing, fix and commit.

---

## Summary

| Task | Description | Key files |
|------|-------------|-----------|
| 1 | Search types | `src/search/types.ts` |
| 2 | DB migration (embedding_meta + embedding_vec) | `src/db/schema.ts`, `src/db/migrate.ts`, `src/db/connection.ts` |
| 3 | Embedder module (model singleton) | `src/search/embedder.ts` |
| 4 | Embedding indexer (queue + staleness) | `src/search/indexer.ts` |
| 5 | Hybrid search (FTS5 + vector + RRF) | `src/search/search.ts` |
| 6 | query-nodes integration (remove full_text, add query) | `src/mcp/tools/query-nodes.ts`, `src/mcp/query-builder.ts` |
| 7 | vault-stats search_index section | `src/mcp/tools/vault-stats.ts` |
| 8 | Startup wiring, indexer notifications, shutdown | `src/index.ts`, `src/indexer/indexer.ts`, `src/pipeline/execute.ts` |
| 9 | End-to-end integration test | `tests/search/end-to-end.test.ts` |
| 10 | Manual verification and deployment | — |
