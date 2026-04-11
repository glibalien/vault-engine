# Vault Engine

Database-authoritative knowledge graph engine for markdown vaults, with MCP tools as its primary surface.

## Charter

All design decisions flow from the charter: `Vault Engine - Charter.md` (in the archbrain vault).

## Quick Start

```bash
npm install
npm run build
npm start -- --transport http
```

## Architecture

The database is the source of truth. Markdown files are a rendered view of database state. See the charter for details.
