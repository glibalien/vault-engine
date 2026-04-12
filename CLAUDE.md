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

- Runs on archalien under systemd as `vault-engine-new.service`
- Port **3334** (old service on 3333)
- Cloudflare tunnel: `vault-new.archalien.me` → localhost:3334
- Config: `/etc/cloudflared/config.yml`
- Env vars loaded via systemd `EnvironmentFile=/home/barry/projects/vault-engine/.env`
- Required env: `OAUTH_OWNER_PASSWORD`, `OAUTH_ISSUER_URL`

## Conventions

- `.vault-engine/` directory holds SQLite DB, WAL, and engine cache/logs. Excluded from file watcher.
- DB path default: `<vault>/.vault-engine/vault.db` (production uses `vault-new.db` during Phase 0)
- `db/connection.ts` opens the DB with WAL mode and foreign keys enabled.
- ESM throughout (`"type": "module"` in package.json, `.js` extensions in imports)
- **YAML `nullStr: ''`** in render options — null values serialize as bare `key:` not `key: null`. This is critical for Obsidian compatibility: `types: []` (flow notation) mangles when Obsidian adds items; implicit null `types:` does not.
- **Watcher cosmetic-skip**: the watcher does NOT rewrite a file if the only change would be adding a filename-derived title. This prevents clobbering Obsidian mid-edit. See `processFileChange` in `src/sync/watcher.ts`.

## Phased delivery

- **Phase 0**: empty project, working OAuth + MCP transport, `vault-stats` stub ✓
- **Phase 1**: SQLite schema, parser, indexer, read-only MCP tools, watcher ✓
- **Phase 2**: global field pool, schema system, validation ✓
- **Phase 3**: write path, renderer, full sync loop — minimum shippable product ✓
- **Phase 4–7**: semantic search, field reconciliation, content extraction, workflow tools
