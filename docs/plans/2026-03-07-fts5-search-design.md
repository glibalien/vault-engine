# FTS5 Search — Design

Phase 1, Task 4. Wire up FTS5 queries against indexed content as a usable search API.

## Context

The DB schema already has:
- `nodes_fts` FTS5 virtual table (content-synced to `nodes.content_text`)
- 3 sync triggers keeping FTS in sync with `nodes` table inserts/updates/deletes
- The indexer populates `content_text` with plain text extracted from markdown

This task adds a search module that wraps FTS5 into a function the MCP tools layer (Task 7) will consume.

## Module Structure

```
src/search/
├── search.ts    # search() function + SQL query construction
├── types.ts     # SearchOptions, SearchResult interfaces
└── index.ts     # re-exports
```

Tests in `tests/search/search.test.ts`.

## Types

```typescript
export interface SearchOptions {
  query: string;        // FTS5 query string (passed directly to MATCH)
  schemaType?: string;  // optional filter: only nodes with this type
  limit?: number;       // max results, default 20
}

export interface SearchResult {
  id: string;
  filePath: string;
  nodeType: string;
  types: string[];
  fields: Record<string, { value: string; type: string }>;
  contentText: string;
  rank: number;         // FTS5 bm25 rank (lower = more relevant)
}
```

- `query` is passed directly to FTS5 MATCH. Supports AND, OR, NOT, phrase queries, prefix queries out of the box.
- `fields` is a flat Record — list fields have JSON string as `value`.
- `rank` uses FTS5's built-in bm25 ranking. Lower = more relevant.

## Function Signature

```typescript
function search(db: Database.Database, options: SearchOptions): SearchResult[]
```

Same pattern as `indexFile` — takes a `Database` instance, no transaction management.

## SQL Strategy

Two-phase query to avoid row multiplication from multi-valued types/fields:

**Phase 1:** FTS match + optional type filter → node IDs + rank

Without type filter:
```sql
SELECT n.id, n.file_path, n.node_type, n.content_text, fts.rank
FROM nodes_fts fts
JOIN nodes n ON n.rowid = fts.rowid
WHERE nodes_fts MATCH ?
ORDER BY fts.rank
LIMIT ?
```

With type filter (adds JOIN on `node_types`):
```sql
SELECT n.id, n.file_path, n.node_type, n.content_text, fts.rank
FROM nodes_fts fts
JOIN nodes n ON n.rowid = fts.rowid
JOIN node_types nt ON nt.node_id = n.id
WHERE nodes_fts MATCH ?
  AND nt.schema_type = ?
ORDER BY fts.rank
LIMIT ?
```

**Phase 2:** Batch-load types and fields for matched nodes using `IN (...)` with placeholders.

**Phase 3:** Group into lookup maps, assemble `SearchResult[]` in rank order.

## Decisions

- **Rich results:** Returns node data + types + fields + rank in one call. No second round-trip needed.
- **FTS + type filter only:** Field filters are a separate concern for the future query builder.
- **New `src/search/` module:** Search is the first read-path module, parallel to `src/sync/` (write-path) and `src/db/` (connection/schema).
- **No snippets/highlights:** Easy to add later, not needed for core search.
- **No query sanitization:** FTS5 handles invalid syntax by throwing. Let errors propagate.

## Test Plan

Integration tests against in-memory SQLite DB (same pattern as indexer tests):

1. Basic match — search for "vendor", expect task file returned with correct fields/types/rank
2. No results — search for nonexistent term, expect empty array
3. Type filter — search term in multiple files, filter by type, expect only matching type
4. Type filter with no matches — filter by type with no matching nodes, expect empty array
5. Limit — index multiple files, search with `limit: 1`, expect exactly 1 result
6. Default limit — verify default is 20
7. Fields populated — verify fields Record has correct keys, values, and types
8. Types populated — verify multi-typed node returns all types
9. Rank ordering — file with term appearing more often ranks higher
10. FTS5 query syntax — phrase query and prefix query work
