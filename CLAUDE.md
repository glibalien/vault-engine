# CLAUDE.md

## Project

Vault Engine — database-authoritative knowledge graph engine for a markdown vault. MCP tools are the primary surface.

## Charter

The charter at `~/Documents/archbrain/Notes/Vault Engine - Charter.md` is the **source of truth** for every design decision. Read it before any implementation work. If anything conflicts with the charter, the charter wins.

## Architecture (one sentence)

The database is the source of truth. Markdown files are a rendered view of database state, not the other way around.

## Key constraints

- **No gray-matter.** Use the `yaml` npm package directly. gray-matter caused real bugs in the old system.
- **No copying from vault-engine-old** except auth (`src/auth/`) and transport (`src/transport/`), which were copy-forwarded in Phase 0. Everything else is new code.
- **Do not touch vault-engine-old.** The old repo at `~/projects/vault-engine-old` is read-only reference. Do not modify it, import from it, or affect its running service.
- **Single mutation pipeline.** Every write (MCP tool call or watcher-detected edit) flows through parse → validate → coerce → reconcile → apply → render. No parallel code paths.
- **Data is never silently deleted.** Orphan fields preserve data. Removed types leave fields behind.
- **Ask before expanding scope.** If a task requires touching a module outside the current feature, stop and report.

## Build & test

```bash
npm run build        # tsc
npm test             # vitest run
npm run dev          # tsx watch src/index.ts
npm run start:http   # node dist/index.js --transport http
```

## Deployment

- Runs under systemd — see `vault-engine-new.service.example`
- Default port **3334** (configurable via `--port`)
- Designed to sit behind a reverse proxy or Cloudflare tunnel for TLS termination
- Env vars loaded via systemd `EnvironmentFile` or `.env`
- Required env: `OAUTH_OWNER_PASSWORD`, `OAUTH_ISSUER_URL`
- Optional env: `VAULT_EXCLUDE_DIRS` (comma-separated folder prefixes to exclude from indexing entirely, e.g. `Templates`)

## Conventions

- `.vault-engine/` directory holds SQLite DB, WAL, and engine cache/logs. Excluded from file watcher.
- DB path default: `<vault>/.vault-engine/vault.db` (production uses `vault-new.db` during Phase 0)
- `db/connection.ts` opens the DB with WAL mode and foreign keys enabled.
- ESM throughout (`"type": "module"` in package.json, `.js` extensions in imports)
- **YAML `nullStr: ''`** in render options — null values serialize as bare `key:` not `key: null`. This is critical for Obsidian compatibility: `types: []` (flow notation) mangles when Obsidian adds items; implicit null `types:` does not.
- **YAML `uniqueKeys: false`** in parse options — Obsidian's property editor can create duplicate YAML keys (e.g. two `types:` entries). The parser tolerates this (last value wins) instead of throwing.
- **Watcher is DB-only**: the watcher never writes files to disk. It updates the DB and stops. Files catch up via tool writes and schema propagation. This prevents Obsidian merge collisions that corrupted frontmatter.
- **Watcher debounce**: 2.5 seconds (matches Obsidian's 2s save cycle). Max-wait 5 seconds.
- **Parse retry**: if YAML parsing fails (e.g. Obsidian truncation bug where growing files are temporarily truncated on disk), the watcher retries up to 3 times with 2s delay before logging a parse error.
- **Shared query builder**: `src/mcp/query-builder.ts` — single SQL builder used by both `query-nodes` and `update-node` query mode. Supports negation filters (`without_types`, `without_fields`), title filters (`title_eq`, `title_contains`).
- **Bulk mutate**: `update-node` query mode supports `add_types`, `remove_types`, `set_fields` across filtered node sets. Best-effort execution (not transactional). Dry-run defaults to true in query mode.
- **Type safety**: Tool-initiated writes reject types without schemas (`UNKNOWN_TYPE` error with `available_schemas`). Watcher path stays permissive. `create-node` and `update-node` single-node mode support `dry_run`. `update-node` single-node mode supports `add_types`/`remove_types` (not just `set_types`). See `src/pipeline/check-types.ts`.
- **Date coercion**: accepts ISO 8601 (with `T` or space separator, seconds optional), and falls back to fuzzy natural-language parsing via `chrono-node` (e.g. `"6 March 2020 | 6:35 am"` → `2020-03-06T06:35`). Fuzzy-parsed dates are tagged `STRING_TO_DATE_FUZZY` in coercion results.
- **Folder exclusion**: `VAULT_EXCLUDE_DIRS` env var excludes folders from all subsystems (indexer, watcher, reconciler, normalizer). Segment-based matching — excluding `Notes` won't match `TaskNotes`. See `src/indexer/ignore.ts`.
- **Subprocess-isolated embedder**: The ONNX embedding model runs in a forked child process (`src/search/embedder-worker.ts`), managed by `src/search/embedder-host.ts`. The child spawns on first embed request, serves requests over IPC, and is killed after 5 minutes of idle to reclaim ~1.5 GB of ONNX Runtime memory. It respawns transparently on the next request (~2-3s cold start). At startup, the bulk embed runs eagerly then the child idles out. All consumers (indexer, search, watcher) are unaware of the subprocess.
- **Chunking for long inputs.** `embedDocument` returns `Float32Array[]` — one vector per chunk. The worker tokenizes via `extractor.tokenizer(text).input_ids.dims[1]` and, if the count exceeds Nomic's 8,192-token window, splits semantically in `src/search/chunker.ts` (headings → paragraphs → sentences → hard-split with 128-token overlap, then packs). Each chunk gets the `search_document:`/`search_query:` prefix reapplied before embedding. `embedQuery` still returns a single `Float32Array` (queries are short). `PREFIX_HEADROOM_TOKENS = 32` leaves room for the prefix + re-tokenization drift.
- **Multi-vector storage.** One `embedding_meta` + `embedding_vec` row per `(node_id, source_type, extraction_ref, chunk_index)` combo. Writes use a transactional `writeGroup` helper that deletes all existing rows for the group and inserts N fresh rows atomically — no update-in-place, no partial state. Hash skip is group-level: if any existing row matches the current content hash, we assume all chunks are current and skip.
- **Extraction embeddings.** When a node is enqueued, the indexer walks its body for `![[embed]]` refs and enqueues `source_type='extraction'` items for every non-markdown ref (markdown refs are their own nodes). `processOne` resolves the ref via `src/extraction/resolve.ts` (shared with assembler), extracts via `ExtractionCache`, hashes the text, and embeds. Stale extraction rows are reconciled on every node enqueue: refs no longer in the body are pruned. `removeNode(nodeId)` is wired into every node-delete site (`deleteNodeByPath`, `delete-node`, `batch-mutate`, watcher unlink) to keep `embedding_vec` (a virtual table with no FK cascade) in sync.
- **Search version migration.** `meta.search_version` tracks the embedding pipeline version (see `src/db/search-version.ts`). `CURRENT_SEARCH_VERSION = 2` (v1 = pre-chunking truncated embeddings; v2 = chunking + extractions). At startup, if `storedVersion < CURRENT_SEARCH_VERSION`, the engine clears all embeddings, re-enqueues every node, and bumps the stored version. Bump the constant whenever a change makes existing stored vectors semantically wrong.
- **Path containment**: `safeVaultPath()` in `src/pipeline/safe-path.ts` guards every filesystem entry point. All user-supplied paths (directory, title, file_path, filename) are resolved and verified to stay within the vault root before any read, write, rename, or delete. Throws `"Path traversal blocked"` on `../` escape attempts.
- **Defaults are creation-only.** The normalizer never backfills missing defaults — it only re-renders existing DB state. Default values are populated at node creation, type addition, and schema propagation (added claims), but never retroactively. The validation gate (`skipDefaults`) and pipeline error tolerance (`REQUIRED_MISSING` tolerated for normalizer source) enforce this. See `src/validation/validate.ts` and `src/pipeline/execute.ts`.
- **Per-type field overrides.** Schemas can override `enum_values`, `default_value`, and `required` on claimed fields. Gated per-property via `overrides_allowed: { required, default_value, enum_values }` on the global field. Override semantics: replace (not extend) for enums. Multi-type resolution: enum uses valid-for-any-type (value accepted if any type accepts it); required/default_value use cancellation-on-conflict (disagreements fall back to global). `default_value_override: null` means "no default" (not inherit) — stored via `default_value_overridden` boolean flag in DB. See `src/validation/merge.ts`.

## Phased delivery

- **Phase 0**: empty project, working OAuth + MCP transport, `vault-stats` stub ✓
- **Phase 1**: SQLite schema, parser, indexer, read-only MCP tools, watcher ✓
- **Phase 2**: global field pool, schema system, validation ✓
- **Phase 3**: write path, renderer, full sync loop — minimum shippable product ✓
- **Phase 4–6**: semantic search, content extraction, workflow tools
