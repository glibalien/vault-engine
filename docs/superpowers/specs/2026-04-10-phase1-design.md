# Phase 1 Design — Core Data Model and Read Path

**Date:** 2026-04-10
**Status:** Approved
**Charter reference:** ~/Documents/archbrain/Notes/Vault Engine - Charter.md

## Overview

Phase 1 delivers an indexed, queryable vault (read-only). The engine can parse every markdown file in the vault, populate a SQLite database, detect file changes via watcher, and answer structured queries through MCP tools. Nothing writes back to files in Phase 1.

### Configuration

- Vault path: `VAULT_PATH` environment variable (required)
- DB path: `DB_PATH` env var or default `<vault>/.vault-engine/vault.db`
- All other config via existing env vars (`OAUTH_OWNER_PASSWORD`, `OAUTH_ISSUER_URL`)

### Key Design Decisions

- **Schemas are DB-first.** The `schemas` table is canonical at runtime. `.schemas/*.yaml` files are a future rendered view (Phase 3+), not a source of truth. No `.schemas/` directory or schema watcher in Phase 1.
- **Stable node IDs.** Nodes use nanoid as the primary key, not vault-relative paths. `file_path` is a UNIQUE indexed column. Renames in Phase 3 become a single UPDATE.
- **Query-time reference resolution.** Relationships store raw target strings. Resolution to node IDs happens at query time via JOIN, not via a resolution pass. Simpler, fast enough at 7k nodes. Revisit for a `resolved_target_id` column if query latency demands it.
- **Indexing and mutation pipeline are separate code paths.** The indexer reads files and mirrors state into the DB (file → DB). The mutation pipeline (Phase 3) mediates agent writes that flow out to files (DB → file). They share infrastructure (parser, DB schema, potentially reference resolution) but are not entangled.
- **Pipeline state is in-memory.** Transient state (proposed mutations, validation results) lives in function call chains. No DB tables for pipeline state.

---

## Section 1: SQLite Schema

All tables created in a single `createSchema(db)` call. No migration framework.

### nodes

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | nanoid, stable across renames |
| file_path | TEXT UNIQUE NOT NULL | vault-relative path (e.g., `Notes/Some Meeting.md`) |
| title | TEXT | from frontmatter, H1, or filename |
| body | TEXT | markdown body without frontmatter |
| content_hash | TEXT | SHA-256 of raw file bytes |
| file_mtime | INTEGER | epoch ms |
| indexed_at | INTEGER | epoch ms |

### node_types

| Column | Type | Notes |
|--------|------|-------|
| node_id | TEXT NOT NULL | FK → nodes.id CASCADE |
| schema_type | TEXT NOT NULL | type name string |

- PK: `(node_id, schema_type)`
- Index on `schema_type`

### global_fields

| Column | Type | Notes |
|--------|------|-------|
| name | TEXT PK | field name |
| field_type | TEXT NOT NULL | string, number, date, boolean, reference, enum, list |
| enum_values | TEXT | JSON array, nullable |
| reference_target | TEXT | nullable |
| description | TEXT | nullable |
| default_value | TEXT | JSON, nullable |

Empty in Phase 1.

### schemas

| Column | Type | Notes |
|--------|------|-------|
| name | TEXT PK | type name |
| display_name | TEXT | human-readable name |
| icon | TEXT | nullable |
| filename_template | TEXT | nullable |
| field_claims | TEXT NOT NULL | JSON array of `{field, required, label, default_override}` |
| metadata | TEXT | JSON, nullable |

Empty in Phase 1.

### node_fields

| Column | Type | Notes |
|--------|------|-------|
| node_id | TEXT NOT NULL | FK → nodes.id CASCADE |
| field_name | TEXT NOT NULL | field key from frontmatter |
| value_text | TEXT | populated for string values |
| value_number | REAL | populated for numeric values |
| value_date | TEXT | ISO 8601 string for date values |
| value_json | TEXT | JSON for booleans, arrays, objects, null |
| source | TEXT NOT NULL DEFAULT 'frontmatter' | 'frontmatter' or 'orphan' (orphan starts mattering in Phase 2) |

- PK: `(node_id, field_name)`
- Index on `field_name`
- Index on `value_number`
- Index on `value_date`

### relationships

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| source_id | TEXT NOT NULL | FK → nodes.id CASCADE |
| target | TEXT NOT NULL | raw target string as written in the file |
| rel_type | TEXT NOT NULL | field name or `'wiki-link'` |
| context | TEXT | surrounding text (body links) or field name (frontmatter links) |

- UNIQUE: `(source_id, target, rel_type)`
- Index on `source_id`
- Index on `target`
- Index on `rel_type`

No FK on `target` — target node may not exist (dangling links are valid).

### edits_log

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| node_id | TEXT | nullable (some events are vault-level) |
| timestamp | INTEGER NOT NULL | epoch ms |
| event_type | TEXT NOT NULL | e.g., `file-indexed`, `file-deleted`, `reconciler-sweep` |
| details | TEXT | JSON |

Actively written from Phase 1 for indexer/watcher debug visibility.

### embeddings

| Column | Type | Notes |
|--------|------|-------|
| node_id | TEXT PK | FK → nodes.id CASCADE |
| content_text | TEXT | text sent to embedding model |
| embedded_at | INTEGER | nullable, epoch ms |

Stub table. No vectors in Phase 1; exists for Phase 4.

### nodes_fts

FTS5 contentless virtual table mirroring `title` + `body` from `nodes`. Kept in sync during indexer insert/delete/update operations via explicit calls (not triggers, since contentless FTS5 requires manual sync).

---

## Section 2: Parser

### Interface

```typescript
type YamlValue = string | number | boolean | Date | null | YamlValue[] | Record<string, YamlValue>;

interface WikiLink {
  target: string;      // canonical link target
  alias: string | null; // display text if aliased
  context: string;      // surrounding text (body) or field name (frontmatter)
}

interface ParsedNode {
  title: string | null;
  types: string[];
  fields: Map<string, YamlValue>;
  body: string;
  wikiLinks: WikiLink[];
  parseError: string | null;
}
```

### Implementation

- **Remark pipeline:** `unified` + `remark-parse` + `remark-frontmatter` + `remark-gfm` + custom wiki-link plugin
- **Frontmatter:** `yaml` package (not gray-matter). Parses YAML and preserves native JS types (string, number, boolean, Date, arrays, objects, null). The pipeline's coercion step (Phase 2+) decides how to map these into schema-typed values.
- **Dependencies to add:** `remark-gfm`, `nanoid`

### Wiki-link extraction: two code paths

**Body wiki-links (AST plugin):** Custom remark plugin walks the AST, matches `[[target]]` and `[[target|alias]]` patterns. Emits `WikiLink` objects with surrounding paragraph text as `context`. Links inside fenced code blocks are NOT extracted.

**Frontmatter wiki-links (regex on YAML string values):** After the `yaml` package returns parsed values, regex (`/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g`) extracts wiki-links from string values. For `[[Alice|our contact]]`: the field value is stored as `"Alice"` (canonical target), the alias `"our contact"` is preserved in the relationship's `context` field alongside the field name.

These are separate functions, never conflated.

### Title resolution

1. Explicit `title` in frontmatter (wins)
2. First H1 in body
3. Derived from filename (strip `.md`)

### Error handling

Malformed YAML frontmatter: parser returns a `ParsedNode` with `types: []`, empty fields map, entire file content as body, `parseError` set to the error message. The indexer logs a warning to `edits_log` and indexes what it can. One bad file never crashes the vault scan.

---

## Section 3: Indexer

### Two modes

**`fullIndex(vaultPath, db)`** — full vault scan. Three phases:
1. Glob all `.md` files on disk
2. Query DB for all known `file_path` values; delete nodes whose `file_path` is not in the filesystem set (cascade handles fields/types/relationships); log `file-deleted` events
3. Index new/changed files using mtime-then-hash change detection

Processes files in batches of ~100, one transaction per batch. Per-file errors are caught, logged to `edits_log`, and skipped. One bad file never blocks the scan.

**`indexFile(filePath, vaultPath, db)`** — single file, used by the watcher. Deletes existing rows for that node (cascade), re-inserts from fresh parse. Own transaction.

### Change detection

Mtime-first, hash-second:
1. If `file_mtime` matches DB → skip
2. If mtime changed, read file, compute SHA-256
3. If hash matches DB → update mtime only, skip re-parse
4. If hash differs → full re-index of that file

### Node ID

`nanoid` generated on first index of a file. Stored as `nodes.id`. All FKs reference this stable ID. On re-index of an existing file, the ID is preserved (looked up by `file_path`).

### Field storage

Parser returns `Map<string, YamlValue>`. Indexer writes each entry to `node_fields`, populating the typed column based on JS runtime type:

| JS type | Column |
|---------|--------|
| `string` | `value_text` |
| `number` | `value_number` |
| `Date` | `value_date` (ISO 8601) |
| `boolean`, `array`, `object`, `null` | `value_json` |

### Relationship storage

Parser's `WikiLink[]` written to `relationships` with raw `target` string. No resolution pass — resolution happens at query time.

- Body wiki-links: `rel_type = 'wiki-link'`
- Frontmatter references: `rel_type = field_name`

### Ignore list (hardcoded, Phase 1)

- `.vault-engine/`
- `.schemas/`
- `.git/`
- `.obsidian/`
- `.trash/`
- `node_modules/`
- Any path segment starting with `.` (hidden files/dirs)
- `*.sync-conflict-*` files
- Non-`.md` files

Noted as future config option.

### Edits log

Writes `file-indexed`, `file-deleted`, `reconciler-sweep` events during indexing.

---

## Section 4: MCP Tools

Eight read-only tools. All return structured JSON in MCP `text` content blocks.

### Error codes (shared across all tools)

- `NOT_FOUND` — requested entity doesn't exist
- `INVALID_PARAMS` — bad/missing parameters
- `AMBIGUOUS_MATCH` — title lookup matched multiple nodes (returns candidates)
- `INTERNAL_ERROR` — unexpected failure

### vault-stats

Replaces Phase 0 stub. Returns:
- `node_count`, `type_counts` (from `node_types`), `field_count` (distinct field names), `relationship_count`, `orphan_count` (computed from `node_fields WHERE source = 'orphan'`), `schema_count` (from `schemas` table)

### list-types

`SELECT schema_type, COUNT(*) FROM node_types GROUP BY schema_type ORDER BY schema_type`

Response: `Array<{type: string, count: number}>`

### query-nodes

Parameters:
- `types` (string[], optional) — filter by type membership via `node_types`
- `fields` (object, optional) — `{field_name: {eq?, gt?, lt?, gte?, lte?, contains?, exists?}}`
- `full_text` (string, optional) — FTS5 search against `nodes_fts`
- `references` (object, optional) — `{target: string, rel_type?: string, direction?: 'outgoing' | 'incoming' | 'both'}`, default direction `'outgoing'`
- `path_prefix` (string, optional) — filter by vault path prefix
- `modified_since` (ISO date, optional) — filter by `file_mtime`
- `sort_by` (string, optional) — field name or `title`, `file_mtime`, `indexed_at`
- `sort_order` (`asc` | `desc`, default `asc`)
- `limit` (number, default 50, max 200)
- `offset` (number, default 0)

Returns: `{nodes: Array<{id, file_path, title, types, field_count}>, total: number}`

`total` reflects the filtered count, not the vault total.

**Field filter column routing:** Numeric value or `gt/lt/gte/lte` operator → `value_number`. ISO date string (matches `YYYY-MM-DD`) → `value_date`. Everything else → `value_text`. `contains` always on `value_text`. `exists` checks for row existence.

SQL built dynamically with parameterized queries (no injection).

### get-node

Parameters (three distinct optional params, exactly one required):
- `node_id` (string)
- `file_path` (string)
- `title` (string) — uses four-tier resolution

Returns `INVALID_PARAMS` if zero or multiple params provided. Returns `AMBIGUOUS_MATCH` with candidates if title matches multiple nodes.

Response shape:
```typescript
{
  id: string;
  file_path: string;
  title: string | null;
  types: string[];
  fields: Record<string, { value: any, type: string, source: string }>;
  relationships: {
    outgoing: { [rel_type: string]: Array<{target_id: string, target_title: string | null, context?: string}> };
    incoming: { [rel_type: string]: Array<{source_id: string, source_title: string | null, context?: string}> };
  };
  body: string;
  file_mtime: number;
  indexed_at: number;
  content_hash: string;
}
```

### Target resolution (four tiers, shared with reference query-time resolution)

1. Exact match on `file_path`
2. Exact match on basename (strip directory and `.md`)
3. Case-insensitive basename match
4. Unicode NFC-normalized case-insensitive basename match
5. Ambiguity (multiple matches at any tier) → shortest `file_path` wins (Obsidian convention)

### list-schemas / describe-schema

Read from `schemas` table. Return empty array / `NOT_FOUND` in Phase 1. Documented: "vault may have no formal schemas defined yet."

### list-global-fields / describe-global-field

Read from `global_fields` table. Return empty array / `NOT_FOUND` in Phase 1.

---

## Section 5: File Watcher and Reconciler

### File Watcher

Uses `chokidar` watching the vault directory for `.md` file changes.

- Events: `add`, `change`, `unlink`
- Ignore list: same as indexer (Section 3)
- **Debounce:** 500ms idle per file with 5-second max wait. Both injectable for testing. Coalesces Obsidian auto-save bursts; max-wait guarantees indexing within 5s during continuous editing.
- On debounce fire: read file, check hash against DB — if unchanged, skip; if changed, call `indexFile`.
- `unlink` event: delete the node (cascade), log `file-deleted` to `edits_log`.
- Watcher does NOT write back to files in Phase 1.

### Reconciler

Literally `fullIndex` on a timer. Same function, same code path. Logs `reconciler-sweep` to `edits_log` with summary (files indexed, deleted, unchanged).

- First tick: 2 minutes after startup
- Subsequent ticks: every 15 minutes
- Both configurable
- Primary value: recovery from inotify exhaustion, bootstrap consistency, bulk external operations (git checkout, rsync, Obsidian Sync)

### Mutex

In-process lock ensuring one indexing operation at a time:
- Deduped by file path: `Map<string, PendingEvent>`, new events overwrite previous for same path
- Queue drains after current operation completes; new events during drain append to the same queue (no recursive cycles)
- Mutex is per-operation (not per-file) — noted as optimization target for later
- Exposes `onIdle(): Promise<void>` that resolves when queue is fully drained (used by tests)

### Write Lock (scaffolding for Phase 3)

```typescript
withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T>  // try/finally guarantees unlock
isLocked(filePath: string): boolean  // watcher checks this before processing
```

No raw `lock()`/`unlock()` exposed. In Phase 1 nothing calls `withLock`; the watcher checks `isLocked` (always false). Tested and ready for Phase 3.

### Startup Sequence

1. Open database → failure aborts process
2. `createSchema(db)` → failure aborts process
3. `fullIndex(vaultPath, db)` → per-file errors logged and skipped; systemic failure (can't read vault dir) aborts process
4. Start watcher → failure aborts
5. Schedule first reconciler tick (2 minutes) → failure aborts
6. Start MCP server (stdio and/or HTTP based on args)

MCP server blocks until initial `fullIndex` completes. Noted as UX concern: if cold start exceeds 60 seconds in practice, revisit to serve partial results during indexing.

---

## Section 6: Testing Strategy

### Test infrastructure

- **vitest** as test runner
- **Fixture vault:** `tests/fixtures/vault/` checked into the repo
- **In-memory SQLite** for most tests (fast)
- **File-based SQLite in temp dir** for watcher/reconciler tests (catches write-path bugs)
- **Injectable timers:** debounce duration, max-wait, reconciler interval — tests use fast values (50ms debounce, 200ms max-wait)
- **`onIdle()` promise:** tests await indexer idle instead of `setTimeout`

### What is real vs. stubbed

**Always real (never mock):** SQLite, the remark parser pipeline, the filesystem (real temp dirs), chokidar (in watcher tests)

**Acceptable to stub:** MCP transport layer (tests call tool handler functions directly), the clock (injectable timers)

### Fixture vault

`tests/fixtures/vault/` with deliberately chosen files:

| File | Tests |
|------|-------|
| `plain-no-frontmatter.md` | no-YAML edge case |
| `multi-type.md` | `types: [meeting, note]` with fields |
| `frontmatter-wikilinks.md` | `project: "[[Vault Engine]]"`, `people: ["[[Alice]]", "[[Bob]]"]` |
| `body-wikilinks.md` | inline `[[links]]` and `[[aliased\|display text]]` |
| `code-block-links.md` | `[[links]]` inside fenced code (must NOT be extracted) |
| `malformed-yaml.md` | broken frontmatter |
| `gfm-tables.md` | GFM table with wiki-links in cells |
| `unicode-title.md` | accented characters, CJK |
| `alias-wikilink.md` | `[[Alice Smith\|our contact]]` in frontmatter |
| `nested/deep/path/note.md` | deeply nested path |
| `references-target.md` | target that other fixtures link to |
| `dangling-reference.md` | links to `[[Nonexistent Note]]` |
| `empty-frontmatter.md` | `---\n---\n` with body |

### Test suites

**Parser unit tests:** Parse each fixture, assert `ParsedNode` structure. Test: types extracted, fields preserve native JS types, body separated from frontmatter, body wiki-links via AST, frontmatter wiki-links via regex, code block links excluded, malformed YAML returns `parseError`, GFM content parsed correctly.

**Schema unit tests:** Verify all tables exist with correct columns and indexes. Verify CASCADE behavior (delete node → fields/types/relationships gone). Verify FTS5 virtual table.

**Indexer unit tests:** Index fixture vault into temp DB. Verify: stable nanoid IDs, fields in correct typed columns, types in `node_types`, relationships with raw target strings, mtime/hash change detection skips unchanged files, deletion detection removes stale nodes, batch error handling, `edits_log` entries written.

**MCP tool unit tests:** Pre-populated DB, call tool handlers directly. Verify: `query-nodes` field filtering routes to correct columns, FTS5 search, reference filtering with query-time resolution, pagination, sort orders. `get-node` four-tier title resolution, `AMBIGUOUS_MATCH` error. Empty results from schema/global-field tools. `list-types` returns `{type, count}` pairs.

**Write lock unit tests:** `withLock` guarantees unlock on success and exception. `isLocked` reflects state.

**Watcher/reconciler integration tests:** File-based SQLite + real temp vault + chokidar with 50ms debounce. Create/modify/delete files, `await onIdle()`, verify DB state. Verify mutex prevents concurrent indexing. Verify path deduplication.

**End-to-end integration test:** Create temp vault from fixtures → `fullIndex` → call `query-nodes` handler → verify results → write new `.md` file → `await onIdle()` → `query-nodes` again → verify new node appears with correct fields and relationships.

**Performance smoke test:** `tests/perf/full-index.test.ts`, excluded from default suite (`npm run test:perf`). Indexes real vault (or 7k-file synthetic) and asserts cold-start `fullIndex` < 60 seconds.

---

## Dependencies to Add

- `remark-gfm` — GFM support in parser
- `nanoid` — stable node IDs

---

## What Phase 1 Does NOT Include

- Schema validation or coercion (Phase 2)
- Write-back to markdown files (Phase 3)
- `.schemas/` directory or YAML rendering (Phase 3+)
- Schema inference (`infer-schemas` tool)
- Semantic search / embeddings (Phase 4)
- Any mutation MCP tools
