# Vault Engine

Database-authoritative knowledge graph engine for markdown vaults, with MCP tools as its primary surface.

## Architecture

The database (SQLite) is the source of truth. Markdown files are a rendered view of database state, not the other way around. Every write flows through a single mutation pipeline: parse → validate → coerce → reconcile → apply → render.

All design decisions flow from the charter: `Vault Engine - Charter.md` (in the archbrain vault).

## Quick Start

```bash
npm install
npm run build
npm run dev              # tsx watch mode
npm run start:http       # HTTP transport
npm test                 # vitest
```

Requires Node.js >= 20.

## MCP Tools

Vault Engine exposes 25 MCP tools:

**Nodes** — `create-node`, `get-node`, `update-node`, `delete-node`, `rename-node`, `query-nodes`, `validate-node`, `batch-mutate`

**Types** — `add-type-to-node`, `remove-type-from-node`, `list-types`

**Schemas** — `create-schema`, `update-schema`, `delete-schema`, `describe-schema`, `list-schemas`

**Global Fields** — `create-global-field`, `update-global-field`, `delete-global-field`, `rename-global-field`, `describe-global-field`, `list-global-fields`, `list-field-values`, `infer-field-type`

**System** — `vault-stats`

## Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/mcp/` | MCP server and tool definitions |
| `src/db/` | SQLite connection (WAL mode, foreign keys) |
| `src/parser/` | Markdown/YAML frontmatter parser (uses `yaml` directly, not gray-matter) |
| `src/renderer/` | Database → markdown file renderer |
| `src/indexer/` | File → database indexer |
| `src/pipeline/` | Single mutation pipeline |
| `src/schema/` | Schema system and validation rules |
| `src/validation/` | Field validation and coercion |
| `src/global-fields/` | Global field pool management |
| `src/resolver/` | Field resolution logic |
| `src/sync/` | File watcher and sync loop |
| `src/auth/` | OAuth authentication |
| `src/transport/` | HTTP/stdio transport layer |

## Deployment

See internal docs for deployment configuration.

## License

MIT
