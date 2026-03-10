# Phase 3: Write Path — Overview & Order of Operations

**Goal:** Agent can create and modify nodes that serialize to clean markdown files, rename nodes with vault-wide reference refactoring, and execute batched mutations atomically.

## Dependency Graph

```
Task 1: Serializer + Path Generation ──► Task 2: File Writer + Write Lock ──┐
                                                                             │
                                                                             ▼
                                                              Task 3: create-node ──┐
                                                                        │           │
                                                                        ▼           │
                                                              Task 4: update-node   │
                                                                   │    │           │
                                                                   │    ▼           │
                                                                   │  Task 5: add-relationship
                                                                   │                │
                                                                   ▼                │
                                                              Task 6: rename-node   │
                                                                        │           │
                                                                        ▼           │
                                                              Task 7: batch-mutate ◄┘
```

## What Phases 1–2 Provide

Phase 3 builds on the complete read-only + schema foundation:

- **Parser pipeline** — `parseFile()` extracts title, types, fields, wiki-links; custom remark plugin produces `wikiLink` AST nodes (critical for rename refactoring)
- **DB schema** — all tables in place: nodes, node_types, fields, relationships, files, schemas
- **Indexer** — `indexFile()`, `deleteFile()`, `rebuildIndex()`, `incrementalIndex()` handle the file-to-DB pipeline
- **File watcher** — watches `.md` files with per-file debounce; write lock mechanism already stubbed (`acquireWriteLock`/`releaseWriteLock`/`isWriteLocked` in `watcher.ts`)
- **Schema system** — YAML loader, inheritance resolution, multi-type field merging, validation (warn, don't reject)
- **Reference resolution** — `resolveReferences(db)` maps wiki-link targets to node IDs; runs after index operations
- **Serialization metadata** — schemas already store `serialization.filename_template` and `serialization.frontmatter_fields` (parsed in Phase 2, used here)
- **MCP tools** — 7 read-only tools; Phase 3 adds 5 mutation tools to the same server

## Order of Operations

### 1. Markdown Serializer + File Path Generation

The foundation of the write path. Everything else depends on being able to produce clean markdown from structured data.

- `serializeNode({ title, types, fields, body }, schema?)` → complete `.md` file string with YAML frontmatter + body
- Frontmatter field ordering controlled by schema's `serialization.frontmatter_fields` array; unrecognized fields appended alphabetically after schema-defined fields
- `title` and `types` always serialized first in frontmatter (meta-keys, same convention as the parser)
- Reference field values wrapped in `[[wiki-link]]` syntax; list values serialized as YAML arrays
- `generateFilePath(title, types, db)` → resolves `filename_template` from the node's schemas (e.g., `"tasks/{{title}}.md"` → `"tasks/Review proposal.md"`); falls back to `"{{title}}.md"` if no schema or no template
- Date interpolation for templates like `"meetings/{{date}}-{{title}}.md"`
- Pure functions, no DB writes, no MCP — testable in complete isolation with fixture data
- API surface: `serializeNode()`, `generateFilePath()`

### 2. File Writer + Write Lock Integration

The glue between serializer output and the filesystem, ensuring the watcher doesn't re-index engine-written files.

- `writeNodeFile(vaultPath, relativePath, content)` → acquires write lock, creates parent directories if needed, writes `.md` file, releases write lock
- Write lock is already checked by the watcher (`isWriteLocked` in `watcher.ts`); this task wires up the acquire/release around actual file writes
- Content hash check as belt-and-suspenders: after writing, the watcher can compare hash to confirm it matches what the engine just wrote (already handled by incremental indexer's hash check)
- Also needs `deleteNodeFile(vaultPath, relativePath)` for delete operations (used by batch-mutate and rename)
- Small task, but critical for correctness — integration-tested against the watcher to prove no re-index loop
- API surface: `writeNodeFile()`, `deleteNodeFile()`

### 3. `create-node` MCP Tool

The first mutation tool. Validates, serializes, writes, and indexes a new node.

- Params: `title` (string), `types` (string[]), `fields` (record), `body?` (string), `parent_path?` (string)
- Pipeline: validate fields against merged schemas (reuse `mergeSchemaFields` + `validateNode` from Phase 2) → serialize via Task 1 → generate file path (or use `parent_path` override) → write via Task 2 → parse + index the written file → resolve references → return the created node
- If file already exists at the generated path, return an error (don't overwrite)
- Validation warnings are returned alongside the created node (warn, don't reject — consistent with Phase 2 design)
- Schema is optional — creating a node with unknown types still works (produces a valid markdown file, just no schema validation)

### 4. `update-node` MCP Tool

Modify an existing node's fields or body content. Read → parse → modify → serialize → write.

- Params: `node_id` (string), `fields?` (record — merge, not replace), `body?` (string — replace body), `append_body?` (string — append to existing body)
- Pipeline: read existing `.md` file from disk → `parseFile()` → merge field updates into existing frontmatter → optionally replace/append body → serialize via Task 1 → write via Task 2 → re-index → resolve references → return updated node
- Field merge semantics: provided fields overwrite existing values; fields not mentioned are preserved; setting a field to `null` removes it
- `body` and `append_body` are mutually exclusive; error if both provided
- Shared write internals with `create-node` (same serializer, same file writer)

### 5. `add-relationship` MCP Tool

Thin wrapper over `update-node`'s write machinery. Separate tool name for agent ergonomics — the agent thinks "link A to B" rather than "update A's fields."

- Params: `source_id` (string), `target` (string — wiki-link title or `[[target]]`), `rel_type` (string)
- For frontmatter relationships (rel_type matches a schema field name): updates the field value to `[[target]]`; for list fields, appends to the array
- For body relationships (rel_type not a schema field, or explicitly body): appends `[[target]]` as a wiki-link in the body
- Normalizes target to `[[target]]` syntax if not already wrapped
- Under the hood, delegates to the same read → parse → modify → serialize → write pipeline as `update-node`

### 6. `rename-node` MCP Tool

The most complex task. Renames a node and updates every reference to it across the entire vault.

- Params: `node_id` (string), `new_title` (string), `new_path?` (string — if omitted, derived from `new_title` via schema's `filename_template`)
- Steps:
  1. Update the source file: change frontmatter `title`, rename/move file to new path
  2. Find all nodes that reference the old title/path (query `relationships` table for matching `target_id` or `resolved_target_id`)
  3. For each referencing file, update references:
     - **Body references**: AST-based transformation — parse with remark, walk `wikiLink` nodes, update `target` field, serialize back with `remark-stringify`. Safe around code blocks, preserves aliases (`[[Old Title|alias]]` → `[[New Title|alias]]`)
     - **Frontmatter references**: parse YAML, regex replace `[[Old Title]]` → `[[New Title]]` in string values
  4. Write all modified files via Task 2 (write lock each), re-index affected files, resolve references
- Depends on Phase 1's `wikiLink` AST nodes — this is why body wiki-links are AST nodes, not regex-extracted text
- Must handle edge cases: old title as substring of another link (`[[Alice]]` vs `[[Alice Cooper]]`), multiple references in one file, self-references

### 7. `batch-mutate` MCP Tool

Orchestrates multiple mutations atomically in one transaction.

- Params: `operations` — array of `{ op: "create" | "update" | "delete" | "link" | "unlink", params: record }`
- Wraps all file writes + DB operations in a single transaction; if any operation fails, all are rolled back (DB changes revert; written files are deleted/restored)
- `delete` operation: removes the `.md` file + calls `deleteFile(db, path)` to clean up DB rows
- `unlink` operation: removes a relationship (inverse of `add-relationship`) — removes `[[target]]` from frontmatter field or body
- File rollback strategy: before writing, snapshot affected files' content; on failure, restore from snapshots
- Depends on all individual tools (Tasks 3–6) being available as internal functions (not just MCP entry points)

## What Phase 3 Does NOT Include

- **Semantic search / vector embeddings** — Phase 4
- **Graph traversal** (`traverse-graph` tool) — Phase 5
- **Block IDs** — Phase 5
- **Workflow tools** (`create-meeting-notes`, `extract-tasks`, `daily-summary`) — Phase 6
- **`remark-stringify` round-trip fidelity** for body content that the engine didn't write. `rename-node` transforms AST nodes and serializes back, but the engine does not guarantee byte-for-byte preservation of hand-written markdown formatting. Semantic content is preserved; whitespace and formatting may shift slightly. This is acceptable because markdown is canonical and all representations are equivalent.
- **Conflict resolution** — if a file is modified externally between read and write, the engine overwrites. External conflict detection is deferred.

## New Files (Expected)

```
src/serializer/
    frontmatter.ts    # Structured fields → YAML frontmatter string
    node-to-file.ts   # Full node data → complete .md file content
    path.ts           # filename_template resolution → vault-relative path
    writer.ts         # File write with write lock acquire/release
    index.ts          # Re-exports
```

Plus additions to existing files:
- `src/mcp/server.ts` — 5 new tools (create-node, update-node, add-relationship, rename-node, batch-mutate)
- `src/sync/watcher.ts` — write lock already stubbed, may need minor adjustments

## Phase 3 Checklist

- [ ] Markdown serializer (structured data → clean `.md` with YAML frontmatter + body)
- [ ] File path generation from schema `filename_template`
- [ ] File writer with write lock integration (no watcher re-index loops)
- [ ] MCP tool: `create-node`
- [ ] MCP tool: `update-node` (field merge + body replace/append)
- [ ] MCP tool: `add-relationship` (frontmatter + body wiki-link writes)
- [ ] MCP tool: `rename-node` (vault-wide AST-based reference refactoring)
- [ ] MCP tool: `batch-mutate` (atomic multi-operation transactions)

## Milestone

"Create a work-task called 'Review vendor proposals' assigned to Bob, due Friday, linked to the CenterPoint project" produces a valid, well-formatted markdown file in the right directory with correct frontmatter. Renaming "Alice" to "Alice Smith" updates every `[[Alice]]` reference across the vault safely. A batch of creates + links executes atomically.
