# Chunking and Extraction Embeddings

**Date:** 2026-04-16
**Status:** Approved design, pending implementation
**Scope:** Embedding indexer, embedder worker, search — no MCP tool contract changes

## Problem

Two gaps in the current embedding pipeline degrade search quality:

1. **No chunking.** Nomic v1.5 has an 8,192 token context window. The embedder sends full assembled content with no length check. 448 nodes exceed ~8K characters — their embeddings are silently truncated by the tokenizer, losing semantic information from the tail of the document.

2. **No extraction embeddings.** The schema supports `source_type='extraction'` and the search layer already handles `matched_embed` attribution, but no code path ever enqueues extraction content for embedding. 32 extractions exist in the cache (audio transcriptions, PDFs, images, markdown) with zero corresponding vectors. This content is invisible to semantic search.

## Design Decisions

- **Approach A (worker-side chunking)** chosen over host-side or hybrid splitting. The worker already loads `@huggingface/transformers` which includes the Nomic tokenizer — keeping all chunking logic there avoids new dependencies, gives exact token counts, and isolates the ~1.5 GB memory cost in the subprocess.
- **Semantic boundary splitting** chosen over fixed-window. The vault is markdown-native; splitting on headings and paragraphs respects document structure.
- **Multi-vector per node with chunk attribution** chosen over chunk-as-retrieval-unit. The node remains the retrieval unit (matching existing `SearchHit` contract), but the best-matching chunk index is annotated on results.
- **Eager extraction embedding** chosen over lazy or background sweep. Extraction count is small (32 today) and search misses on extracted content are unacceptable — if it's indexed, it should be searchable.

## Architecture

### 1. Worker Changes (Chunking Engine)

The worker (`embedder-worker.ts`) gains chunk-and-embed capability. When it receives text:

1. **Tokenize** the full text using the Nomic tokenizer (available via `@huggingface/transformers`).
2. If token count <= 8,192: embed as-is, return a single vector (current behavior).
3. If token count > 8,192: **split on semantic boundaries**:
   - First pass: split on markdown headings (`## `, `### `, etc.) — each heading starts a new section.
   - Second pass: any section still over the limit gets split on paragraph breaks (`\n\n`).
   - Third pass: any paragraph still over the limit gets split on sentence boundaries (`. ` followed by uppercase).
   - Final fallback: hard split at token limit with ~128 token overlap.
4. Embed each chunk, return an array of vectors.

**IPC protocol change:** The `embed-result` message changes from `vector: number[]` to `vectors: number[][]`. A single-chunk result is `vectors: [vec]`. The `embed-error` message is unchanged.

**Embedder interface change:**
- `embedDocument(text: string): Promise<Float32Array[]>` (was `Promise<Float32Array>`)
- `embedQuery(text: string): Promise<Float32Array>` (unchanged — queries are always short)

### 2. Indexer Changes (Multi-Vector Storage)

The indexer (`indexer.ts`) adapts to handle multiple vectors per content item.

**`processOne()` changes:** When `embedDocument` returns N vectors, the indexer stores N rows in `embedding_meta` + `embedding_vec`, using `chunk_index` 0..N-1. The content hash is computed once on the full assembled content — if the hash matches, all chunks are skipped.

**Stale chunk cleanup:** If a node previously had 5 chunks but now has 3 (content got shorter), the indexer deletes chunks with `chunk_index >= N` after upserting the current ones:
```sql
DELETE FROM embedding_meta
WHERE node_id = ? AND source_type = ? AND extraction_ref IS ? AND chunk_index >= ?
```
With a matching delete on `embedding_vec`.

**`removeNode()` unchanged** — already deletes all `embedding_meta` rows for a node.

**`assembleContent()` unchanged** — still produces the full text. The worker decides whether and how to chunk.

**Queue item contract unchanged** — `EmbeddingQueueItem` stays `{ node_id, source_type, extraction_ref?, retries? }`. The indexer doesn't know or care about chunks.

### 3. Extraction Embedding Pipeline

When a node is enqueued with `source_type: 'node'`, the indexer also discovers and enqueues its extraction content.

**At enqueue time:** After enqueuing the node itself, the indexer parses the node's body for `![[embed]]` references (using `parseEmbedReferences` from `assembler.ts`). For each reference that resolves to a non-markdown file (audio, PDF, image, etc.), it enqueues:
```
{ node_id, source_type: 'extraction', extraction_ref: 'recording.m4a' }
```

Markdown embeds are excluded — they are already indexed as their own nodes with their own embeddings, so embedding them again as extractions of the referencing node would be double-counting.

**At process time:** When `processOne()` picks up an extraction item:

1. Resolve `extraction_ref` to a file path (same resolution as `assembler.ts` — direct path, then vault-wide basename search).
2. Call `extractionCache.getExtraction(filePath)` to get extracted text (cache hit or extract on the spot).
3. Hash the extracted text for change detection (keyed on `node_id + source_type + extraction_ref`).
4. Send text through `embedDocument()` — chunks if needed (audio transcriptions at ~37K chars will chunk).
5. Store vectors with `source_type='extraction'` and the `extraction_ref`.

**New indexer dependencies:** `createEmbeddingIndexer()` gains `ExtractionCache` and `vaultPath` parameters.

**Watcher integration:** When the watcher enqueues a node after a file change, the same embed-reference discovery runs, keeping extraction embeddings current when notes add or remove `![[embed]]` references.

**Search already handles this:** `search.ts` already joins `embedding_meta` for `source_type` and `extraction_ref`, and `fuseResults` already populates `matched_embed` on `SearchHit` for extraction vector hits. This path is just never triggered today.

### 4. Search Changes (Chunk Attribution)

**Vector search:** With multiple chunks per node, `vectorSearch()` may return several hits for the same node at different ranks. `fuseResults()` already accumulates scores per `node_id`, so a node matching on 3 chunks gets 3 RRF rank contributions — naturally boosting nodes with multiple relevant chunks. No change needed to fusion logic.

**Chunk attribution:** Add an optional `matched_chunk_index: number` field to `SearchHit`. Record the `chunk_index` of the highest-scoring vector hit for each node. Informational only — existing consumers ignore it.

**`VECTOR_LIMIT`:** Increase from `k=200` to `k=400` to maintain result diversity when multi-chunk nodes consume more vector hits. Cheap at this scale.

**No FTS changes.** FTS5 searches `nodes_fts` (one row per node). Chunking doesn't apply to FTS. Hybrid fusion works as before.

### 5. Migration and Backwards Compatibility

**No schema migration needed.** `embedding_meta` already has `chunk_index`, `source_type`, and `extraction_ref` columns with the correct unique constraint.

**Re-embedding on upgrade:** Existing embeddings were embedded as full (potentially truncated) text with `chunk_index=0`. After this change, the same nodes produce different (better) embeddings. Treat as a re-index event: on first startup after upgrade, clear and re-queue all embeddings.

**Version detection:** Add a `search_version` integer to the engine's metadata (e.g., a row in a `meta` table or a user pragma). Current implicit version is 1. This change bumps to 2. On startup, if `search_version < 2`, clear all embeddings, re-queue everything, update the version.

**Embedder interface is internal.** The `embedDocument` return type change from `Float32Array` to `Float32Array[]` only affects `indexer.ts`. No MCP tool or external contract changes.

## Vault Scale Context

| Metric | Value |
|--------|-------|
| Total nodes | 7,285 |
| Nodes with body | 4,392 |
| Median body size | 1,088 chars |
| p90 body size | 8,273 chars |
| p99 body size | 37,657 chars |
| Max body size | 284,057 chars |
| Nodes exceeding ~8K chars | 448 (will chunk) |
| Cached extractions | 32 (17 audio, 8 markdown, 4 PDF, 3 image) |
| Avg extraction size (audio) | ~37K chars |
| Avg extraction size (PDF) | ~4K chars |

## What This Does NOT Cover

- **Cross-node query joins** — separate charter, independent work.
- **Chunking for FTS** — FTS5 operates on full node text; chunking is an embedding concern only.
- **Extraction discovery beyond `![[embed]]`** — only Obsidian embed syntax is parsed. Inline links (`[[ref]]`) are relationships, not embedded content.
- **New MCP tools** — no new tools; existing `query-nodes` search and `read-embedded` continue to work as before.
