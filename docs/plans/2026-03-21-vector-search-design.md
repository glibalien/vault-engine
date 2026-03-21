# Phase 4: Vector Search Integration — Design

## Goal

Add semantic search alongside existing FTS5 keyword search. Users can query by natural language meaning, filtered by schema types and field values. Embeddings are computed asynchronously by a pluggable provider (local ollama or OpenAI API).

## Architecture Overview

Four new components integrate into the existing engine:

```
indexFile (existing)
  └── chunkFile → chunks table + embedding_queue table
                        ↓
              EmbeddingWorker (background loop)
                  ↓              ↓
            EmbeddingProvider    vec_chunks (sqlite-vec)
            (ollama / openai)
                                   ↓
                          semantic-search MCP tool
                          (embed query → vec search → filter → hydrate)
```

The embedding pipeline is fully optional. If no embedding config is provided, the engine runs without vector search — all existing functionality is unaffected.

## Data Model

### `chunks` table

Maps content segments back to their source node. Created in `createSchema` unconditionally — chunking is always performed during indexing so that enabling embeddings later doesn't require a rebuild.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `{node_id}#section:{index}` or `{node_id}#full` |
| `node_id` | TEXT NOT NULL FK → nodes ON DELETE CASCADE | Parent file |
| `chunk_index` | INTEGER | Order within file (0-based) |
| `heading` | TEXT | Section heading text, null for full-file chunks |
| `content` | TEXT | Plain text content of the chunk |
| `token_count` | INTEGER | Estimated token count |

### `embedding_queue` table

Pending embedding work. Created in `createSchema` unconditionally.

| Column | Type | Notes |
|--------|------|-------|
| `chunk_id` | TEXT PK FK → chunks ON DELETE CASCADE | |
| `status` | TEXT | `pending`, `processing`, `failed` |
| `attempts` | INTEGER | Retry count |
| `error` | TEXT | Last error message |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### `vec_chunks` virtual table (sqlite-vec)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[N]
);
```

`N` is determined by the configured provider (768 for nomic-embed-text, 1536 for OpenAI text-embedding-3-small). Changing providers requires re-embedding (drop vec table + re-queue all chunks).

### Lifecycle

When a node is indexed, old chunks for that `node_id` are deleted (cascade to queue via ON DELETE CASCADE; explicit delete for vec table since sqlite-vec virtual tables don't support FK cascades), new chunks are created, and queue entries are inserted. This mirrors the existing delete-then-insert pattern.

Although FK cascades are defined, `indexFile` and `deleteFile` perform explicit deletes of `chunks` and `vec_chunks` rows — consistent with the existing pattern where child tables (`node_types`, `fields`, `relationships`) are explicitly deleted despite having CASCADE FKs.

## Chunking Strategy

Module: `src/embeddings/chunker.ts`

**`chunkFile(parsed: ParsedFile, nodeId: string): Chunk[]`**

Uses the MDAST already produced by `parseMarkdown`:

1. Walk top-level MDAST children, splitting on heading nodes (h1–h6)
2. Each section = heading + subsequent siblings until next heading or end
3. Extract plain text from each section's AST nodes (reusing `extractPlainText` logic, including wikiLink node handling)
4. If the file has no headings or total content is short (< 200 tokens), emit a single `full` chunk
5. If a section exceeds max token limit (default ~2000 tokens), split into overlapping fixed-size sub-chunks as fallback
6. Content before the first heading (if any) becomes its own chunk with `heading: null`

**Chunk IDs:**
- `meetings/standup.md#full` — whole-file chunk
- `meetings/standup.md#section:0` — pre-heading content
- `meetings/standup.md#section:1` — first heading section

**Token estimation:** Whitespace-split word count x 1.3. Good enough for chunking decisions without requiring a tokenizer dependency.

## Embedding Provider Abstraction

Module: `src/embeddings/provider.ts`

### Interface

```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

Batch interface — accepts multiple texts, returns one vector per input.

### Implementations

**`OllamaProvider`** (`src/embeddings/providers/ollama.ts`)
- `POST http://localhost:11434/api/embed`
- Default model: `nomic-embed-text` (768 dimensions)
- Configurable host/port/model
- Raw `fetch()`, no SDK

**`OpenAIProvider`** (`src/embeddings/providers/openai.ts`)
- `POST https://api.openai.com/v1/embeddings`
- Default model: `text-embedding-3-small` (1536 dimensions)
- `OPENAI_API_KEY` env var or config
- Raw `fetch()`, no SDK

### Configuration

```typescript
interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  batchSize?: number;  // default 50
}
```

### Dimension mismatch handling

On startup, if the configured provider's dimensions don't match the existing vec table, the engine drops the vec table and re-queues all chunks. Consistent with "DB is rebuildable."

## Embedding Queue Worker

Module: `src/embeddings/worker.ts`

**`startEmbeddingWorker(db, provider, opts?): EmbeddingWorker`**

In-process background loop, same Node process as file watcher and MCP server.

### Returns

`{ stop(), stats() }` — similar pattern to `watchVault`.

### Processing loop

1. Poll `embedding_queue` for `status = 'pending'`, ordered by `created_at`, limited to `batchSize`
2. Set status to `processing` for claimed batch
3. Load chunk content from `chunks` table
4. Call `provider.embed(texts)`
5. Success: insert vectors into `vec_chunks`, delete from `embedding_queue`
6. Failure: increment `attempts`, set `status = 'failed'` with error. Rows with `attempts < maxRetries` (default 3) reset to `pending` on next cycle
7. Sleep: 1s when idle, 0 when queue has remaining items

### Resilience

- Provider down: failures accumulate, don't crash. Queue drains when provider returns.
- Crash recovery: on startup, rows in `processing` state reset to `pending`.
- No coordination with watcher needed — the queue table is the interface.

## Semantic Search & Hybrid Queries

Module: `src/embeddings/search.ts`

### Query flow

1. Embed query text via `provider.embed([query])`
2. Query sqlite-vec: `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
3. Extract `node_id` from each `chunk_id`
4. Apply structured filters via JOINs (same pattern as `query-nodes`):
   - `schema_type` → JOIN `node_types`
   - `filters` (field equality) → JOIN `fields`
5. Deduplicate by `node_id` — keep best-scoring chunk per node
6. Hydrate via existing `hydrateNodes` helper

### Filter strategy

Post-filter on vec results. Over-fetch from sqlite-vec (`limit * 3`) then filter down. For vault-sized datasets (hundreds to low thousands of nodes) this is sufficient.

### MCP tool: `semantic-search`

**Parameters:**

```typescript
{
  query: string;           // natural language query (required)
  schema_type?: string;    // filter by type
  filters?: Array<{        // field equality filters
    field: string;
    operator: 'eq';
    value: string;
  }>;
  limit?: number;          // default 10
  include_chunks?: boolean; // return matching chunk text (default false)
}
```

**Response:**

```typescript
{
  id: string;
  filePath: string;
  title: string;
  types: string[];
  fields: Record<string, string>;
  score: number;           // 0-1 similarity (1 = most similar), converted from sqlite-vec distance
  matchingChunk?: {
    heading: string | null;
    content: string;
  };
  pending_embeddings?: number;  // included when queue is not fully drained
}
```

## Integration Points

### Entry point (`src/index.ts`)

```
openDatabase → createSchema → loadSchemas → createVecTable → startEmbeddingWorker
                                                                    ↓
                                              watchVault (unchanged)
                                                    ↓
                                              MCP server (+ semantic-search tool)
```

- Load sqlite-vec extension via `db.loadExtension()` before creating vec table
- `chunks` and `embedding_queue` tables are created in `createSchema` unconditionally — chunking always runs so embeddings can be enabled later without a rebuild
- `createVecTable(db, dimensions)` is separate from `createSchema` — depends on provider config and is only called when embeddings are configured
- If no embedding config provided, skip vec table + worker. `semantic-search` tool returns error explaining embeddings aren't configured.

### `indexFile` changes

Two additions:
1. Add explicit `DELETE FROM vec_chunks WHERE chunk_id LIKE ?` and `DELETE FROM chunks WHERE node_id = ?` to the existing child-table deletion block at the top (embedding_queue rows cascade from chunks)
2. After existing insert logic, call `chunkFile` and write chunk rows + queue entries

Chunking always runs regardless of whether embeddings are configured — the `chunks` table is always populated. Queue entries are also always written; the worker simply won't run if embeddings aren't configured.

### `deleteFile` changes

Add explicit `DELETE FROM vec_chunks WHERE chunk_id LIKE ?` and `DELETE FROM chunks WHERE node_id = ?` to the existing deletion sequence. Queue entries cascade from chunks via ON DELETE CASCADE.

### Rebuild/incremental index

`rebuildIndex` explicitly clears all tables before re-indexing. Add `DELETE FROM vec_chunks` and `DELETE FROM embedding_queue` and `DELETE FROM chunks` to the existing clear block (before `DELETE FROM nodes`). `incrementalIndex` needs no changes — it delegates to `indexFile`/`deleteFile` which handle chunk cleanup per node.

### Configuration

Embedding config passed as optional argument to entry point, or read from `.vault-engine/config.json`. If absent, vector search is disabled.

## Dependencies

- `sqlite-vec` — npm package, prebuilt native extension for all major platforms
- No embedding SDK dependencies — both providers use raw `fetch()`

## Upgrade Path

When a user upgrades from Phase 3 to Phase 4, the `chunks` and `embedding_queue` tables are created by `createSchema` on next startup. Chunks are populated during normal indexing, so existing files won't have chunks until they're next modified. To populate chunks for all files, run a full `rebuildIndex`. This is expected — same as how enabling schemas in Phase 2 required a rebuild to populate `node_types`.

## Note on sqlite-vss vs sqlite-vec

The architecture doc references `sqlite-vss`. This spec uses `sqlite-vec`, its successor — `sqlite-vss` is deprecated. `sqlite-vec` is a pure-C rewrite with no external dependencies, better platform support, and a simpler API.

## What This Phase Does NOT Include

- Graph traversal (`traverse-graph` tool) — Phase 5
- Block IDs / sub-file addressing — Phase 5
- Workflow tools (`create-meeting-notes`, `extract-tasks`) — Phase 6
- Multi-vault support — post-v1
