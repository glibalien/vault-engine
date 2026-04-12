# Phase 6 — Content Extraction and Caching

## Overview

Phase 6 adds content extraction for embedded files in vault nodes. When an agent reads a node, all `![[embedded]]` files — audio recordings, images, PDFs, office documents, and other markdown notes — are extracted into text and returned alongside the node's own content. Extracted text is cached by content hash so the expensive extraction (API calls to Deepgram, Claude vision) happens only once per unique file.

This phase does **not** include workflow tools (`create-meeting-notes`, `extract-tasks`). The agent composes those workflows itself using `get-node` (with embeds) plus existing mutation tools.

## Use Cases

1. **Summarize a node**: Agent calls `get-node` with `include_embeds: true` (the default). Gets the node body, metadata, and all embedded content as extracted text. Agent summarizes using its own reasoning.
2. **Understand a specific file**: Agent calls `read-embedded` with a filename. Gets the extracted text for that single file (e.g. a transcription of a specific audio recording).
3. **Speaker identification**: Agent infers speaker names from the diarized transcript and the node's `people_involved` field. No engine-side speaker mapping.
4. **Semantic search (future Phase 4)**: The extraction cache table is queryable, so Phase 4 can index cached extracted text into the embeddings table for vector search.

## Architecture

Three layers, each with a single responsibility:

```
MCP Tools (get-node, read-embedded)
       |
   Assembler  — embed traversal, resolution, stitching
       |
   Cache Layer — content-hash lookup, store, PDF fallback orchestration
       |
   Extractors — per-media-type extraction (API calls or local libraries)
```

### Layer 1: Extractors

#### Interface

```typescript
interface Extractor {
  id: string;                    // e.g. 'deepgram-nova-3'
  mediaType: string;             // e.g. 'audio'
  supportedExtensions: string[]; // e.g. ['.m4a', '.mp3', '.wav', '.webm']
  extract(filePath: string): Promise<ExtractionResult>;
}

interface ExtractionResult {
  text: string;           // Human-readable extracted text
  metadata?: unknown;     // Extractor-specific structured data
}
```

Each extractor knows what file types it handles and returns text plus optional structured metadata. No awareness of caching, embed traversal, or MCP tools.

#### Shipped Extractors

| Extractor ID | Media Type | Extensions | Backend | API Key Required |
|---|---|---|---|---|
| `deepgram-nova-3` | audio | .m4a, .mp3, .wav, .webm, .ogg | Deepgram Nova-3 API with diarization | `DEEPGRAM_API_KEY` |
| `claude-vision-image` | image | .png, .jpg, .jpeg, .gif, .webp | Claude API (vision) | `ANTHROPIC_API_KEY` |
| `unpdf-text` | pdf | .pdf | unpdf (local, Node.js) | none |
| `claude-vision-pdf` | pdf (fallback) | .pdf | Claude API (vision), renders pages to images | `ANTHROPIC_API_KEY` |
| `office-doc` | office | .docx, .pptx, .xlsx, .csv | mammoth, officeparser, SheetJS (all local) | none |
| `markdown-read` | markdown | .md | Direct file read | none |

#### Audio Transcript Format

Deepgram returns speaker-labeled segments. The extractor formats them as:

```
[Speaker 1] 00:00:12
We need to finalize the design by Friday.

[Speaker 2] 00:00:18
I can have the mockups ready by Wednesday.
```

Speaker labels are generic (`Speaker 1`, `Speaker 2`). The agent maps speakers to names using the node's `people_involved` field and conversational context.

The raw diarized segments (with numeric speaker IDs, start/end timestamps) are stored in `metadata_json` for potential re-formatting.

#### Extractor Registry

A map from file extension to extractor instance, configured in code:

```
.m4a, .mp3, .wav, .webm, .ogg  →  deepgram-nova-3
.png, .jpg, .jpeg, .gif, .webp  →  claude-vision-image
.pdf                             →  unpdf-text (with claude-vision-pdf fallback)
.docx                            →  office-doc (mammoth)
.pptx                            →  office-doc (officeparser)
.xlsx, .csv                      →  office-doc (SheetJS)
.md                              →  markdown-read
```

Swapping an extractor means changing the registry setup — a one-line change. No runtime config file initially; can be added later without changing the architecture.

### Layer 2: Cache

#### Table Schema

New `extraction_cache` table in the existing SQLite database:

| Column | Type | Purpose |
|---|---|---|
| `content_hash` | TEXT PK | SHA-256 of the source file bytes |
| `file_path` | TEXT NOT NULL | Vault-relative path (for debugging/display; not lookup key) |
| `media_type` | TEXT NOT NULL | `audio`, `image`, `pdf`, `office`, `markdown` |
| `extractor_id` | TEXT NOT NULL | Which extractor produced this result |
| `extracted_text` | TEXT NOT NULL | Full extracted text |
| `metadata_json` | TEXT | Extractor-specific structured data as JSON |
| `extracted_at` | TEXT NOT NULL | ISO timestamp |

#### Lookup Logic

```
getExtraction(filePath):
  1. Read file, compute SHA-256 hash
  2. SELECT from extraction_cache WHERE content_hash = ?
  3. If hit: return cached text + metadata
  4. If miss:
     a. Look up extractor from registry by file extension
     b. Call extractor.extract(filePath)
     c. INSERT into extraction_cache
     d. Return result
```

#### Cache Invalidation

**Content-hash based — no explicit invalidation needed.** If the file changes, the hash changes, the cache misses, and we re-extract.

Old cache entries for previous hashes become orphans. Orphan cleanup (deleting entries whose hash doesn't match any current vault file) can be done on-demand later — orphans waste storage but don't cause bugs.

**Extractor change:** If a user swaps extractors, the `extractor_id` column lets detection of stale entries. But a cache hit is a cache hit regardless of which extractor produced it. Re-extraction on extractor change is opt-in, not automatic.

#### PDF Fallback

The cache layer orchestrates the text-vs-scanned PDF decision:

1. Call `unpdf-text` extractor
2. If result has < 50 characters per page on average → scanned PDF
   - Call `claude-vision-pdf` extractor instead
   - Cache under the vision extractor's ID
3. Else: cache under `unpdf-text`'s ID

#### Error Handling

If extraction fails (API down, unsupported file, corrupted file), the cache layer returns an error result with the failure reason. Failures are **not cached** — the next call retries. The assembler includes errors in its output so the agent knows what couldn't be extracted.

### Layer 3: Assembler

The assembler walks a node's body, finds all `![[embed]]` references, resolves them through the cache layer, and returns a structured result.

#### Embed Detection

Parses the node body for Obsidian embed syntax: `![[filename.ext]]` (with the `!` prefix, distinct from regular wiki-links). Reuses the existing resolver in `src/resolver/` for path resolution.

#### Assembly Process

```
assemble(nodeId):
  1. Read node from DB (body, fields)
  2. Parse body for ![[embed]] references
  3. For each embed (sequentially):
     a. Resolve to file path via existing resolver
     b. Call cache layer: getExtraction(filePath)
     c. If embedded file is .md, recursively assemble (with cycle detection)
  4. Return structured result
```

#### Return Shape

```typescript
interface AssembledNode {
  node: { title: string; types: string[]; fields: Record<string, unknown> };
  body: string;
  embeds: Array<{
    reference: string;    // original ![[reference]]
    mediaType: string;
    text: string;
  }>;
  errors: Array<{
    reference: string;
    error: string;
  }>;
}
```

#### Cycle Detection and Depth Limit

- Tracks visited node IDs during recursive markdown embed traversal
- Skips already-visited nodes, noting the skip in output
- Default depth limit: 5 levels of nested embeds

## MCP Tool Changes

### `get-node` — Extended

New parameter:
- `include_embeds` (boolean, default `true`) — when true, runs the assembler and includes extracted embed content in the response

When `include_embeds` is true, the response includes the standard node data plus an `embeds` section with extracted text for each embedded file. When false, behavior is unchanged from current implementation.

First call with uncached embeds may be slow (API calls for extraction). Subsequent calls are fast (cache hits).

### `read-embedded` — New Tool

**Purpose:** Extract and return the content of a single file, independent of any node context.

**Parameters:**
- `file_path` (string, optional) — vault-relative path to the file
- `filename` (string, optional) — filename to resolve (one required)

**Returns:** Extracted text, media type, extractor used. For audio: full diarized transcript. For images: OCR/description output. Returns an error if the file extension has no registered extractor.

## Dependencies

New npm packages:
- `unpdf` — PDF text extraction (ESM-native)
- `mammoth` — .docx to text
- `officeparser` — .pptx text extraction
- `xlsx` (SheetJS) — .xlsx/.csv parsing
- `@anthropic-ai/sdk` — Claude API for vision (may already be present)
- Deepgram SDK or direct HTTP calls to Deepgram API

New environment variables:
- `DEEPGRAM_API_KEY` — for audio transcription

`ANTHROPIC_API_KEY` is likely already available from the MCP transport layer.

## What This Phase Does NOT Include

- **`summarize-node` tool** — dropped; `get-node` with `include_embeds: true` serves this purpose
- **`create-meeting-notes` tool** — dropped; the agent composes this using `get-node` + `create-node`
- **`extract-tasks` tool** — dropped; the agent does this with `get-node` + existing mutation tools
- **Speaker-to-name mapping in the engine** — the agent infers speaker identity from context
- **Parallel extraction** — embeds are extracted sequentially; revisit if wall-clock time becomes a problem
- **Runtime extractor configuration** — registry is configured in code; runtime config can be added later

## Semantic Search Integration (Phase 4 Dependency)

The `extraction_cache` table is designed to be queryable by Phase 4. When semantic search is built, the indexer can scan `extraction_cache` and generate embeddings for `extracted_text`, making embedded file content searchable alongside node body text. No schema changes needed — Phase 4 just reads from the cache table.

## File Structure

```
src/extraction/
  types.ts          — Extractor, ExtractionResult, AssembledNode interfaces
  registry.ts       — Extension-to-extractor mapping
  cache.ts          — Cache layer (hash, lookup, store, PDF fallback)
  assembler.ts      — Embed traversal, resolution, stitching
  extractors/
    deepgram.ts     — Audio transcription with diarization
    claude-vision.ts — Image OCR/description and scanned PDF extraction
    unpdf.ts        — Text-based PDF extraction
    office.ts       — docx/pptx/xlsx extraction
    markdown.ts     — Direct markdown file read
```
