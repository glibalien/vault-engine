# Phase 4 — Semantic Search and Embeddings

## Overview

Phase 4 adds semantic search to the vault engine. Every node's content (title, body, string-valued fields) is embedded using an in-process ONNX model and stored in sqlite-vec. When Phase 6's extraction cache is present, cached transcriptions and OCR text are also embedded as separate chunks. The existing `query-nodes` tool gains a `query` parameter that runs hybrid search — FTS5 keyword matching plus vector similarity, fused via reciprocal rank fusion — with all existing structured filters still available.

All embedding happens in the background. The engine starts serving immediately; search results improve as embeddings populate. A `--reindex-search` startup flag triggers a full rebuild of the search index.

## Deviations from Charter

The charter's Phase 4 specification is brief. This design makes four deliberate changes:

1. **Embedding model: in-process ONNX, not ollama.** The charter says `nomic-embed-text` via local ollama. This design uses the same model (`nomic-embed-text-v1.5`) but runs it in-process via `@huggingface/transformers` with ONNX Runtime. No separate server process needed.

2. **No standalone `semantic-search` tool.** The charter lists `semantic-search` as its own MCP tool. This design adds semantic search as a capability of the existing `query-nodes` tool via a `query` parameter. When present, results are ranked by hybrid relevance (FTS5 + vector). When absent, `query-nodes` behaves exactly as it does today. This eliminates tool-choice ambiguity for the agent.

3. **sqlite-vec, not sqlite-vss.** Same author (Alex Garcia), actively maintained successor. Pure C, zero dependencies, works with the existing better-sqlite3 setup via `loadExtension()`.

4. **Existing `embeddings` table replaced.** The Phase 1 placeholder table (keyed by `node_id` only, no vectors) is replaced with a proper schema supporting multiple embedding rows per node and a sqlite-vec virtual table.

## Embedding Model

**Model:** `nomic-embed-text-v1.5`, quantized to int8 (`dtype: 'q8'`), loaded via `@huggingface/transformers` pipeline API.

**Key properties:**
- 8192-token context (most vault notes fit without chunking)
- Matryoshka representation learning — vectors stored at 256 dimensions (down from native 768), ~4% quality loss, 3x storage savings
- Requires prefix: `search_document:` for content being indexed, `search_query:` for search queries
- ~137 MB model weights, ~200-300 MB resident memory when loaded
- ~50-80ms per embedding on CPU

**Model weight storage:** Cached in `.vault-engine/models/`. On first startup after Phase 4 deployment, the engine downloads the model from HuggingFace Hub (requires internet access). After successful download, `allowRemoteModels` is set to `false` — no further network calls from the embedding layer.

**Singleton pattern:** The model is loaded once at startup and held in memory for the lifetime of the process. Inference sessions are never created/destroyed per-call (known memory leak in ONNX Runtime when doing so).

## Embedding Content

**Hybrid approach:** Node content and extraction cache text are embedded separately. This keeps each node's embedding focused on its own semantic signal while making embedded file content (audio transcripts, PDF text, image OCR) independently searchable.

| Source | Content | Chunking | Rows per node |
|---|---|---|---|
| Node | Title + body + string/list[string] field values | Truncate at 8192 tokens (rarely needed) | 1 |
| Extraction cache | Cached extracted text (transcripts, OCR, PDF text) | ~4000-token chunks, ~200-token overlap | 1 per chunk |

**Field value selection:** Only fields with type `string` or `list[string]` are included in the node embedding (e.g., `description`, `project`, `people_involved`). Numeric fields, dates, booleans, and enums are skipped — those are better served by structured filters in `query-nodes`.

**Extraction cache integration:** The indexer checks for the `extraction_cache` table (defined in Phase 6) on startup. If present, extraction entries are embedded alongside node content. If absent (Phase 6 not yet shipped), the indexer silently skips extraction indexing. This makes the shipping order of Phase 4 and Phase 6 irrelevant:

- **Phase 4 first, then Phase 6:** Extraction text gets embedded as Phase 6 populates the cache.
- **Phase 6 first, then Phase 4:** All existing extraction cache entries get embedded on the initial `--reindex-search` run.

## Storage Schema

### `embedding_meta` table

Tracks what's been embedded and maps vectors back to their source.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | Stable row ID, referenced by vec table |
| `node_id` | TEXT NOT NULL | The node this embedding belongs to (FK to nodes) |
| `source_type` | TEXT NOT NULL | `'node'` or `'extraction'` |
| `source_hash` | TEXT NOT NULL | Content hash of what was embedded (for staleness detection) |
| `chunk_index` | INTEGER NOT NULL DEFAULT 0 | 0 for node embeddings and single-chunk extractions, 0..N for multi-chunk |
| `extraction_ref` | TEXT | For `source_type = 'extraction'`: vault-relative file path. NULL for node embeddings |
| `embedded_at` | TEXT NOT NULL | ISO timestamp |

Unique constraint on `(node_id, source_type, extraction_ref, chunk_index)`.

### `embedding_vec` virtual table

sqlite-vec flat (exact) search:

```sql
CREATE VIRTUAL TABLE embedding_vec USING vec0(
  id INTEGER PRIMARY KEY,
  vector float[256]
);
```

The `id` column references `embedding_meta.id`. Queries join the two: vector search on `embedding_vec` returns IDs, joined to `embedding_meta` to resolve back to nodes.

### Staleness detection

When a node changes, the indexer computes a content hash of (title + body + embedded field values). If it matches `source_hash` for the existing `source_type = 'node'` row, no re-embedding needed. Same logic for extraction cache entries — if the extraction cache's `content_hash` matches `source_hash`, the embedding is current.

### Migration

Drop the existing `embeddings` table, create `embedding_meta` and `embedding_vec`. No data migration — the old table contains no real embeddings.

## Embedding Indexer

### Background queue

An in-memory queue of items to embed. Items are added when:
- A node is created, updated, or re-indexed by the watcher
- The engine starts up (any node or extraction entry without a current embedding is queued)
- A `--reindex-search` startup flag is passed (everything is queued, existing embeddings are cleared)

### Processing

A single background worker drains the queue sequentially. At 50-80ms per embedding, throughput is sufficient for a single-user system. The worker:

1. Pulls next item from queue
2. Computes content hash
3. Checks `embedding_meta` for existing row with matching `source_hash` — if match, skip
4. Generates embedding via the model singleton
5. Writes to `embedding_meta` and `embedding_vec` in a transaction
6. For extraction cache entries: chunks the text if >4000 tokens, writes one row per chunk

### Startup behavior

- **Normal startup:** Scans for nodes and extraction cache entries that are missing from `embedding_meta` or have stale `source_hash`. Queues only what's needed. Engine is ready to serve immediately — search works with whatever embeddings exist, improving as the backfill completes.
- **`--reindex-search`:** Drops all rows from `embedding_meta` and `embedding_vec`, queues everything. Same background processing, just a full rebuild.

### Re-embedding triggers

A node is queued for re-embedding when any of these change:
- Node body
- Node title
- Any string or list[string] field value

Changes to non-string fields (dates, numbers, enums, booleans) do not trigger re-embedding.

### Progress reporting

`vault-stats` gains a `search_index` section:

```json
{
  "search_index": {
    "status": "indexing",
    "nodes_total": 7000,
    "nodes_indexed": 4200,
    "extractions_total": 150,
    "extractions_indexed": 80,
    "pending": 2870
  }
}
```

`status` is `"ready"` when the queue is empty, `"indexing"` when the worker is active, `"disabled"` if the model failed to load.

## Search: `query-nodes` Enhancement

### New parameter

`query` (string, optional). When present, activates hybrid search ranking.

### Behavior when `query` is absent

Exactly as today. Structured filters, sort order, pagination. No change.

### Behavior when `query` is present

1. **Pre-filter:** Apply all structured filters (types, fields, path, date ranges, references) to produce a candidate node set, same as today.

2. **FTS5 search:** Run the query against `nodes_fts`. Produces a set of node IDs with BM25 scores.

3. **Vector search:** Embed the query string (with `search_query:` prefix), search `embedding_vec` for nearest neighbors, join through `embedding_meta` to get node IDs. Produces a set of (node_id, score, source_type, extraction_ref) tuples.

4. **Intersect with pre-filter:** Both FTS5 and vector results are filtered to the candidate node set from step 1. If no structured filters were provided, all nodes are candidates.

5. **Reciprocal Rank Fusion:** Merge FTS5 and vector results into a single ranked list. RRF score for each node: `1/(k + rank_fts) + 1/(k + rank_vec)`, where k=60 (standard constant). Nodes appearing in only one result set get a single-source score.

6. **Deduplication:** If a node matches via both its body embedding and an extraction embedding, it appears once with the highest score. All match sources are collected.

7. **Return:** Results sorted by fused score descending. Pagination via `limit`/`offset` still works.

### Return shape additions

Only present when `query` is provided:

```typescript
{
  // ...existing fields (id, title, types, fields)...
  score: number;
  match_sources: Array<'node' | 'embed'>;
  matched_embed?: string;    // vault-relative path, when match_sources includes 'embed'
  snippet?: string;          // FTS5 highlight snippet, only for FTS5 matches
}
```

`match_sources` indicates whether the match came from the node's own content (`'node'` — title, body, and string field values are embedded as one vector and not distinguishable) or from an embedded file's extracted text (`'embed'`). Both can be present if a node matches on its own content and an extraction.

Snippets are provided for FTS5 matches only. Vector-only matches have no natural snippet — the agent can call `get-node` if it needs content.

### `full_text` parameter removal

The `full_text` parameter is removed from `query-nodes`. The `query` parameter subsumes it — any keyword match that FTS5 would have found, it still finds, now fused with vector results. This is a breaking change to the tool interface but there is only one consumer (the agent) and no backward compatibility concern.

## Dependencies

**New npm packages:**
- `@huggingface/transformers` — in-process ONNX inference for nomic-embed-text-v1.5
- `sqlite-vec` — vector search SQLite extension

**No new environment variables.** No API keys needed — everything runs locally.

## File Structure

```
src/search/
  embedder.ts       — model singleton, load/embed interface, prefix handling
  indexer.ts        — background queue, staleness detection, chunk splitting
  search.ts         — hybrid search: FTS5 + vector + RRF fusion
  types.ts          — SearchResult, EmbeddingMeta, indexer queue types
```

**Modified files:**

```
src/db/schema.ts              — drop embeddings table, add embedding_meta + embedding_vec
src/mcp/tools/query-nodes.ts  — add query param, integrate hybrid search
src/mcp/tools/vault-stats.ts  — add search_index section
src/mcp/query-builder.ts      — remove full_text filter
src/indexer/indexer.ts         — notify embedding queue on node index/update
src/pipeline/execute.ts       — notify embedding queue on pipeline writes
src/index.ts                  — model loading on startup, --reindex-search flag
```

## Startup Sequence

1. Open DB, run migrations (existing)
2. Load sqlite-vec extension
3. Load embedding model (async, non-blocking — engine starts serving immediately)
4. Once model is loaded, begin background embedding queue processing
5. If `--reindex-search` flag: clear embedding tables, queue everything

## What This Phase Does NOT Include

- **Standalone `semantic-search` tool** — dropped; `query-nodes` with `query` param serves this purpose
- **Ollama or any external embedding server** — model runs in-process via ONNX
- **ANN indexing** — brute-force exact search via sqlite-vec flat table; revisit if vector count exceeds 100k
- **GPU acceleration** — CPU inference is sufficient at this scale
- **Embedding non-string field values** — dates, numbers, booleans, enums are for structured filters only
- **Parallel embedding** — single background worker, sequential processing; revisit if initial indexing time is a problem
- **Runtime model configuration** — model is hardcoded to nomic-embed-text-v1.5 q8; swapping models means a code change and `--reindex-search`
- **`reconcile-fields` support** — the charter mentions semantic similarity for field reconciliation (Phase 5); the embedding infrastructure this phase builds is usable for that, but Phase 5 owns the reconciliation logic
