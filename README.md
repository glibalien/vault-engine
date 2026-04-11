# Vault Engine

Database-authoritative knowledge graph engine for markdown vaults, with MCP tools as its primary surface.

## Charter

All design decisions flow from the charter: [`~/Documents/archbrain/Notes/Vault Engine - Charter.md`](../Documents/archbrain/Notes/Vault%20Engine%20-%20Charter.md)

## Quick Start

```bash
npm install
npm run build
npm start -- --transport http
```

## Architecture

The database is the source of truth. Markdown files are a rendered view of database state. See the charter for details.
