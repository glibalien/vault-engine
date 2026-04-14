# Vault Engine

Database-authoritative knowledge graph engine for markdown vaults, with MCP tools as its primary interface.

## How It Works

Vault Engine treats a SQLite database as the source of truth and markdown files as a rendered view of that state. A file watcher detects edits made in any markdown editor (Obsidian, VS Code, etc.) and syncs them into the database. Every write — whether from an MCP tool call or an editor — flows through a single mutation pipeline: parse, validate, coerce, reconcile, apply, render.

The engine runs as a long-lived service on the machine that hosts the vault. Clients connect via MCP over HTTP (remote) or stdio (local). A typical setup uses a reverse proxy or tunnel to expose the HTTP transport to remote MCP clients.

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

### Running

```bash
# Development (auto-reload)
npm run dev

# Production — stdio transport (for local MCP clients)
npm start

# Production — HTTP transport (for remote MCP clients)
npm run start:http

# Custom port
node dist/index.js --transport http --port 3334

# Both transports simultaneously
node dist/index.js --transport both --port 3334

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

MCP clients connect to the tunnel hostname. The engine handles OAuth authentication on the HTTP transport.

## MCP Tools

Vault Engine exposes 27 MCP tools:

**Nodes** -- `create-node`, `get-node`, `update-node`, `delete-node`, `rename-node`, `query-nodes`, `validate-node`, `batch-mutate`

**Types** -- `add-type-to-node`, `remove-type-from-node`, `list-types`

**Schemas** -- `create-schema`, `update-schema`, `delete-schema`, `describe-schema`, `list-schemas`

**Global Fields** -- `create-global-field`, `update-global-field`, `delete-global-field`, `rename-global-field`, `describe-global-field`, `list-global-fields`, `list-field-values`, `infer-field-type`

**Content** -- `read-embedded`

**System** -- `vault-stats`, `query-sync-log`

## Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/mcp/` | MCP server and tool definitions |
| `src/db/` | SQLite connection (WAL mode, foreign keys) |
| `src/parser/` | Markdown/YAML frontmatter parser (uses `yaml` directly, not gray-matter) |
| `src/renderer/` | Database to markdown file renderer |
| `src/indexer/` | File to database indexer |
| `src/pipeline/` | Single mutation pipeline |
| `src/schema/` | Schema system and propagation |
| `src/validation/` | Field validation and coercion |
| `src/global-fields/` | Global field pool management |
| `src/resolver/` | Wiki-link and reference resolution |
| `src/sync/` | File watcher, reconciler, normalizer, write lock |
| `src/search/` | Embedding indexer and hybrid search (FTS5 + vector) |
| `src/extraction/` | Content extraction (audio, PDF, images, office docs) |
| `src/auth/` | OAuth authentication |
| `src/transport/` | HTTP and stdio transport layers |

## Testing

```bash
npm test              # run all tests (vitest)
npm run test:watch    # watch mode
npm run test:perf     # performance benchmarks
```

## License

MIT
