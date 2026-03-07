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
  ├── parseMarkdown(raw)         → MDAST (unified/remark + remarkFrontmatter)
  ├── parseFrontmatter(raw)      → { data, content, types, fields, wikiLinks }  (gray-matter)
  ├── extractWikiLinksFromMdast() → body wiki-links from MDAST text nodes
  └── extractPlainText()         → plain text for FTS (strips wiki-link brackets)
```

- **`types.ts`** — Shared interfaces: `ParsedFile`, `WikiLink`, `FieldEntry`
- **`markdown.ts`** — unified pipeline (remarkParse + remarkFrontmatter). Full file goes through remark so MDAST positions are correct relative to source.
- **`frontmatter.ts`** — gray-matter wrapper. Infers field types (reference/list/date/number/boolean/string). Extracts wiki-links from frontmatter YAML values.
- **`wiki-links.ts`** — Single regex `\[\[([^\]|]+)(?:\|([^\]]+))?\]\]` used for both frontmatter and body extraction. No third-party wiki-link plugin.
- **`index.ts`** — `parseFile()` orchestrator, re-exports types.

### Key Design Decisions

- **Markdown is canonical.** DB is always rebuildable from files. Structure lives in frontmatter + wiki-links.
- **Multi-typed nodes.** Files declare `types: [meeting, task]` in frontmatter. Types are additive.
- **Wiki-links are relationships.** `[[target]]` and `[[target|alias]]` in frontmatter fields become typed relationships; in body they become contextual links.
- **`title` and `types` are meta-keys** excluded from `fields` array — they're handled separately.
- **gray-matter auto-converts dates** to `Date` objects. `inferType` checks `instanceof Date`.
- **`Position` type** comes from `unist`, not `mdast`.

### Planned Modules (not yet implemented)

- `src/db/` — SQLite (better-sqlite3) with WAL mode, FTS5
- `src/schema/` — YAML schema loader with inheritance
- `src/sync/` — chokidar file watcher + incremental indexer
- `src/mcp/` — MCP server with query/read/mutate tools

## Testing

Tests use vitest. Test files live in `tests/` mirroring `src/` structure. Fixtures are in `tests/fixtures/` (sample markdown files with frontmatter). Tests run against fixture files using `readFileSync` with `import.meta.dirname` for path resolution.
