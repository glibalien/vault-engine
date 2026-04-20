# Vault Engine

A database-authoritative knowledge graph engine for markdown vaults, exposed to AI clients via the Model Context Protocol (MCP). SQLite is the source of truth; markdown files are a rendered view of that state, kept in sync by a bidirectional pipeline. Plain markdown in, structured queries out.

---

## Technical Highlights

- **Single mutation pipeline.** Every write — whether from an MCP tool call, a file watcher event, or the periodic normalizer — flows through one transactional pipeline: parse → validate → coerce → render → write. No parallel code paths, no divergence between tool and editor edits.
- **Database-authoritative sync.** SQLite (WAL, foreign keys on) owns the truth. The file watcher updates the DB and stops; it never writes files. Files catch up on the next tool write or normalizer sweep. This asymmetry eliminates the merge collisions that plague two-way sync.
- **Hybrid semantic + full-text search.** SQLite FTS5 over titles and bodies, fused via reciprocal rank fusion with 256-dimensional Nomic embeddings stored in `sqlite-vec`. Long documents are semantically chunked with overlap; each chunk is a separate vector row.
- **Subprocess-isolated embedding model.** The ONNX runtime (~1.5 GB resident) runs in a forked child, serves requests over IPC, and self-exits after 5 minutes idle. Cold restart is ~2–3 s and transparent to callers.
- **Rich schema system.** A global field pool with per-type override rules: schemas can override `required`, `default_value`, and `enum_values` on claimed fields, gated per-property on the global field. Multi-type conflict resolution is explicit (union for enums, cancellation for required/defaults).
- **Reversible mutations.** Every tool-initiated write captures a pre-mutation snapshot. Operations are reviewable via `list-undo-history` and reversible via `undo-operations`, with 24 h retention and throw-safe finalization.
- **Bulk mutation with dry-run.** `update-node` accepts a query predicate and applies `add_types`, `remove_types`, or `set_fields` across the matched set. Dry-run defaults on; the query builder is shared with `query-nodes` for predicate consistency.
- **Multi-format content extraction.** Office documents, PDFs (text + OCR fallback), images, and audio. Extracted text is cached by content hash. Vision and audio providers are API-gated and pluggable (`VISION_PROVIDER=gemini|claude`).
- **Path-traversal safe.** Every filesystem entry point goes through `safeVaultPath()`, which resolves and verifies containment within the vault root before any read, write, rename, or delete.
- **Data is never silently dropped.** Orphaned fields persist when types are removed. Required-missing errors are tolerated on normalizer re-renders but blocked on tool writes. Type-unknown writes are rejected with the available schema list.

---

## Architecture

### The core asymmetry

Traditional vault sync tools treat the filesystem as the truth and the database as an index. Vault Engine inverts this: the SQLite database is the source of truth, and markdown files are a rendered projection of its state. The watcher reads files and updates the DB. The pipeline renders from the DB and writes files. There is no code path where the filesystem "wins" without first being re-parsed, validated, and promoted into the DB.

This asymmetry matters because it eliminates entire classes of bugs: no phantom fields from stale parses, no editor-vs-tool write races, no schema changes that break frontmatter silently.

### Mutation pipeline

Every write — MCP tool, watcher event, schema propagation, normalizer sweep — flows through the same pipeline inside a single transaction:

1. **Load schema context** — fetch schema definitions and global fields for the node's types.
2. **Validate and coerce** — check fields against type claims; coerce dates (ISO 8601 plus fuzzy natural-language via `chrono-node`), match enum values, cast numeric/boolean/JSON types. Produces a typed `coerced_state`.
3. **Source-specific error handling** — tool writes block on validation errors with structured error payloads. The watcher absorbs recoverable errors and retains DB values for rejected fields. The normalizer tolerates `REQUIRED_MISSING` since it only re-renders existing state.
4. **Compute effective state** — resolve overrides, apply per-type merges, determine field ordering (claimed fields by `sort_order` then unicode; orphans trail).
5. **Render** — produce markdown with YAML frontmatter, compute SHA-256 content hash. If the hash matches both disk and DB, the transaction rolls back (no-op).
6. **Write** — under a write lock: atomic file write, upsert `nodes`, replace types/fields/relationships, update FTS index, enqueue for embedding, log to `edits_log`.

### File watcher

Chokidar monitors the vault directory. The watcher is DB-only — it never writes files back.

- **Debounce**: 2.5 s with a 5 s max-wait (matches Obsidian's ~2 s save cycle).
- **Write-lock check**: skips files the pipeline just wrote, preventing re-processing of its own output.
- **Parse retry**: up to 3 attempts with 2 s delay, to survive Obsidian's truncation window on growing files.
- **Hash guard**: compares `sha256(file content)` to the stored `content_hash`; skips on match.
- **YAML `uniqueKeys: false`**: Obsidian's property editor can emit duplicate YAML keys — the parser tolerates them (last wins) instead of throwing.

### Normalizer

A cron-scheduled sweep that re-renders files from DB state to fix drift (schema changes, field-order changes, new defaults, render-format changes). Per file: skip if excluded, skip if modified within the quiescence window (default 60 min), render from DB, diff hash, rewrite if stale. Summary row in `edits_log`; per-file events in `sync_log`. Also runnable one-shot with `--normalize` (`--dry-run` supported).

### Undo / restore

Every tool mutation captures a pre-mutation snapshot via `UndoContext`, threaded through `executeMutation` and `executeDeletion`. Tool handlers register an operation, pass `{ operation_id }` to the pipeline, and call `finalizeOperation` in a `finally` block (throw-safe). Restores run through the same pipeline with `source: 'undo'`, which suppresses nested capture, tolerates required-missing, and disables default backfilling. Snapshot inserts use `INSERT OR IGNORE` so multi-call handlers sharing an `operation_id` are safe. Hourly cleanup sweep; 24 h retention; 60 s orphan grace period.

---

## Search & Retrieval

### Hybrid search

Combines lexical and semantic signals via reciprocal rank fusion (K=60).

- **Full-text**: SQLite FTS5 (contentless) over node titles and bodies.
- **Semantic**: Nomic `embed-text-v1.5`, 256-dimensional q8-quantized vectors stored in `sqlite-vec`.
- **Structured filters**: shared query builder supports `types`, `without_types`, `fields`, `without_fields`, `title_eq`, `title_contains` — boostless filtering rather than hacked-in ranking weights.

### Embedding pipeline

- **Subprocess-isolated ONNX runtime.** The model runs in a forked child (`src/search/embedder-worker.ts`) managed by a host (`src/search/embedder-host.ts`). Spawns on first request, idles out after 5 minutes, respawns on demand. Isolates the ~1.5 GB working set from the main process.
- **Chunking for long inputs.** `embedDocument` returns `Float32Array[]` — one vector per chunk. The chunker (`src/search/chunker.ts`) splits semantically (headings → paragraphs → sentences → hard-split), with 128-token overlap, then packs. `MAX_TOKENS = 2048` is deliberately below Nomic's 8192 window: ONNX's memory arena sizes to the largest tensor it's seen and doesn't shrink, so 8k-token embeds bloat RSS by ~6 GB. 2048 caps the arena at ~1.5 GB and tends to improve retrieval (mean-pooled long vectors blur topical specificity).
- **Multi-vector storage.** One `embedding_meta` + `embedding_vec` row per `(node_id, source_type, extraction_ref, chunk_index)`. Writes are transactional — delete all existing rows for the group, insert N fresh rows. Group-level hash skip avoids redundant work.
- **Extraction embeddings.** Non-markdown `![[embed]]` refs are resolved, extracted, hashed, and embedded as separate rows with `source_type='extraction'`. Stale extraction rows reconcile on every node enqueue.
- **Versioned index.** `meta.search_version` tracks the embedding pipeline version. Bumping `CURRENT_SEARCH_VERSION` clears all vectors and re-enqueues every node at startup.

---

## Content Extraction

Extracted text is cached by content hash in `extraction_cache`. Multiple extractors per file type, with fallback chains.

**Always available**
- Markdown — direct parsing (no extractor).
- Word, Excel, PowerPoint — via `officeparser` and `xlsx`.
- PDFs (text) — via `unpdf`, fast and OCR-free.

**API-gated**
- Audio (`.m4a`, `.mp3`, `.wav`, `.webm`, `.ogg`) — Deepgram Nova-3. Requires `DEEPGRAM_API_KEY`.
- Images (`.png`, `.jpg`, `.gif`, `.webp`) — Gemini or Claude Vision. Requires the corresponding key.
- Scanned PDFs — automatic vision fallback when `avgCharsPerPage < 50`. Uses the same vision provider.

**Provider selection.** `VISION_PROVIDER=gemini|claude` (default `gemini`) picks the vision model. Missing key for the selected provider → warning + vision disabled (text-PDF extraction still works).

---

## Schema System

### Global field pool

Fields are defined once in the global pool (`global_fields`) with a declared type, optional enum values, optional default, and `overrides_allowed` permissions. Types "claim" fields via `schema_field_claims` — multiple types can claim the same global field.

### Per-type overrides

A schema can override `required`, `default_value`, or `enum_values` on a claimed field, but only if the global field's `overrides_allowed` grants permission for that property. Override semantics:

- **Enums** — replace (not extend). A type's override fully supersedes the global enum list.
- **Required / default_value** — cancellation-on-conflict across multi-type nodes: if types disagree, the effective value falls back to the global definition. Enum override: valid-for-any-type (accepted if any applicable type accepts it).
- **Null-as-value** — `default_value_override: null` means "no default on this type" (not "inherit"). Stored via the `default_value_overridden` boolean flag to distinguish from absence.

### Defaults are creation-only

The normalizer never backfills missing defaults — it only re-renders existing state. Defaults populate at node creation, type addition, and schema propagation (for newly-added claims), never retroactively. The validation gate (`skipDefaults`) and pipeline tolerance (`REQUIRED_MISSING` accepted for normalizer source) enforce this.

### Fuzzy date coercion

Date fields accept ISO 8601 (with `T` or space, optional seconds) and fall back to `chrono-node` natural-language parsing (`"6 March 2020 | 6:35 am"` → `2020-03-06T06:35`). Fuzzy-parsed values are tagged `STRING_TO_DATE_FUZZY` in coercion output so tools can surface the interpretation.

---

## MCP Surface

29 tools, all behaving consistently: they share the mutation pipeline, the query builder, path safety, and undo capture.

**Nodes** — `create-node`, `get-node`, `update-node`, `delete-node`, `rename-node`, `query-nodes`, `validate-node`, `batch-mutate`

**Types** — `add-type-to-node`, `remove-type-from-node`, `list-types`

**Schemas** — `create-schema`, `update-schema`, `delete-schema`, `describe-schema`, `list-schemas`

**Global Fields** — `create-global-field`, `update-global-field`, `delete-global-field`, `rename-global-field`, `describe-global-field`, `list-global-fields`

**Discovery** — `list-field-values`, `infer-field-type`

**Content** — `read-embedded`

**Undo** — `list-undo-history`, `undo-operations`

**System** — `vault-stats`, `query-sync-log`

### Bulk mutate via query mode

`update-node` has two modes. Single-node mode accepts a `node_id` and performs the edit with `dry_run` support. Query mode accepts the same predicate as `query-nodes` plus `add_types`, `remove_types`, and `set_fields` — applied across the matched set. Dry-run defaults on in query mode; execution is best-effort (not a single transaction — failures are reported per node without aborting the run).

### Type safety on writes

Tool writes reject unknown types with `UNKNOWN_TYPE` and the list of `available_schemas`. The watcher path stays permissive so editor-authored frontmatter with new types doesn't bounce at the door.

---

## Database Schema

SQLite with WAL mode and foreign keys enabled. 12 tables + 3 virtual tables:

| Table | Purpose |
|-------|---------|
| `nodes` | Core node data: file path, title, body, content hash, timestamps |
| `node_types` | Node ↔ schema type mapping (many-to-many) |
| `node_fields` | Field values in columnar form (text, number, date, json) with raw text preserved for wiki-link round-tripping |
| `relationships` | Wiki-links and references (raw targets, resolved at query time) |
| `global_fields` | Global field pool: type, enum values, defaults, override permissions |
| `schemas` | Type definitions: display name, icon, filename template, default directory |
| `schema_field_claims` | Per-type field overrides: required, default, enum values, sort order |
| `edits_log` | Mutation audit log: tool writes, normalizer sweeps, conflicts, defaults |
| `sync_log` | File-sync events (24 h retention) |
| `extraction_cache` | Content extraction cache keyed by content hash |
| `schema_file_hashes` | `.schema.md` hashes for drift detection |
| `undo_operations` + `undo_snapshots` | Pre-mutation snapshots for reversibility (24 h retention) |
| `embedding_meta` | One row per `(node_id, source_type, extraction_ref, chunk_index)` |
| `nodes_fts` | FTS5 virtual table on title + body (contentless) |
| `embedding_vec` | sqlite-vec virtual table: 256-dim float vectors |

---

## Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/mcp/` | MCP server, tool definitions, shared query builder |
| `src/db/` | SQLite connection (WAL, foreign keys), search-version migration |
| `src/parser/` | Markdown / YAML frontmatter parser (`yaml` directly, not gray-matter) |
| `src/renderer/` | DB state → markdown file renderer |
| `src/indexer/` | Initial scan + incremental indexer, exclusion rules |
| `src/pipeline/` | Single mutation pipeline, path safety, type checks, delete pipeline |
| `src/schema/` | Schema CRUD and propagation |
| `src/validation/` | Field validation, coercion, per-type override merging |
| `src/global-fields/` | Global field pool management |
| `src/discovery/` | Field-value enumeration, type inference |
| `src/resolver/` | Wiki-link and reference resolution |
| `src/sync/` | Watcher, reconciler, normalizer, write lock |
| `src/search/` | Embedding host/worker, chunker, hybrid search (FTS5 + vector + RRF) |
| `src/extraction/` | Office, PDF, image, audio extractors with provider fallbacks |
| `src/undo/` | Undo snapshots, restore, cleanup |
| `src/auth/` | OAuth (HTTP transport) |
| `src/transport/` | HTTP (Express + StreamableHTTPServerTransport) and stdio layers |

---

## Setup

### Prerequisites

- Node.js >= 20
- A markdown vault directory

### Install and build

```bash
git clone <repo-url> vault-engine
cd vault-engine
npm install
npm run build
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_PATH` | Yes | Absolute path to the vault directory |
| `DB_PATH` | No | SQLite path (default `<VAULT_PATH>/.vault-engine/vault.db`) |
| `OAUTH_OWNER_PASSWORD` | HTTP only | Password for the OAuth token endpoint |
| `OAUTH_ISSUER_URL` | HTTP only | OAuth issuer URL for token validation |
| `VISION_PROVIDER` | No | `gemini` (default) or `claude` |
| `GEMINI_API_KEY` | No | Enables Gemini Vision (images + scanned PDFs) |
| `ANTHROPIC_API_KEY` | No | Enables Claude Vision (images + scanned PDFs) |
| `DEEPGRAM_API_KEY` | No | Enables Deepgram Nova-3 audio transcription |
| `NORMALIZE_CRON` | No | Cron expression for the periodic normalizer |
| `NORMALIZE_QUIESCENCE_MINUTES` | No | Skip files modified within this window (default 60) |
| `VAULT_EXCLUDE_DIRS` | No | Comma-separated folder prefixes to exclude entirely |

### Running

```bash
npm run dev                                    # dev (auto-reload)
npm start                                      # stdio transport
npm run start:http                             # HTTP transport
node dist/index.js --transport both --port 3334
node dist/index.js --normalize                 # one-shot normalizer sweep
node dist/index.js --normalize --dry-run       # show stale files without writing
node dist/index.js --reindex-search            # clear + rebuild the search index
```

---

## Deployment

### Systemd

```ini
[Unit]
Description=Vault Engine
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/vault-engine
EnvironmentFile=/path/to/vault-engine/.env
ExecStart=/usr/bin/node dist/index.js --transport http --port 3334
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Remote access via Cloudflare Tunnel

```yaml
ingress:
  - hostname: vault.example.com
    service: http://localhost:3334
```

OAuth auth is enforced on the HTTP transport (Bearer token, rate-limited to 5 attempts / 60 s). Stdio transport has no auth — it trusts the local process.

---

## Testing

```bash
npm test              # vitest run
npm run test:watch    # watch mode
npm run test:perf     # performance benchmarks
```

---

## License

MIT
