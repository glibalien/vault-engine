# Chunking and Extraction Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long-form content searchable by chunking >8K-token text inside the embedder worker, and begin embedding cached extractions (audio transcriptions, PDFs, images) so they're reachable via semantic search.

**Architecture:** Pure chunking function lives in `src/search/chunker.ts` and is called from `embedder-worker.ts` using the Nomic tokenizer already reachable at `extractor.tokenizer`. The IPC protocol returns `vectors: number[][]` (array of vectors per embed call). The indexer stores one `embedding_meta`/`embedding_vec` row per chunk, using delete-and-insert when content changes. A shared `src/extraction/resolve.ts` helper is extracted so the indexer can find non-markdown embeds without duplicating assembler logic. Extraction items (`source_type='extraction'`) are enqueued automatically when a node is enqueued. A new `meta` table holds a `search_version` key; bumping the version triggers a full clear+re-embed at startup.

**Tech Stack:** TypeScript (ESM), `@huggingface/transformers` for the tokenizer + feature-extraction pipeline, `better-sqlite3` with `sqlite-vec`, Node IPC (forked subprocess), Vitest.

---

## Non-Goals

- No changes to MCP tool contracts. `query-nodes` and `read-embedded` behavior is unchanged.
- No FTS changes. FTS5 still operates on whole-node text.
- No new extraction discovery syntax beyond `![[embed]]`.
- No cross-node joins.

## File Map

### New
- `src/search/chunker.ts` — pure chunking function (tokenizer injected).
- `src/extraction/resolve.ts` — shared embed-ref → filePath resolver.
- `src/db/search-version.ts` — version metadata API + `CURRENT_SEARCH_VERSION`.
- `tests/search/chunker.test.ts` — chunker unit tests.
- `tests/extraction/resolve.test.ts` — resolver unit tests.
- `tests/db/search-version.test.ts` — meta version API tests.

### Modified
- `src/search/embedder-protocol.ts` — `vector: number[]` → `vectors: number[][]`.
- `src/search/embedder-worker.ts` — tokenize, chunk if needed, embed N chunks.
- `src/search/embedder-host.ts` — relay `vectors` array back as `Float32Array[]`.
- `src/search/embedder.ts` — `embedDocument: Promise<Float32Array[]>`.
- `src/search/indexer.ts` — multi-vector storage, extraction pipeline, new optional deps.
- `src/search/search.ts` — `VECTOR_LIMIT = 400`, records `matched_chunk_index`.
- `src/search/types.ts` — `SearchHit.matched_chunk_index?: number`.
- `src/db/schema.ts` — add `meta` table to bootstrap schema.
- `src/db/migrate.ts` — migration that creates `meta` if missing.
- `src/extraction/assembler.ts` — delegate ref resolution to `resolve.ts`.
- `src/index.ts` — run version check at startup, pass `extractionCache` + `vaultPath` to indexer.
- `tests/search/indexer.test.ts` — fake embedder returns `Float32Array[]`; add multi-chunk + extraction tests.
- `tests/search/embedder-host.test.ts` — update to `Float32Array[]` shape; add long-text chunking integration test.
- `tests/search/end-to-end.test.ts` — smoke test for long-body chunking + extraction embedding.

---

## Task 1: Chunker (pure function)

**Files:**
- Create: `src/search/chunker.ts`
- Test: `tests/search/chunker.test.ts`

The chunker is a pure function that takes text, a tokenizer callback (returning a token count), and options. It splits text semantically and returns an array of strings. All knowledge of the Nomic model or the worker stays out — this makes it trivially unit-testable.

**Design notes:**
- Token counting is delegated to the caller. In worker code the callback is `(s) => extractor.tokenizer(s).input_ids.dims[1]`. In tests it's typically a ratio-of-length approximation.
- The split hierarchy is: (1) markdown headings, (2) paragraph breaks `\n\n`, (3) sentence boundaries, (4) hard-split with overlap. Only descend to the next level when the current piece still exceeds the token budget.
- After splitting, greedily **pack** adjacent pieces back up to the budget so we don't emit tiny chunks for every heading.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/search/chunker.test.ts
import { describe, it, expect } from 'vitest';
import { chunkForEmbedding } from '../../src/search/chunker.js';

// Approx 4 chars/token — matches Nomic's real ratio closely enough for tests.
const approxTokenize = (s: string): number => Math.ceil(s.length / 4);

describe('chunkForEmbedding', () => {
  it('returns a single chunk when under the token budget', () => {
    const text = 'Hello world.';
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toEqual(['Hello world.']);
  });

  it('splits on markdown headings when text exceeds budget', () => {
    const text = [
      '## Section A',
      'Alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha.',
      '',
      '## Section B',
      'Beta beta beta beta beta beta beta beta beta beta beta beta beta beta.',
      '',
      '## Section C',
      'Gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma.',
    ].join('\n');
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 30, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]).toContain('Section A');
    expect(chunks[1]).toContain('Section B');
    expect(chunks[2]).toContain('Section C');
  });

  it('splits on paragraphs when a section is still too large', () => {
    const big = 'p' + 'aragraph '.repeat(50);
    const text = `${big}\n\n${big}\n\n${big}`;
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 120, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(130);
    }
  });

  it('splits on sentences when a paragraph is still too large', () => {
    const sentence = 'This is a sentence with some words in it.';
    const paragraph = Array(30).fill(sentence).join(' ');
    const chunks = chunkForEmbedding(paragraph, approxTokenize, { maxTokens: 50, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(60);
    }
  });

  it('hard-splits with overlap when even a sentence exceeds the budget', () => {
    const noBoundaries = 'x'.repeat(4000);
    const chunks = chunkForEmbedding(noBoundaries, approxTokenize, { maxTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(220);
    }
    const tail = chunks[0].slice(-40);
    const head = chunks[1].slice(0, 120);
    expect(head).toContain(tail.slice(-20));
  });

  it('packs small adjacent sections up to the budget', () => {
    const parts = Array.from({ length: 10 }, (_, i) => `## H${i}\nshort body for section ${i}.`);
    const text = parts.join('\n\n');
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 200, overlapTokens: 0 });
    expect(chunks.length).toBeLessThan(5);
  });

  it('returns empty array for empty input', () => {
    expect(chunkForEmbedding('', approxTokenize, { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/search/chunker.test.ts`
Expected: FAIL — module `../../src/search/chunker.js` not found.

- [ ] **Step 3: Implement the chunker**

```typescript
// src/search/chunker.ts
//
// Pure, tokenizer-agnostic chunking for long documents. The caller supplies a
// token-counting callback; in production the Nomic tokenizer via the worker
// pipeline, in tests an approximation. No imports from the worker or model code.

export type Tokenize = (text: string) => number;

export interface ChunkOptions {
  /** Maximum tokens per chunk. Nomic v1.5 context window is 8192. */
  maxTokens: number;
  /** Tokens of overlap when hard-splitting content with no natural boundaries. */
  overlapTokens: number;
}

export function chunkForEmbedding(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  if (text.length === 0) return [];
  if (tokenize(text) <= options.maxTokens) return [text];

  const sections = splitByHeadings(text);
  const split = sections.flatMap(section => splitIfNeeded(section, tokenize, options));
  return pack(split, tokenize, options.maxTokens);
}

function splitByHeadings(text: string): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  const headingRe = /^#{1,6}\s/;
  for (const line of lines) {
    if (headingRe.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections;
}

function splitIfNeeded(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  if (tokenize(text) <= options.maxTokens) return [text];

  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    return paragraphs.flatMap(p => splitIfNeeded(p, tokenize, options));
  }

  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    return sentences.flatMap(s => splitIfNeeded(s, tokenize, options));
  }

  return hardSplit(text, tokenize, options);
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"(\d])/);
  return parts.filter(p => p.length > 0);
}

function hardSplit(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  const chunks: string[] = [];
  const approxCharsPerToken = Math.max(1, Math.ceil(text.length / Math.max(1, tokenize(text))));
  const charBudget = options.maxTokens * approxCharsPerToken;
  const overlapChars = options.overlapTokens * approxCharsPerToken;

  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + charBudget);
    while (end > start && tokenize(text.slice(start, end)) > options.maxTokens) {
      end -= Math.max(1, Math.floor(charBudget * 0.1));
    }
    if (end <= start) {
      end = Math.min(text.length, start + 1);
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

function pack(chunks: string[], tokenize: Tokenize, maxTokens: number): string[] {
  const packed: string[] = [];
  let buffer = '';
  for (const piece of chunks) {
    if (piece.length === 0) continue;
    if (buffer.length === 0) {
      buffer = piece;
      continue;
    }
    const candidate = `${buffer}\n\n${piece}`;
    if (tokenize(candidate) <= maxTokens) {
      buffer = candidate;
    } else {
      packed.push(buffer);
      buffer = piece;
    }
  }
  if (buffer.length > 0) packed.push(buffer);
  return packed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/search/chunker.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/search/chunker.ts tests/search/chunker.test.ts
git commit -m "feat(search): add tokenizer-agnostic chunker for long content"
```

---

## Task 2: Protocol + Embedder interface — vectors array

**Files:**
- Modify: `src/search/embedder-protocol.ts`
- Modify: `src/search/embedder.ts`
- Modify: `src/search/embedder-host.ts`
- Modify: `src/search/embedder-worker.ts` (wrap single vec in `[vec]` for now)
- Modify: `tests/search/embedder-host.test.ts` (update assertions)

This task flips the IPC + interface contract. The worker still embeds a single vector (chunking integration lands in Task 3) but wraps it in an array, so nothing downstream is broken while we work.

- [ ] **Step 1: Update the protocol type**

Edit `src/search/embedder-protocol.ts` — replace the `EmbedResponse` interface:

```typescript
/** Child → parent: embedding result. Returns one vector per chunk. */
export interface EmbedResponse {
  type: 'embed-result';
  requestId: string;
  vectors: number[][]; // Float32 values serialized as JSON arrays, one per chunk
}
```

- [ ] **Step 2: Update the Embedder interface**

Edit `src/search/embedder.ts`:

```typescript
export interface Embedder {
  embedDocument(text: string): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  isReady(): boolean;
}
```

- [ ] **Step 3: Update the host relay**

In `src/search/embedder-host.ts`, update the pending-request type, the `embed-result` handler, and the public methods to return `Float32Array[]`. `embedQuery` still returns a single `Float32Array` by taking `vectors[0]`:

```typescript
interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
}

// Inside child.on('message', ...) replace the embed-result branch:
if (msg.type === 'embed-result') {
  const req = pending.get(msg.requestId);
  if (req) {
    pending.delete(msg.requestId);
    const vectors = msg.vectors.map(v => new Float32Array(v));
    req.resolve(vectors);
    resetIdleTimer();
  }
  return;
}

function sendRequest(prefix: 'search_document' | 'search_query', text: string): Promise<Float32Array[]> {
  return new Promise<Float32Array[]>((resolveEmbed, rejectEmbed) => {
    const requestId = randomUUID();
    pending.set(requestId, { resolve: resolveEmbed, reject: rejectEmbed });

    spawnChild().then(() => {
      const msg: WorkerRequest = { type: 'embed', requestId, text, prefix };
      child!.send(msg);
    }).catch(err => {
      pending.delete(requestId);
      rejectEmbed(err);
    });
  });
}

return {
  async embedDocument(text: string): Promise<Float32Array[]> {
    return sendRequest('search_document', text);
  },
  async embedQuery(text: string): Promise<Float32Array> {
    const vectors = await sendRequest('search_query', text);
    return vectors[0];
  },
  isReady(): boolean {
    return true;
  },
  async shutdown(): Promise<void> {
    killChild();
  },
};
```

- [ ] **Step 4: Update the worker to send `vectors: [vec]`**

In `src/search/embedder-worker.ts`, replace the embed-result send inside the embed handler:

```typescript
if (msg.type === 'embed') {
  try {
    const prefixed = `${msg.prefix}: ${msg.text}`;
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
    const full = output.data as Float32Array;
    const slice = full.length === DIMENSIONS ? full : full.slice(0, DIMENSIONS);
    send({
      type: 'embed-result',
      requestId: msg.requestId,
      vectors: [Array.from(slice)],
    });
  } catch (err) {
    send({
      type: 'embed-error',
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 5: Update existing tests to the new shape**

Edit `tests/search/embedder-host.test.ts`. For the document test, `embedDocument` now returns an array:

```typescript
it('embeds a document via subprocess', async () => {
  embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
  const vectors = await embedder.embedDocument('Hello world');
  expect(Array.isArray(vectors)).toBe(true);
  expect(vectors.length).toBe(1);
  const [vec] = vectors;
  expect(vec).toBeInstanceOf(Float32Array);
  expect(vec.length).toBe(256);
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  expect(magnitude).toBeGreaterThan(0);
}, 30_000);

it('handles concurrent requests', async () => {
  embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
  const [a, b, c] = await Promise.all([
    embedder.embedDocument('first'),
    embedder.embedDocument('second'),
    embedder.embedQuery('third'),
  ]);
  expect(a[0].length).toBe(256);
  expect(b[0].length).toBe(256);
  expect(c.length).toBe(256); // embedQuery still returns a single Float32Array
});
```

The `embeds a query` test is unchanged.

- [ ] **Step 6: Build to surface remaining type errors**

Run: `npm run build`
Expected: Possible errors in consumers (`indexer.ts`, `search.ts`, `watcher.ts`, `query-nodes.ts`) wherever `embedder.embedDocument(...)` is treated as a single `Float32Array`. Patch each site minimally to preserve current behavior:

```typescript
const [vector] = await embedder.embedDocument(content);
```

These shims will be removed in later tasks (Task 5 onwards).

- [ ] **Step 7: Update the indexer test fake to return an array**

In `tests/search/indexer.test.ts`, inside `createFakeEmbedder`:

```typescript
async embedDocument(text: string): Promise<Float32Array[]> {
  callCount++;
  lastText = text;
  const arr = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    arr[i] = (text.length % 100) / 100 + i * 0.001;
  }
  return [arr];
},
```

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/search/embedder-protocol.ts src/search/embedder.ts src/search/embedder-host.ts src/search/embedder-worker.ts src/search/indexer.ts tests/search/embedder-host.test.ts tests/search/indexer.test.ts
git commit -m "refactor(search): embedder returns vectors array, one per chunk"
```

---

## Task 3: Worker chunks long input using the Nomic tokenizer

**Files:**
- Modify: `src/search/embedder-worker.ts`
- Modify: `tests/search/embedder-host.test.ts` (add chunking integration test)

The worker now tokenizes inputs. If over the model limit, it uses the chunker to produce chunks, embeds each chunk with the right prefix, and returns N vectors.

**Tokenizer access:** Verified via probe — `extractor.tokenizer(text)` returns a tensor whose `.input_ids.dims` is `[batch, seq_len]`. We use `dims[1]` for token count. No separate model load needed.

- [ ] **Step 1: Add the failing integration test**

Append to `tests/search/embedder-host.test.ts` inside `describeIfModel(...)`:

```typescript
it('chunks long documents into multiple vectors', async () => {
  embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
  // ~45K chars ≈ ~11K tokens → must chunk (Nomic limit 8192).
  const longText = Array.from({ length: 300 }, (_, i) =>
    `## Section ${i}\nThis is paragraph ${i}. ` + 'word '.repeat(30)
  ).join('\n\n');
  const vectors = await embedder.embedDocument(longText);
  expect(vectors.length).toBeGreaterThan(1);
  for (const v of vectors) {
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(256);
    const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeGreaterThan(0);
  }
}, 60_000);
```

- [ ] **Step 2: Run — expect a single-vector result, i.e. FAIL**

Run: `npm run build && npx vitest run tests/search/embedder-host.test.ts`
Expected: new test FAILS because the worker still wraps one vector regardless of length.

- [ ] **Step 3: Wire chunker into worker**

Replace `src/search/embedder-worker.ts` end-to-end:

```typescript
// src/search/embedder-worker.ts
//
// Forked subprocess entry point. Loads the ONNX embedding model and serves
// embed requests over Node IPC. Tokenizes input; if longer than the model's
// context window, splits semantically via src/search/chunker.ts and embeds
// each chunk, returning vectors: number[][].

import { pipeline, env } from '@huggingface/transformers';
import { chunkForEmbedding } from './chunker.js';
import type { WorkerRequest, WorkerMessage } from './embedder-protocol.js';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const DIMENSIONS = 256;
const MAX_TOKENS = 8192;
const OVERLAP_TOKENS = 128;

async function main(): Promise<void> {
  const modelsDir = process.argv[2];
  if (!modelsDir) {
    console.error('[embedder-worker] modelsDir argument required');
    process.exit(1);
  }

  env.cacheDir = modelsDir;
  env.allowRemoteModels = true;

  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    revision: 'main',
  });

  env.allowRemoteModels = false;

  function tokenCount(text: string): number {
    const dims = extractor.tokenizer(text).input_ids.dims as number[];
    return dims[1] ?? 0;
  }

  async function embedOne(text: string): Promise<number[]> {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const full = output.data as Float32Array;
    const slice = full.length === DIMENSIONS ? full : full.slice(0, DIMENSIONS);
    return Array.from(slice);
  }

  function send(msg: WorkerMessage): void {
    if (process.send) process.send(msg);
  }

  send({ type: 'ready' });

  process.on('message', async (msg: WorkerRequest) => {
    if (msg.type === 'shutdown') {
      process.exit(0);
    }

    if (msg.type === 'embed') {
      try {
        const prefixed = `${msg.prefix}: ${msg.text}`;
        const vectors: number[][] = [];

        if (tokenCount(prefixed) <= MAX_TOKENS) {
          vectors.push(await embedOne(prefixed));
        } else {
          // Chunk unprefixed text, then re-apply the prefix per chunk.
          // Leave headroom for the prefix tokens.
          const chunks = chunkForEmbedding(
            msg.text,
            tokenCount,
            { maxTokens: MAX_TOKENS - 16, overlapTokens: OVERLAP_TOKENS },
          );
          for (const chunk of chunks) {
            vectors.push(await embedOne(`${msg.prefix}: ${chunk}`));
          }
        }

        send({ type: 'embed-result', requestId: msg.requestId, vectors });
      } catch (err) {
        send({
          type: 'embed-error',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  process.on('disconnect', () => process.exit(0));
}

main().catch(err => {
  console.error('[embedder-worker] Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Build and run the integration test**

Run: `npm run build && npx vitest run tests/search/embedder-host.test.ts`
Expected: PASS. Chunking test returns >1 vectors.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search/embedder-worker.ts tests/search/embedder-host.test.ts
git commit -m "feat(search): worker chunks long docs using Nomic tokenizer"
```

---

## Task 4: Meta table + search version API

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Create: `src/db/search-version.ts`
- Create: `tests/db/search-version.test.ts`

A small key-value `meta` table is the simplest future-proof home for the `search_version` scalar.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/db/search-version.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import {
  CURRENT_SEARCH_VERSION,
  getSearchVersion,
  setSearchVersion,
} from '../../src/db/search-version.js';

describe('search-version', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns 1 when no version is stored (implicit baseline)', () => {
    expect(getSearchVersion(db)).toBe(1);
  });

  it('persists a version and reads it back', () => {
    setSearchVersion(db, 2);
    expect(getSearchVersion(db)).toBe(2);
  });

  it('overwrites on repeat set', () => {
    setSearchVersion(db, 2);
    setSearchVersion(db, 5);
    expect(getSearchVersion(db)).toBe(5);
  });

  it('exposes CURRENT_SEARCH_VERSION >= 2', () => {
    expect(CURRENT_SEARCH_VERSION).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/db/search-version.test.ts`
Expected: FAIL — module not found, and `meta` table missing.

- [ ] **Step 3: Add the meta table to the bootstrap schema**

In `src/db/schema.ts`, add near the other `CREATE TABLE` statements:

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Add a migration for existing databases**

In `src/db/migrate.ts`, add an idempotent block that ensures the `meta` table exists on upgrade. Put it alongside existing migrations:

```typescript
// Migration: ensure `meta` table exists (added 2026-04-16 for search_version)
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
`);
```

- [ ] **Step 5: Implement the version API**

```typescript
// src/db/search-version.ts
//
// Tracks the embedding pipeline version so the engine can detect when an
// upgrade requires a full clear + re-embed. Bump CURRENT_SEARCH_VERSION
// whenever a change makes existing stored vectors semantically wrong.

import type Database from 'better-sqlite3';

/**
 * v1: full-content embeddings, truncated by tokenizer at 8192 tokens.
 * v2: chunked embeddings + extraction embeddings.
 */
export const CURRENT_SEARCH_VERSION = 2;

const KEY = 'search_version';

export function getSearchVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (!row) return 1;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 1;
}

export function setSearchVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KEY, String(version));
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/db/search-version.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite and build**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/db/search-version.ts tests/db/search-version.test.ts
git commit -m "feat(db): add meta table and search_version API"
```

---

## Task 5: Indexer stores N vectors per item with delete-and-insert

**Files:**
- Modify: `src/search/indexer.ts`
- Modify: `tests/search/indexer.test.ts`

The indexer now calls `embedder.embedDocument(content)` and stores each returned vector as a separate `embedding_meta`/`embedding_vec` row. When content changes, old rows for that (node_id, source_type, extraction_ref) are deleted before new ones are inserted. Simpler than upsert-and-trim and avoids juggling reused primary keys in the vec virtual table.

Skip semantics stay the same: if any existing meta row for the group has a hash matching the current content hash, we assume all chunks are current and skip.

- [ ] **Step 1: Extend the indexer tests**

In `tests/search/indexer.test.ts`, add a helper and new tests:

```typescript
function createMultiChunkEmbedder(chunkCount: number): Embedder & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async embedDocument(text: string): Promise<Float32Array[]> {
      callCount++;
      return Array.from({ length: chunkCount }, (_, i) => {
        const arr = new Float32Array(256);
        for (let j = 0; j < 256; j++) {
          arr[j] = (i * 0.01) + j * 0.001;
        }
        return arr;
      });
    },
    async embedQuery(): Promise<Float32Array> { return new Float32Array(256).fill(0.5); },
    isReady(): boolean { return true; },
  };
}

describe('multi-chunk storage', () => {
  it('stores N meta+vec rows when embedder returns N vectors', async () => {
    db = createTestDb();
    const multi = createMultiChunkEmbedder(3);
    const idx = createEmbeddingIndexer(db, multi);
    insertNode(db, 'n1', 'Title', 'body');
    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();

    const rows = db.prepare(
      "SELECT chunk_index FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'node' ORDER BY chunk_index"
    ).all() as { chunk_index: number }[];
    expect(rows.map(r => r.chunk_index)).toEqual([0, 1, 2]);

    const vecCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = 'n1')"
    ).get() as { cnt: number }).cnt;
    expect(vecCount).toBe(3);
  });

  it('skips re-embedding when hash is unchanged', async () => {
    db = createTestDb();
    const multi = createMultiChunkEmbedder(3);
    const idx = createEmbeddingIndexer(db, multi);
    insertNode(db, 'n1', 'Title', 'body');
    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();

    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();
    expect(multi.callCount).toBe(1);
  });

  it('replaces old rows when content changes from N=3 chunks to N=1', async () => {
    db = createTestDb();
    const three = createMultiChunkEmbedder(3);
    const idx1 = createEmbeddingIndexer(db, three);
    insertNode(db, 'n1', 'Title', 'body v1');
    idx1.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx1.processAll();

    db.prepare('UPDATE nodes SET body = ? WHERE id = ?').run('body v2', 'n1');
    const one = createMultiChunkEmbedder(1);
    const idx2 = createEmbeddingIndexer(db, one);
    idx2.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx2.processAll();

    const rows = db.prepare(
      "SELECT chunk_index FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'node' ORDER BY chunk_index"
    ).all() as { chunk_index: number }[];
    expect(rows.map(r => r.chunk_index)).toEqual([0]);
    const vecCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = 'n1')"
    ).get() as { cnt: number }).cnt;
    expect(vecCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect failures for multi-chunk cases**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: FAIL on multi-chunk tests.

- [ ] **Step 3: Rewrite `processOne()` for multi-vector**

In `src/search/indexer.ts`, replace the existing `stmtGetExistingMeta`, `stmtUpdateMeta`, `stmtUpdateVec` statements with group-delete statements:

```typescript
const stmtGetAnyHashForGroup = db.prepare<[string, string, string | null], { source_hash: string }>(
  `SELECT source_hash FROM embedding_meta
   WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?
   LIMIT 1`
);

const stmtDeleteVecByGroup = db.prepare<[string, string, string | null], void>(
  `DELETE FROM embedding_vec WHERE id IN (
     SELECT id FROM embedding_meta
     WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?
   )`
);

const stmtDeleteMetaByGroup = db.prepare<[string, string, string | null], void>(
  `DELETE FROM embedding_meta
   WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?`
);
```

Keep the existing `stmtInsertMeta`, `stmtInsertVec`, `stmtDeleteVecByNode`, `stmtDeleteMetaByNode`, `stmtClearVec`, `stmtClearMeta`.

Rewrite the `processOne` body for node items:

```typescript
async function processOne(): Promise<boolean> {
  const item = queue.shift();
  if (!item) return false;

  processing = true;
  try {
    if (item.source_type === 'node') {
      const extractionRef = item.extraction_ref ?? null;
      const hash = contentHash(item.node_id);
      const existing = stmtGetAnyHashForGroup.get(item.node_id, item.source_type, extractionRef);
      if (existing && existing.source_hash === hash) return true;

      const content = assembleContent(item.node_id);
      const vectors = await embedder.embedDocument(content);
      const now = new Date().toISOString();

      // Delete vec rows first (they reference meta ids via subquery), then meta.
      stmtDeleteVecByGroup.run(item.node_id, item.source_type, extractionRef);
      stmtDeleteMetaByGroup.run(item.node_id, item.source_type, extractionRef);

      for (let i = 0; i < vectors.length; i++) {
        const vector = vectors[i];
        const vectorBytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        const res = stmtInsertMeta.run(item.node_id, item.source_type, hash, i, extractionRef, now);
        const metaId = BigInt(res.lastInsertRowid);
        stmtInsertVec.run(metaId, vectorBytes);
      }
    }

    return true;
  } catch (err) {
    const retries = (item.retries ?? 0) + 1;
    if (retries < 3) {
      console.warn(`[embedding-indexer] embed failed for ${item.node_id} (attempt ${retries}), requeueing:`, err);
      queue.push({ ...item, retries });
    } else {
      console.error(`[embedding-indexer] embed failed for ${item.node_id} after 3 attempts, dropping:`, err);
    }
    return false;
  } finally {
    processing = false;
  }
}
```

Remove any leftover `const [vector] = await embedder.embedDocument(...)` shim introduced in Task 2.

- [ ] **Step 4: Run the indexer tests**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search/indexer.ts tests/search/indexer.test.ts
git commit -m "feat(search): indexer stores one row per chunk via delete-and-insert"
```

---

## Task 6: Extract shared embed-ref resolver

**Files:**
- Create: `src/extraction/resolve.ts`
- Create: `tests/extraction/resolve.test.ts`
- Modify: `src/extraction/assembler.ts`

The indexer needs the same "ref → filePath + isMarkdown" logic that `assembler.ts` already contains. Extract it to a small helper so the two callers agree by construction.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/extraction/resolve.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { resolveEmbedRef } from '../../src/extraction/resolve.js';

describe('resolveEmbedRef', () => {
  let db: Database.Database;
  let vaultDir: string;

  beforeEach(() => {
    db = createTestDb();
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-resolve-'));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('resolves a non-markdown file at vault root', async () => {
    writeFileSync(join(vaultDir, 'audio.m4a'), 'fake');
    const r = await resolveEmbedRef(db, vaultDir, 'audio.m4a');
    expect(r).not.toBeNull();
    expect(r!.isMarkdown).toBe(false);
    expect(r!.filePath).toBe(join(vaultDir, 'audio.m4a'));
    expect(r!.nodeId).toBeNull();
  });

  it('resolves a non-markdown file via basename search', async () => {
    mkdirSync(join(vaultDir, 'sub'));
    writeFileSync(join(vaultDir, 'sub', 'image.png'), 'fake');
    const r = await resolveEmbedRef(db, vaultDir, 'image.png');
    expect(r).not.toBeNull();
    expect(r!.isMarkdown).toBe(false);
    expect(r!.filePath).toBe(join(vaultDir, 'sub', 'image.png'));
  });

  it('resolves a markdown ref to a known node', async () => {
    db.prepare("INSERT INTO nodes (id, file_path, title, body) VALUES ('n1', 'Notes/Thing.md', 'Thing', '')").run();
    const r = await resolveEmbedRef(db, vaultDir, 'Thing');
    expect(r).not.toBeNull();
    expect(r!.isMarkdown).toBe(true);
    expect(r!.nodeId).toBe('n1');
    expect(r!.filePath).toBe(join(vaultDir, 'Notes/Thing.md'));
  });

  it('returns null for an unknown ref', async () => {
    const r = await resolveEmbedRef(db, vaultDir, 'nope.xyz');
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run tests/extraction/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Export `findFileInVault` from `assembler.ts`**

`findFileInVault` currently lives as an internal helper inside `src/extraction/assembler.ts`. Add `export` in front of its declaration so `resolve.ts` can import it. No other change to assembler at this step.

- [ ] **Step 4: Implement the resolver**

```typescript
// src/extraction/resolve.ts
//
// Shared embed-reference resolver. Given a vault-relative embed ref (what you
// see inside `![[...]]`), returns the resolved absolute file path plus the
// classification (markdown/non-markdown) and, when applicable, the node id.
//
// Unifies the resolution path used by the assembler (content extraction at
// read time) and the embedding indexer (extraction embedding at write time).

import type Database from 'better-sqlite3';
import { extname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { findFileInVault } from './assembler.js';
import { resolveTarget } from '../references/resolve-target.js';

export interface ResolvedRef {
  filePath: string;
  isMarkdown: boolean;
  nodeId: string | null;
}

export async function resolveEmbedRef(
  db: Database.Database,
  vaultPath: string,
  ref: string
): Promise<ResolvedRef | null> {
  const ext = extname(ref).toLowerCase();

  if (ext !== '' && ext !== '.md') {
    const direct = safeVaultPath(vaultPath, ref);
    try {
      await stat(direct);
      return { filePath: direct, isMarkdown: false, nodeId: null };
    } catch {
      const found = await findFileInVault(vaultPath, ref);
      if (!found) return null;
      return { filePath: found, isMarkdown: false, nodeId: null };
    }
  }

  const direct = resolveTarget(db, ref);
  const stripped = ref.endsWith('.md') ? ref.slice(0, -3) : `${ref}.md`;
  const resolved = direct ?? resolveTarget(db, stripped);
  if (!resolved) return null;

  const row = db
    .prepare('SELECT file_path FROM nodes WHERE id = ?')
    .get(resolved.id) as { file_path: string } | undefined;
  const filePath = row ? join(vaultPath, row.file_path) : join(vaultPath, ref);
  return { filePath, isMarkdown: true, nodeId: resolved.id };
}
```

**Verify the `resolveTarget` import path** — check the actual location of `resolveTarget` in the repo (it may be under `src/indexer/`, `src/references/`, or elsewhere). Update the import accordingly.

- [ ] **Step 5: Run resolver tests**

Run: `npx vitest run tests/extraction/resolve.test.ts`
Expected: PASS.

- [ ] **Step 6: Refactor `assembler.ts` to use the resolver**

In `src/extraction/assembler.ts`, inside `processEmbeds`, replace the extension-branching block (the `if (ext !== '' && ext !== '.md')` + `else` chunk that produces `filePath` and `resolvedNodeId`) with:

```typescript
const resolved = await resolveEmbedRef(db, vaultPath, ref);
if (!resolved) {
  errors.push({ reference: ref, error: `Could not resolve reference: ${ref}` });
  continue;
}
const filePath = resolved.filePath;
const resolvedNodeId = resolved.nodeId;
```

Add import at top of file: `import { resolveEmbedRef } from './resolve.js';`

Keep the subsequent size check + extraction logic intact. The markdown-vs-non-markdown branch for recursive embed discovery still works because `resolvedNodeId` is non-null exactly when it's markdown (the existing code already checks `mediaType === 'markdown'`, which is set by the extraction cache, not by resolution).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/phase6/end-to-end.test.ts` and assembler-specific tests still pass because `resolveEmbedRef` replicates the original behavior exactly.

- [ ] **Step 8: Commit**

```bash
git add src/extraction/resolve.ts src/extraction/assembler.ts tests/extraction/resolve.test.ts
git commit -m "refactor(extraction): extract shared embed-ref resolver"
```

---

## Task 7: Indexer embeds extraction content

**Files:**
- Modify: `src/search/indexer.ts`
- Modify: `tests/search/indexer.test.ts`

The indexer gains optional `extractionCache` + `vaultPath` deps. When those are present:
1. Enqueuing a `source_type='node'` item also walks the node's body for `![[embed]]` refs and enqueues `source_type='extraction'` items for every non-markdown-looking ref.
2. `processOne()` handles `source_type='extraction'` items: resolve → extract → hash → embed → delete-and-insert N rows.

When deps are missing, both paths are silent no-ops (preserves current behavior for callers that don't pass deps, e.g. many tests).

- [ ] **Step 1: Write the failing tests**

Append to `tests/search/indexer.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createFakeCache(byPath: Record<string, string>) {
  return {
    async getExtraction(filePath: string) {
      const text = byPath[filePath];
      if (!text) throw new Error(`no fake extraction for ${filePath}`);
      return { text, mediaType: 'audio' as const };
    },
  };
}

describe('extraction embedding', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-idx-ext-'));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('enqueuing a node discovers non-markdown embeds and enqueues extractions', async () => {
    writeFileSync(join(vaultDir, 'audio.m4a'), 'fake audio bytes');
    const cache = createFakeCache({ [join(vaultDir, 'audio.m4a')]: 'transcript here' });
    const idx = createEmbeddingIndexer(db, fakeEmbedder, { extractionCache: cache as any, vaultPath: vaultDir });

    insertNode(db, 'n1', 'With Audio', 'See transcript: ![[audio.m4a]]');
    idx.enqueue({ node_id: 'n1', source_type: 'node' });

    expect(idx.queueSize()).toBe(2);
    await idx.processAll();

    const extRows = db.prepare(
      "SELECT extraction_ref FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'extraction'"
    ).all() as { extraction_ref: string }[];
    expect(extRows.length).toBe(1);
    expect(extRows[0].extraction_ref).toBe('audio.m4a');
  });

  it('does NOT enqueue extraction items for markdown embeds', async () => {
    insertNode(db, 'n2', 'Other Note', 'stuff');
    const cache = createFakeCache({});
    const idx = createEmbeddingIndexer(db, fakeEmbedder, { extractionCache: cache as any, vaultPath: vaultDir });

    insertNode(db, 'n1', 'Parent', 'See: ![[Other Note]]');
    idx.enqueue({ node_id: 'n1', source_type: 'node' });

    expect(idx.queueSize()).toBe(1);
  });

  it('extraction item is skipped on second run when text hash unchanged', async () => {
    writeFileSync(join(vaultDir, 'audio.m4a'), 'x');
    const cache = createFakeCache({ [join(vaultDir, 'audio.m4a')]: 'stable text' });
    const idx = createEmbeddingIndexer(db, fakeEmbedder, { extractionCache: cache as any, vaultPath: vaultDir });
    insertNode(db, 'n1', 'With Audio', '![[audio.m4a]]');

    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();
    const firstCalls = fakeEmbedder.callCount;

    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();
    expect(fakeEmbedder.callCount).toBe(firstCalls);
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: FAIL — `createEmbeddingIndexer` does not accept deps; extraction source_type is unhandled.

- [ ] **Step 3: Extend `createEmbeddingIndexer`**

In `src/search/indexer.ts`:

1. Add imports:

```typescript
import { resolveEmbedRef } from '../extraction/resolve.js';
import type { ExtractionCache } from '../extraction/cache.js';
import { parseEmbedReferences } from '../extraction/assembler.js';
```

2. Add the deps interface and update the signature:

```typescript
export interface EmbeddingIndexerDeps {
  extractionCache?: ExtractionCache;
  vaultPath?: string;
}

export function createEmbeddingIndexer(
  db: Database.Database,
  embedder: Embedder,
  deps?: EmbeddingIndexerDeps
): EmbeddingIndexer {
  // ... existing statement prep ...
```

3. Add a helper:

```typescript
function isLikelyMarkdownRef(ref: string): boolean {
  const dot = ref.lastIndexOf('.');
  if (dot === -1) return true; // no extension → treat as md
  return ref.slice(dot).toLowerCase() === '.md';
}
```

4. Modify `enqueue` to walk embeds:

```typescript
function enqueue(item: EmbeddingQueueItem): void {
  const key = itemKey(item);
  if (!queue.some(q => itemKey(q) === key)) {
    queue.push(item);
  }

  if (item.source_type === 'node' && deps?.extractionCache && deps?.vaultPath) {
    const row = stmtGetNode.get(item.node_id);
    if (row && row.body) {
      const refs = parseEmbedReferences(row.body);
      for (const ref of refs) {
        if (isLikelyMarkdownRef(ref)) continue;
        const extractionItem: EmbeddingQueueItem = {
          node_id: item.node_id,
          source_type: 'extraction',
          extraction_ref: ref,
        };
        const extKey = itemKey(extractionItem);
        if (!queue.some(q => itemKey(q) === extKey)) {
          queue.push(extractionItem);
        }
      }
    }
  }
}
```

5. Extend `processOne` with an extraction branch, added after the existing `source_type === 'node'` branch:

```typescript
if (item.source_type === 'extraction') {
  if (!deps?.extractionCache || !deps?.vaultPath || !item.extraction_ref) {
    return true;
  }
  const resolved = await resolveEmbedRef(db, deps.vaultPath, item.extraction_ref);
  if (!resolved || resolved.isMarkdown) return true;

  const extraction = await deps.extractionCache.getExtraction(resolved.filePath);
  const text = extraction.text ?? '';
  if (text.length === 0) return true;

  const hash = createHash('sha256').update(text).digest('hex');
  const extractionRef = item.extraction_ref;
  const existing = stmtGetAnyHashForGroup.get(item.node_id, 'extraction', extractionRef);
  if (existing && existing.source_hash === hash) return true;

  const vectors = await embedder.embedDocument(text);
  const now = new Date().toISOString();
  stmtDeleteVecByGroup.run(item.node_id, 'extraction', extractionRef);
  stmtDeleteMetaByGroup.run(item.node_id, 'extraction', extractionRef);
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    const vectorBytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    const res = stmtInsertMeta.run(item.node_id, 'extraction', hash, i, extractionRef, now);
    const metaId = BigInt(res.lastInsertRowid);
    stmtInsertVec.run(metaId, vectorBytes);
  }
  return true;
}
```

- [ ] **Step 4: Run the indexer tests**

Run: `npx vitest run tests/search/indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search/indexer.ts tests/search/indexer.test.ts
git commit -m "feat(search): embed non-markdown extractions alongside node content"
```

---

## Task 8: Search records `matched_chunk_index`; bump VECTOR_LIMIT

**Files:**
- Modify: `src/search/types.ts`
- Modify: `src/search/search.ts`
- Modify: `tests/search/search.test.ts`

Vector hits may now come in for several chunks of the same node. Fusion already accumulates per-node RRF scores; we just want to tell consumers which chunk scored highest per node.

- [ ] **Step 1: Extend the type**

In `src/search/types.ts`, add an optional field to `SearchHit`:

```typescript
export interface SearchHit {
  // ... existing fields ...
  matched_embed?: string;
  matched_chunk_index?: number;
}
```

- [ ] **Step 2: Add a failing test**

In `tests/search/search.test.ts`, add a test that seeds two chunks for one node and asserts the best-scoring chunk is recorded. Use whatever seed pattern existing tests use for `embedding_meta` + `embedding_vec`. Sketch:

```typescript
it('annotates matched_chunk_index with the highest-scoring chunk per node', async () => {
  const db = createTestDb();
  // seed node 'n1'
  db.prepare("INSERT INTO nodes (id, file_path, title, body) VALUES ('n1', 'n1.md', 'N1', 'b')").run();
  db.prepare("INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = 'n1'), 'N1', 'b')").run();

  // seed two chunk vectors: chunk 0 far from query, chunk 1 close to query
  const vClose = new Float32Array(256); vClose[0] = 1;
  const vFar = new Float32Array(256); vFar[0] = -1;
  const insertMeta = db.prepare(
    "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES (?, 'node', 'h', ?, NULL, ?)"
  );
  const insertVec = db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)');

  const m0 = insertMeta.run('n1', 0, new Date().toISOString());
  insertVec.run(BigInt(m0.lastInsertRowid), new Uint8Array(vFar.buffer, vFar.byteOffset, vFar.byteLength));
  const m1 = insertMeta.run('n1', 1, new Date().toISOString());
  insertVec.run(BigInt(m1.lastInsertRowid), new Uint8Array(vClose.buffer, vClose.byteOffset, vClose.byteLength));

  const queryEmbedder: Embedder = {
    async embedDocument() { return [new Float32Array(256)]; },
    async embedQuery() { const v = new Float32Array(256); v[0] = 1; return v; },
    isReady: () => true,
  };

  const { hits } = await hybridSearch(db, queryEmbedder, 'anything');
  const n1 = hits.find(h => h.node_id === 'n1');
  expect(n1?.matched_chunk_index).toBe(1);
});
```

(Adjust imports and the exact `hybridSearch` signature to match the existing search API.)

- [ ] **Step 3: Run — expect failure**

Run: `npx vitest run tests/search/search.test.ts`
Expected: FAIL — `matched_chunk_index` is undefined.

- [ ] **Step 4: Update `VECTOR_LIMIT` and fusion**

In `src/search/search.ts`:

```typescript
const VECTOR_LIMIT = 400;
```

Ensure the vector-search SQL selects `chunk_index` from `embedding_meta`. In the fusion logic, when accumulating per-node RRF scores, track the highest rank-score seen per node and its chunk_index. Inside the loop that walks `vectorHits`:

```typescript
const rankScore = 1 / (RRF_K + hit.rank);
const entry = map.get(hit.node_id) ?? {
  node_id: hit.node_id,
  score: 0,
  matched_embed: undefined as string | undefined,
  bestChunkScore: undefined as number | undefined,
  matchedChunkIndex: undefined as number | undefined,
};
entry.score += rankScore;

if (hit.source_type === 'extraction' && hit.extraction_ref !== null && !entry.matched_embed) {
  entry.matched_embed = hit.extraction_ref;
}
if (entry.bestChunkScore === undefined || rankScore > entry.bestChunkScore) {
  entry.bestChunkScore = rankScore;
  entry.matchedChunkIndex = hit.chunk_index;
}

map.set(hit.node_id, entry);
```

When building the final `SearchHit[]`, copy the chunk index:

```typescript
if (entry.matchedChunkIndex !== undefined) {
  hit.matched_chunk_index = entry.matchedChunkIndex;
}
```

(Adjust to match the existing entry shape and variable names; the key is introducing `bestChunkScore` + `matchedChunkIndex` alongside the other per-entry running values.)

- [ ] **Step 5: Run**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search/search.ts src/search/types.ts tests/search/search.test.ts
git commit -m "feat(search): record matched_chunk_index and raise VECTOR_LIMIT to 400"
```

---

## Task 9: Startup version check + wire deps

**Files:**
- Modify: `src/index.ts`

Two changes to application bootstrap: (1) before bulk-enqueue, detect a version bump and clear the index so everything re-embeds with the new pipeline; (2) pass `extractionCache` + `vaultPath` to the embedding indexer so the extraction pipeline is live.

Current `src/index.ts` creates the embedding indexer (~line 81) and the extraction cache (~line 117). The extraction cache must be available before the indexer is created — reorder accordingly.

- [ ] **Step 1: Reorder `src/index.ts`**

Move the block that builds `extractorRegistry` + `extractionCache` (currently around lines 116–119) **above** the `// --- Phase 4: Embedding indexer ...` block.

- [ ] **Step 2: Wire deps + version check**

Inside the embedding indexer init block, replace `embeddingIndexer = createEmbeddingIndexer(db, embedder);` with:

```typescript
embeddingIndexer = createEmbeddingIndexer(db, embedder, {
  extractionCache,
  vaultPath,
});

const storedVersion = getSearchVersion(db);
if (storedVersion < CURRENT_SEARCH_VERSION) {
  console.log(`Search index version ${storedVersion} → ${CURRENT_SEARCH_VERSION}: clearing and re-embedding...`);
  embeddingIndexer.clearAll();
  setSearchVersion(db, CURRENT_SEARCH_VERSION);
}
```

Add imports at the top of the file:

```typescript
import { CURRENT_SEARCH_VERSION, getSearchVersion, setSearchVersion } from './db/search-version.js';
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Smoke-check startup help**

Run: `node dist/index.js --help 2>&1 | head -5`
Expected: the binary prints help without error.

**Do NOT start against the real vault here** — the version-bump path would clear the production embedding index. Manual smoke belongs in a scratch vault copy.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(search): wire extractionCache into indexer and re-embed on version bump"
```

---

## Task 10: End-to-end smoke test

**Files:**
- Modify: `tests/search/end-to-end.test.ts`

Exercise the full chain with a fake embedder (no ONNX required): long node body → multiple chunks stored; node with `![[audio.ext]]` → extraction embedding stored; re-run → cache hits.

- [ ] **Step 1: Read the existing end-to-end test**

Open `tests/search/end-to-end.test.ts` and note its scaffolding (how it builds the db, imports, etc.).

- [ ] **Step 2: Add a new `describe` block**

```typescript
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('chunking and extraction (end-to-end)', () => {
  it('stores multiple chunks for long content and extraction embeddings for ![[audio]] refs', async () => {
    const db = createTestDb();
    const vaultDir = mkdtempSync(join(tmpdir(), 've-chunk-e2e-'));
    try {
      writeFileSync(join(vaultDir, 'clip.m4a'), 'bytes');
      const cache = {
        async getExtraction() { return { text: 'x'.repeat(2000), mediaType: 'audio' as const }; },
      };

      const embedder: Embedder = {
        async embedDocument(text: string) {
          const n = text.length > 1000 ? 3 : 1;
          return Array.from({ length: n }, (_, i) => {
            const v = new Float32Array(256);
            v[0] = i * 0.1 + text.length * 1e-6;
            return v;
          });
        },
        async embedQuery() { return new Float32Array(256).fill(0.25); },
        isReady: () => true,
      };

      const idx = createEmbeddingIndexer(db, embedder, { extractionCache: cache as any, vaultPath: vaultDir });

      db.prepare("INSERT INTO nodes (id, file_path, title, body) VALUES ('n1', 'N1.md', 'N1', ?)").run('y'.repeat(2000) + ' ![[clip.m4a]]');
      db.prepare("INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = 'n1'), 'N1', 'body')").run();

      idx.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx.processAll();

      const nodeRows = db.prepare(
        "SELECT chunk_index FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'node' ORDER BY chunk_index"
      ).all() as { chunk_index: number }[];
      expect(nodeRows.map(r => r.chunk_index)).toEqual([0, 1, 2]);

      const extRows = db.prepare(
        "SELECT chunk_index, extraction_ref FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'extraction' ORDER BY chunk_index"
      ).all() as { chunk_index: number; extraction_ref: string }[];
      expect(extRows.length).toBe(3);
      expect(extRows.every(r => r.extraction_ref === 'clip.m4a')).toBe(true);

      const before = (db.prepare("SELECT COUNT(*) as cnt FROM embedding_meta").get() as any).cnt;
      idx.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx.processAll();
      const after = (db.prepare("SELECT COUNT(*) as cnt FROM embedding_meta").get() as any).cnt;
      expect(after).toBe(before);
    } finally {
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run tests/search/end-to-end.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the entire suite + build**

Run: `npm run build && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/search/end-to-end.test.ts
git commit -m "test(search): end-to-end smoke for chunking + extraction embeddings"
```

---

## Self-review

- [ ] **Spec coverage:** Worker chunking → Task 3. IPC protocol change → Task 2. Indexer multi-vector → Task 5. Extraction pipeline → Tasks 6 + 7. Search attribution + VECTOR_LIMIT → Task 8. Migration / version bump → Tasks 4 + 9. End-to-end → Task 10. ✓
- [ ] **Placeholder scan:** No "TBD", "similar to Task N", or "add error handling" hand-waves.
- [ ] **Type consistency:** `Embedder.embedDocument` returns `Promise<Float32Array[]>` everywhere. IPC `EmbedResponse.vectors` is `number[][]`. `SearchHit.matched_chunk_index` is the name used in type + fusion + tests. `EmbeddingIndexerDeps` names the optional deps. `CURRENT_SEARCH_VERSION` is reused in both the API module and `src/index.ts`.
- [ ] **Watcher path:** watcher already calls `embeddingIndexer.enqueue({ node_id, source_type: 'node' })` (see `src/sync/watcher.ts:222, 297`). Task 7's discovery logic lives inside `enqueue()`, so the watcher path automatically gets extraction discovery without further changes. ✓
