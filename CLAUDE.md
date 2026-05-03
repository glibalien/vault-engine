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
npm run build        # tsc + typecheck (runs the test tsconfig project too)
npm test             # vitest run (excludes tests/perf/)
npm run test:perf    # performance suite via vitest.perf.config.ts
npm run dev          # tsx watch src/index.ts
npm run start:http   # node dist/index.js --transport http
```

`AGENTS.md` (sibling to this file) holds repo-style guidelines (filename casing, commit-message conventions, PR expectations) for human + agent contributors.

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
- **Chunking for long inputs.** `embedDocument` returns `Float32Array[]` — one vector per chunk. The worker tokenizes via `extractor.tokenizer(text).input_ids.dims[1]` and, if the count exceeds `MAX_TOKENS = 2048`, splits semantically in `src/search/chunker.ts` (headings → paragraphs → sentences → hard-split with 128-token overlap, then packs). `MAX_TOKENS` is deliberately well below Nomic's 8,192 window: ONNX Runtime's memory arena sizes to the largest tensor shape it's seen and doesn't shrink, so an 8k-token embed alone bloated RSS by ~6 GB. 2048 keeps peak arena bounded (~1.5 GB observed) and generally improves retrieval quality since mean-pooled long-context vectors blur topical specificity. Each chunk gets the `search_document:`/`search_query:` prefix reapplied before embedding. `embedQuery` still returns a single `Float32Array` (queries are short). `PREFIX_HEADROOM_TOKENS = 32` leaves room for the prefix + re-tokenization drift.
- **Multi-vector storage.** One `embedding_meta` + `embedding_vec` row per `(node_id, source_type, extraction_ref, chunk_index)` combo. Writes use a transactional `writeGroup` helper that deletes all existing rows for the group and inserts N fresh rows atomically — no update-in-place, no partial state. Hash skip is group-level: if any existing row matches the current content hash, we assume all chunks are current and skip.
- **Extraction embeddings.** When a node is enqueued, the indexer walks its body for `![[embed]]` refs and enqueues `source_type='extraction'` items for every non-markdown ref (markdown refs are their own nodes). `processOne` resolves the ref via `src/extraction/resolve.ts` (shared with assembler), extracts via `ExtractionCache`, hashes the text, and embeds. Stale extraction rows are reconciled on every node enqueue: refs no longer in the body are pruned. `removeNode(nodeId)` is wired at every node-delete call site (`delete-node`, `batch-mutate`, watcher unlink, reconciler sweep, fullIndex bulk-delete) alongside the shared `executeDeletion` pipeline function in `src/pipeline/delete.ts`, to keep `embedding_vec` (a virtual table with no FK cascade) in sync.
- **Vision provider selection.** `VISION_PROVIDER=gemini|claude` (default `gemini`) selects the vision model for image extraction and PDF fallback. Requires `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` respectively. `UnpdfExtractor` is always the `.pdf` primary; the chosen vision extractor is attached only via `setPdfFallback()` and triggers when `avgCharsPerPage < 50`. Missing key for the selected provider → warning + vision disabled (text PDFs still work).
- **Search version migration.** `meta.search_version` tracks the embedding pipeline version (see `src/db/search-version.ts`). `CURRENT_SEARCH_VERSION = 2` (v1 = pre-chunking truncated embeddings; v2 = chunking + extractions). At startup, if `storedVersion < CURRENT_SEARCH_VERSION`, the engine clears all embeddings, re-enqueues every node, and bumps the stored version. Bump the constant whenever a change makes existing stored vectors semantically wrong.
- **Path containment**: `safeVaultPath()` in `src/pipeline/safe-path.ts` guards every filesystem entry point. All user-supplied paths (directory, title, file_path, filename) are resolved and verified to stay within the vault root before any read, write, rename, or delete. Throws `"Path traversal blocked"` on `../` escape attempts.
- **Defaults are creation-only.** The normalizer never backfills missing defaults — it only re-renders existing DB state. Default values are populated at node creation, type addition, and schema propagation (added claims), but never retroactively. The validation gate (`skipDefaults`) and pipeline error tolerance (`REQUIRED_MISSING` tolerated for normalizer source) enforce this.
- **Single default-population path.** `populate-defaults.ts` was deleted (Apr 2026). Defaults flow exclusively through `validateProposedState`, which annotates `EffectiveField.default_source` for downstream consumers. `defaultedFieldsFrom(validation)` in `src/validation/defaults-helper.ts` is the one source of "what was defaulted on this write." Watcher path no longer pre-merges defaults; tools and propagation read from the validation result.
- **Per-type field overrides.** Schemas can override `enum_values`, `default_value`, and `required` on claimed fields. Gated per-property via `overrides_allowed: { required, default_value, enum_values }` on the global field. Override semantics: replace (not extend) for enums. Multi-type resolution: enum uses valid-for-any-type (value accepted if any type accepts it); required/default_value use cancellation-on-conflict (disagreements fall back to global). `default_value_override: null` means "no default" (not inherit) — stored via `default_value_overridden` boolean flag in DB. See `src/validation/merge.ts`.
- **`update-global-field` discard gate.** Type-change `confirm: true` refuses with `CONFIRMATION_REQUIRED` if any existing values won't coerce to the new type. Set `discard_uncoercible: true` to opt into data loss; the discarded values are still recorded in `edits_log` (forensic, not currently MCP-queryable). See `src/global-fields/crud.ts:updateGlobalField` and the spec at `docs/superpowers/specs/2026-04-26-update-global-field-uncoercible-design.md`.
- **Undo snapshots.** `undo_operations` + `undo_snapshots` capture pre-mutation state via `UndoContext` threaded through `executeMutation`/`executeDeletion`. Tool handlers create an operation, pass `{ operation_id }`, and call `finalizeOperation` in `finally` (which is throw-safe). `source: 'undo'` suppresses nested capture, tolerates `REQUIRED_MISSING`, and skips default-population so restores don't backfill. Snapshot INSERTs use `INSERT OR IGNORE` so multi-call tool handlers sharing an operation_id are safe. 24h retention + 60s orphan sweep via hourly `startUndoCleanup` interval. See `docs/superpowers/specs/2026-04-19-undo-system-design.md`.
- **Schema + global-field undo.** `undo_schema_snapshots` (per-schema row + claims) and `undo_global_field_snapshots` (field row + dependent claims/values) extend the undo system. `update-schema`, `create-schema`, `delete-schema`, and the global-field write tools all `captureSchemaSnapshot`/`captureGlobalFieldSnapshot` under the operation. Restore order: schema snapshots first, then nodes, then global fields — this avoids re-validation against the post-state. Multi-snapshot restore runs as a single DB transaction so a partial failure can't leave the vault in a half-restored state. `list-undo-history` surfaces `schema_count`/`global_field_count` alongside `node_count`. See `src/undo/schema-snapshot.ts` and `src/undo/global-field-snapshot.ts`.
- **MCP response envelope.** Every tool returns `{ ok: true, data, warnings }` or `{ ok: false, error: { code, message, details? }, warnings }` via `ok()`/`fail()`/`adaptIssue()` in `src/mcp/tools/errors.ts`. `Issue.code` is a closed `IssueCode` union (split into `ValidationIssueCode` + `ToolIssueCode`); `npm run build` typechecks it via the test tsconfig project so a missing case fails the build. Warnings flow through `warnings: Issue[]` on both branches — soft signals like `LAST_TYPE_REMOVAL`, `PENDING_REFERENCES`, `CROSS_NODE_FILTER_UNRESOLVED`, `RESULT_TRUNCATED` always appear in `warnings`, never as errors.
- **Uniform `dry_run` on mutation tools.** `create-node`, `update-node` (single + query), `delete-node`, `add-type-to-node`, `remove-type-from-node`, `batch-mutate`, and `update-schema` all accept `dry_run`. Dry-run defaults: `true` for `update-node` query mode; `false` everywhere else (including `batch-mutate` and `update-schema`). Bundle authors calling bulk-effect tools must pass `dry_run: true` explicitly on first call. Dry-run responses return a `would_apply` / `would_*` preview shape and never write to disk, the DB, or the undo log.
- **Schema-ops dry-run + confirm gate.** `update-schema dry_run` runs through `previewSchemaChange` which uses a SQLite SAVEPOINT to roll back side effects; the preview returns `claims_added`/`claims_removed`/`would_orphan_field_values`/`propagation` numbers. If a commit would orphan any existing field values, `update-schema` refuses with `CONFIRMATION_REQUIRED` until called with `confirm_large_change: true`. Validation failures from propagation come back as a `VALIDATION_FAILED` envelope with grouped reasons (via `SchemaValidationError` + `groupValidationIssues`). See `src/schema/preview.ts` and `src/schema/errors.ts`.
- **`update-schema` patch-style claim ops.** Alongside `field_claims` (full replace), the tool accepts `add_field_claims`, `update_field_claims`, and `remove_field_claims` for diff-style edits. They are mutually exclusive with `field_claims` and validate that adds don't collide with existing claims and that updates/removes target claims that exist. Internally normalized to a `field_claims` replacement before hitting `previewSchemaChange`. See `src/mcp/tools/update-schema.ts:normalizeSchemaUpdate`.
- **Cross-node joins.** `query-nodes` and `update-node` query mode accept `join_filters` and `without_joins` (same shape, recursive). They compose `INNER JOIN nodes target ON target.id = relationships.resolved_target_id`-style clauses against the `relationships.resolved_target_id` column (populated at insert; backfilled at startup gated by `meta.resolved_targets_version`; refreshed by `refreshOnCreate/Rename/Delete` lifecycle helpers in `src/resolver/refresh.ts`). Multi-hop joins are deferred — nested `join_filters` inside `target` throw `INVALID_PARAMS`. When a query has join targets but unresolved edges exist, a `CROSS_NODE_FILTER_UNRESOLVED` warning surfaces in `warnings` (not as an error).
- **Linked-node traversal.** `get-node` accepts `expand={types, direction?, max_nodes?}` (direction defaults `outgoing`, max_nodes defaults 10, hard cap 25). When present, the response carries an `expanded` map keyed by node id (`{id,title,types,fields,body}`) and `expand_stats` (`{returned, considered, truncated}`). Candidates rank by `file_mtime DESC`. See `src/mcp/expand.ts`.
- **`set_directory` on `update-node`.** Single-node mode accepts `set_directory` and combines it with type, field, body, and title changes (move + edit in one call). Query mode also supports it for bulk moves. The path must be a directory, not a `.md` filename — filename is always derived from the title. `rename-node` remains the right tool when you only need to move/rename one file.
- **Mutation rollback on multi-step tools.** `executeMutation` accepts an optional `fsRollback` callback queue. Tools that perform side effects across multiple mutations (notably `rename-node`, which writes the renamed file plus rewrites wiki-link references in other files) push reverse-write callbacks into the queue and replay them if the outer transaction throws. The rollback verifies the on-disk hash before reverting so it won't clobber concurrent edits. See `src/pipeline/execute.ts` and `src/mcp/tools/rename-node.ts`.

## Phased delivery

All charter phases (0–6) are complete and merged. Phase 5 (field reconciliation) was skipped — structural field hygiene from the global-field pool + normalizer made it unnecessary. Old Phase 6 (content extraction) shipped as Phase 5; current Phase 6 (hardening + docs) shipped 2026-04-13.

Post-phase work is hardening + ergonomics, organized as themed bundles in `docs/superpowers/specs/` and `docs/superpowers/plans/`. Recent merged bundles: chunking + extraction embeddings, embedder subprocess isolation, per-type field overrides, cross-node joins, MCP response envelope, undo system (node + schema + global-field), schema-ops safety (Phase A + B), uniform dry-run, Bundle A pipeline hygiene, Bundle B tool surface symmetry, default-population consolidation, update-schema patch ops.

When picking the next thing to work on, scan `docs/superpowers/specs/` for the latest open spec or check the backlog at `docs/superpowers/plans/`.
