# Vault Engine

Database-authoritative knowledge graph engine for markdown vaults, with MCP tools as its primary interface.

## How It Works

Vault Engine treats a SQLite database as the source of truth and markdown files as a rendered view of that state. A file watcher detects edits made in any markdown editor (Obsidian, VS Code, etc.) and syncs them into the database. Every write — whether from an MCP tool call or an editor — flows through a single mutation pipeline (see below). Data is never silently deleted: orphan fields preserve data, and removing types from a node leaves its fields behind.

The engine runs as a long-lived service on the machine that hosts the vault. Clients connect via MCP over HTTP (remote) or stdio (local). A typical setup uses a reverse proxy or Cloudflare tunnel to expose the HTTP transport to remote MCP clients.

### Mutation Pipeline

Every write flows through these stages, all within a single database transaction:

1. **Load schema context** — fetch schema definitions and global field definitions for the node's types
2. **Validate and coerce** — validate fields against type claims, apply coercion (date parsing, enum matching, type casting), produce a typed `coerced_state`
3. **Source-specific error handling** — tool writes block on validation errors; the watcher absorbs what it can and retains DB values for rejected fields; the normalizer tolerates missing-required errors since it only re-renders existing state
4. **Compute effective state** — build render input from effective fields, determine field ordering (claimed fields sorted by `sort_order` then unicode, orphans after)
5. **Render** — produce markdown with YAML frontmatter, compute content hash. If the hash matches both on-disk file and DB, the transaction rolls back (no-op)
6. **Write** — under write lock: write the file atomically, upsert the nodes row, replace types/fields/relationships, update the FTS index, log to `edits_log`

### File Watcher

The watcher (chokidar) monitors the vault directory and syncs editor changes into the database. It never writes files to disk — it updates the DB and stops. Files catch up via tool writes and schema propagation.

- **Debounce**: 2.5 seconds (matches Obsidian's ~2s save cycle), with a 5-second max-wait
- **Write lock check**: if the file was just written by the pipeline, the watcher skips it to avoid re-processing its own output
- **Parse retry**: if YAML parsing fails (e.g. Obsidian's truncation bug where growing files are temporarily incomplete on disk), retries up to 3 times with a 2-second delay before logging a parse error
- **Hash guard**: compares `sha256(file content)` against the DB's `content_hash` and skips if unchanged

### Normalizer

A periodic sweep that re-renders files from database state to fix drift (e.g. schema changes that affect frontmatter layout, field ordering, or default values). Runs on a cron schedule (`NORMALIZE_CRON`).

For each node: skip if the directory is excluded, skip if the file was modified too recently (quiescence window, default 60 minutes), render from DB state, compare hash to DB's `content_hash`, and rewrite if stale. Logs a `normalizer-sweep` summary to `edits_log` and per-file events to `sync_log`.

Can also be run as a one-shot via `--normalize` (skips quiescence, processes all non-canonical files).

### Search

Hybrid search combining full-text and semantic similarity, with reciprocal rank fusion (RRF).

- **Full-text**: SQLite FTS5 on node titles and bodies
- **Semantic**: Nomic embed-text-v1.5 (256 dimensions, q8 quantized) with sqlite-vec for vector storage and search
- **Fusion**: RRF (K=60) merges FTS and vector rankings into a single scored result set
- **Subprocess isolation**: the ONNX embedding model runs in a forked child process to isolate ~1.5 GB of runtime memory. The child spawns on first embed request, serves IPC requests, and exits after 5 minutes idle. It respawns transparently on the next request (~2-3s cold start)

### Content Extraction

Extracts text from non-markdown files embedded in the vault. Extracted text is cached in the database by content hash.

**Always available**:
- Markdown files (direct parsing)
- Office documents — Word, Excel, PowerPoint (via `officeparser`)
- PDFs — fast text extraction without OCR (via `unpdf`)

**API-gated** (enabled by env vars):
- Audio — `.m4a`, `.mp3`, `.wav`, `.webm`, `.ogg` transcription via Deepgram Nova-3 (`DEEPGRAM_API_KEY`)
- Images — `.png`, `.jpg`, `.gif`, `.webp` OCR via Claude Vision (`ANTHROPIC_API_KEY`)
- PDF OCR — scanned/image PDFs via Claude Vision (`ANTHROPIC_API_KEY`)

### Schema System

Schemas define types (e.g. `note`, `task`, `meeting`) that can be assigned to nodes. Each schema declares field claims — which fields from the global field pool it uses, with optional per-type overrides.

**Per-type field overrides**: schemas can override `required`, `default_value`, and `enum_values` on claimed fields. Gated per-property on the global field (`overrides_allowed`). When a node has multiple types that disagree on an override, conflict resolution applies: enum values use union (value accepted if any type accepts it); required and default_value use cancellation (disagreements fall back to the global field definition).

**Defaults are creation-only**: default values are populated at node creation, type addition, and schema propagation, but never retroactively backfilled onto existing nodes.

## Setup

### Prerequisites

- Node.js >= 20
- A markdown vault directory (any folder of `.md` files)

### Install and Build

```bash
git clone <repo-url> vault-engine
cd vault-engine
npm install
npm run build
```

### Environment Variables

Create a `.env` file or export these variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_PATH` | Yes | Absolute path to the markdown vault directory |
| `DB_PATH` | No | Path to SQLite database (default: `<VAULT_PATH>/.vault-engine/vault.db`) |
| `OAUTH_OWNER_PASSWORD` | HTTP only | Password for OAuth token endpoint |
| `OAUTH_ISSUER_URL` | HTTP only | OAuth issuer URL for token validation |
| `ANTHROPIC_API_KEY` | No | Enables Claude Vision for image OCR and scanned PDF extraction |
| `DEEPGRAM_API_KEY` | No | Enables Deepgram Nova-3 for audio transcription |
| `NORMALIZE_CRON` | No | Cron expression for periodic normalizer (e.g. `0 3 * * *` for daily at 3 AM) |
| `NORMALIZE_QUIESCENCE_MINUTES` | No | Skip files modified within this window (default: 60) |
| `VAULT_EXCLUDE_DIRS` | No | Comma-separated folder prefixes to exclude from indexing (e.g. `Templates,Archive/Old`) |

### Running

```bash
# Development (auto-reload)
npm run dev

# Production — stdio transport (for local MCP clients)
npm start

# Production — HTTP transport (for remote MCP clients)
npm run start:http

# Custom port (default: 3333)
node dist/index.js --transport http --port 3334

# Both transports simultaneously
node dist/index.js --transport both --port 3334

# One-shot normalizer sweep (re-renders all stale files, then exits)
node dist/index.js --normalize

# Normalizer dry run (shows which files would be rewritten)
node dist/index.js --normalize --dry-run

# Clear and rebuild the search index
node dist/index.js --reindex-search
```

### Systemd Service (Linux)

For a persistent deployment:

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

### Remote Access

To expose the HTTP transport to remote clients, put it behind a reverse proxy or tunnel. Example with Cloudflare Tunnel:

```yaml
# cloudflared config
ingress:
  - hostname: vault.example.com
    service: http://localhost:3334
```

MCP clients connect to the tunnel hostname. The engine handles OAuth authentication on the HTTP transport (Bearer token validated against the configured issuer, rate-limited to 5 attempts per 60 seconds). Stdio transport has no auth layer — it trusts the local process.

## MCP Tools

Vault Engine exposes 27 MCP tools:

**Nodes** — `create-node`, `get-node`, `update-node`, `delete-node`, `rename-node`, `query-nodes`, `validate-node`, `batch-mutate`

**Types** — `add-type-to-node`, `remove-type-from-node`, `list-types`

**Schemas** — `create-schema`, `update-schema`, `delete-schema`, `describe-schema`, `list-schemas`

**Global Fields** — `create-global-field`, `update-global-field`, `delete-global-field`, `rename-global-field`, `describe-global-field`, `list-global-fields`, `list-field-values`, `infer-field-type`

**Content** — `read-embedded`

**System** — `vault-stats`, `query-sync-log`

## Database Schema

SQLite with WAL mode and foreign keys. 11 tables + 2 virtual tables:

| Table | Purpose |
|-------|---------|
| `nodes` | Core node data: file path, title, body, content hash, timestamps |
| `node_types` | Maps nodes to schema types (many-to-many) |
| `node_fields` | Field values in columnar form (text, number, date, json columns) with raw text preserved for wiki-link round-tripping |
| `relationships` | Wiki-links and references (raw target strings, resolved at query time) |
| `global_fields` | Field pool definitions: type, enum values, defaults, override permissions |
| `schemas` | Type definitions: display name, icon, filename template, default directory |
| `schema_field_claims` | Per-type field overrides: required, default value, enum values, sort order |
| `edits_log` | Mutation audit log: tool writes, normalizer sweeps, conflicts, defaults applied |
| `sync_log` | File sync events: watcher triggers, parse retries, file writes (24h retention) |
| `extraction_cache` | Content extraction cache keyed by content hash |
| `schema_file_hashes` | Rendered `.schema.md` file hashes for drift detection |
| `nodes_fts` | FTS5 virtual table on title + body (contentless) |
| `embedding_vec` | sqlite-vec virtual table: 256-dim float vectors for semantic search |

## Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/mcp/` | MCP server, tool definitions, query builder |
| `src/db/` | SQLite connection (WAL mode, foreign keys) |
| `src/parser/` | Markdown/YAML frontmatter parser (uses `yaml` directly, not gray-matter) |
| `src/renderer/` | Database state to markdown file renderer |
| `src/indexer/` | File to database indexer (initial scan + incremental) |
| `src/pipeline/` | Single mutation pipeline, path safety, type checking |
| `src/schema/` | Schema CRUD and propagation |
| `src/validation/` | Field validation, coercion, per-type override merging |
| `src/global-fields/` | Global field pool management |
| `src/resolver/` | Wiki-link and reference resolution |
| `src/sync/` | File watcher, reconciler, normalizer, write lock |
| `src/search/` | Embedding host/worker, hybrid search (FTS5 + vector + RRF) |
| `src/extraction/` | Content extraction: markdown, office, PDF, audio, images |
| `src/auth/` | OAuth authentication (HTTP transport) |
| `src/transport/` | HTTP (Express + StreamableHTTPServerTransport) and stdio transport layers |

## Testing

```bash
npm test              # run all tests (vitest)
npm run test:watch    # watch mode
npm run test:perf     # performance benchmarks
```

## License

MIT
