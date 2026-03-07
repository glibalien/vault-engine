# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

vault-engine is a local-first, MCP-native knowledge graph engine that indexes markdown vaults into SQLite for structured querying. Markdown files are canonical — the database is a derived, rebuildable index. The agent (via MCP tools) is the primary interface; editors are viewports.

See `vault-engine-architecture.md` for the full architecture and `docs/phase-1-overview.md` for current implementation status.

## Commands

```bash
npm test              # run all tests (vitest)
npm run test:watch    # run tests in watch mode
npx vitest run tests/parser/wiki-links.test.ts  # run a single test file
npm run build         # compile TypeScript (tsc)
npx tsc --noEmit      # type-check without emitting
npm run dev           # run with tsx watch (hot reload)
```

## Architecture

**ESM TypeScript project** — `"type": "module"` with Node16 module resolution. All internal imports use `.js` extensions (e.g., `import { foo } from './bar.js'`).

### Parser Pipeline (`src/parser/`)

The core data flow: raw `.md` file → `ParsedFile` object.

```
parseFile(filePath, raw)
  ├── parseMarkdown(raw)         → MDAST with wikiLink nodes (unified/remark + remarkFrontmatter + remarkWikiLink)
  ├── parseFrontmatter(raw)      → { data, content, types, fields, wikiLinks }  (gray-matter + regex)
  ├── extractWikiLinksFromMdast() → body wiki-links from wikiLink AST nodes
  └── extractPlainText()         → plain text for FTS (reads wikiLink node target/alias)
```

- **`types.ts`** — Shared interfaces: `ParsedFile`, `WikiLink`, `WikiLinkNode`, `FieldEntry`. Module augmentation registers `WikiLinkNode` as mdast phrasing content.
- **`remark-wiki-link.ts`** — Custom remark transform plugin. Splits `[[target]]` and `[[target|alias]]` in text nodes into first-class `wikiLink` AST nodes. Runs after remarkParse + remarkFrontmatter.
- **`markdown.ts`** — unified pipeline (remarkParse + remarkFrontmatter + remarkWikiLink). `parseMarkdown` calls `runSync` to execute transforms. `extractPlainText` handles `wikiLink` nodes directly.
- **`frontmatter.ts`** — gray-matter wrapper. Infers field types (reference/list/date/number/boolean/string). Extracts wiki-links from frontmatter YAML values via regex.
- **`wiki-links.ts`** — `extractWikiLinksFromMdast` walks `wikiLink` AST nodes (not regex on text). `extractWikiLinksFromString` provides regex extraction for frontmatter values.
- **`index.ts`** — `parseFile()` orchestrator, re-exports types.

### Key Design Decisions

- **Markdown is canonical.** DB is always rebuildable from files. Structure lives in frontmatter + wiki-links.
- **Multi-typed nodes.** Files declare `types: [meeting, task]` in frontmatter. Types are additive.
- **Wiki-links are relationships.** `[[target]]` and `[[target|alias]]` in frontmatter fields become typed relationships; in body they become contextual links.
- **`title` and `types` are meta-keys** excluded from `fields` array — they're handled separately.
- **gray-matter auto-converts dates** to `Date` objects. `inferType` checks `instanceof Date`.
- **`Position` type** comes from `unist`, not `mdast`.

### DB Layer (`src/db/`)

Database connection and schema management.

- **`connection.ts`** — `openDatabase(dbPath)` factory. Configures WAL mode, foreign keys, busy timeout. Creates parent directories for file-based DBs.
- **`schema.ts`** — `createSchema(db)` runs idempotent DDL: 7 tables (nodes, node_types, nodes_fts, fields, relationships, schemas, files), 9 indices, 3 FTS5 sync triggers. No migration tracking — DB is rebuildable.
- **`index.ts`** — Re-exports `openDatabase` and `createSchema`.

### Sync Layer (`src/sync/`)

File-to-database indexing pipeline.

- **`indexer.ts`** — `indexFile(db, parsed, relativePath, mtime, raw)` writes one parsed file into all DB tables (nodes, node_types, fields, relationships, files). Uses delete-then-insert for child tables. Does not manage transactions. `rebuildIndex(db, vaultPath)` scans all `.md` files, clears the DB, and indexes everything in one transaction.
- **`index.ts`** — Re-exports `indexFile` and `rebuildIndex`.

### Search Layer (`src/search/`)

Full-text search over indexed content.

- **`types.ts`** — `SearchOptions` (query, schemaType, limit) and `SearchResult` (id, filePath, nodeType, types, fields, contentText, rank).
- **`search.ts`** — `search(db, options)` queries FTS5 with optional type filtering. Two-phase SQL: FTS5 MATCH for ranked node IDs, then batch-loads types and fields. Returns `SearchResult[]` ordered by bm25 rank.
- **`index.ts`** — Re-exports `search`, `SearchOptions`, `SearchResult`.

### Planned Modules (not yet implemented)

- `src/schema/` — YAML schema loader with inheritance
- `src/mcp/` — MCP server with query/read/mutate tools

## Testing

Tests use vitest. Test files live in `tests/` mirroring `src/` structure. Fixtures are in `tests/fixtures/` (sample markdown files with frontmatter). Tests run against fixture files using `readFileSync` with `import.meta.dirname` for path resolution.
