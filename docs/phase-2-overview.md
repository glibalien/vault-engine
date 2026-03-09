# Phase 2: Schema System + Multi-Typing — Overview & Order of Operations

**Goal:** YAML-driven schema definitions with inheritance, multi-type field merging, validation on index, reference resolution, and schema introspection MCP tools.

## Dependency Graph

```
Task 1: Schema Types + YAML Loader ──► Task 2: Multi-type Field Merging ──┐
         │                                                                 │
         │                                                                 ▼
         │                                              Task 3: Schema Validation on Index
         │                                                         │
         └────────────────────────┬────────────────────────────────┤
                                  │                                ▼
Task 4: Reference Resolution ────┴──────────► Task 5: Schema Introspection MCP Tools
       (parallel track)          │              (list-schemas, describe-schema, validate-node)
                                 │
                                 └──────────► Task 6: Computed Fields
                                                (count, percentage aggregations)
```

## What Phase 1 Provides

Phase 2 builds on the complete Phase 1 read-only foundation:

- **Parser pipeline** — `parseFile()` already extracts `types` array, fields, and wiki-links from frontmatter
- **DB schema** — `schemas` table exists (empty, no loader yet); `node_types` tracks multi-types; `fields` stores typed key-value pairs; `relationships` stores wiki-links with `target_id` as raw link target (not resolved to node ID)
- **Indexer** — `rebuildIndex()` and `incrementalIndex()` handle file-to-DB pipeline
- **MCP tools** — `list-types`, `get-node`, `query-nodes`, `get-recent` already serve read queries
- **File watcher** — watches `.md` files, triggers per-file indexing

## Order of Operations

### 1. Schema Types + YAML Schema Loader

The foundation of Phase 2. Everything else depends on knowing what schemas exist and what fields they define.

- Define TypeScript types: `SchemaDefinition`, `FieldDefinition`, `ResolvedSchema` (with inherited fields merged)
- Read `.schemas/*.yaml` files from vault root (configurable path)
- Parse YAML into typed schema objects
- Resolve `extends` inheritance chains (e.g., `work-task` extends `task` → work-task gets all task fields plus its own)
- Handle deep inheritance (A extends B extends C) via topological resolution
- Detect cycles and error
- Store resolved schemas in the `schemas` table as JSON
- API surface: `loadSchemas(db, vaultPath)`, `getSchema(db, name)`, `getResolvedSchema(db, name)`

Key design decisions to resolve:
- Where do default/built-in schemas live? (`schemas/` directory shipped with engine vs `.schemas/` in vault)
- Schema reload strategy: full reload on any `.schemas/*.yaml` change, or incremental?
- Should the watcher also watch `.schemas/` for live schema changes? If so, a schema change triggers a full schema reload but does **not** re-validate existing nodes — nodes get re-validated only on their next individual re-index. Full vault re-validation on schema change is expensive and unnecessary for a warn-don't-reject system.

### 2. Multi-type Field Merging

A node with `types: [meeting, task]` needs fields from both schemas merged into a single field set for validation and introspection.

- Given a list of type names, load resolved schemas and merge their field definitions
- Compatible fields (same name, same type) → shared, no warning
- Incompatible fields (same name, different type) → warn, keep both definitions
- Enum fields with same name → union the value sets (per architecture doc open question)
- API surface: `mergeSchemaFields(db, types: string[])` → `{ fields: MergedFieldMap, warnings: string[] }`

Depends on: Task 1.

### 3. Schema Validation on Index

Validate frontmatter fields against merged schema definitions during indexing. **Warn, don't reject** — files that violate schema are still valid markdown and still get indexed.

- Check: required fields present
- Check: field types match schema definition (string where string expected, etc.)
- Check: enum values are valid members of the defined set
- Check: reference fields point to wiki-link values (syntactically valid `[[target]]`)
- Return structured validation results: `{ valid: boolean, warnings: ValidationWarning[] }`
- Integration: call validation in `indexFile()` after parsing, store/log warnings
- Consider: `is_valid` flag on nodes table, or separate validation results table

Depends on: Tasks 1, 2.

### 4. Reference Resolution

Currently `relationships.target_id` stores raw wiki-link target strings (e.g., `Alice Smith`). Resolution maps these to actual node IDs (vault-relative file paths like `people/Alice Smith.md`).

- Build a title → node_id lookup table (title from frontmatter `title` field or filename stem)
- Resolve during indexing: after all nodes are inserted, resolve `target_id` values
- Handle ambiguity: multiple nodes with same title → shortest unique path match (Obsidian convention)
- Case-insensitive matching
- Dangling references remain valid — target node might not exist yet
- Re-resolve on incremental index: full pass over all unresolved refs, not just refs in changed files. A newly added `Alice Smith.md` should resolve dangling `[[Alice Smith]]` refs in any existing node's relationships. Full-pass cost is acceptable — it's a single indexed query over the relationships table filtered to unresolved targets, not a file scan.
- API surface: `resolveReferences(db)`, `resolveTarget(db, wikiLinkTarget)` → `nodeId | null`

This is an independent track — depends on Phase 1 DB/indexer, not on the schema loader. Can be developed in parallel with Tasks 2–3.

### 5. Schema Introspection MCP Tools

Thin wrappers over the schema loader, field merging, and validation. Three new tools added to the MCP server:

- **`list-schemas`** — Returns all loaded schema definitions with field counts, inheritance info. Distinct from existing `list-types`: `list-types` shows types that nodes actually have (from indexed data), `list-schemas` shows what's defined (from YAML). These can diverge — a schema can exist with no nodes using it, and nodes can have types with no schema definition. The agent should use `list-types` to see what's in the vault and `list-schemas` to see what structure is available.
- **`describe-schema`** — Returns full schema definition including inherited fields, field types, constraints, defaults. Resolves inheritance so the agent sees the complete field set.
- **`validate-node`** — Validates a specific node (by ID) against its schemas, or validates hypothetical data (`{ types, fields }`) without a real node. Returns validation warnings.

Depends on: Tasks 1–4 (needs loader for list/describe, needs validation for validate-node, benefits from reference resolution for richer validation).

### 6. Computed Fields

Schema YAML defines `computed:` blocks with simple query expressions (see architecture doc's `project.yaml` example: `task_count`, `completion_pct`). Phase 2 implements evaluation for basic aggregations.

- Parse `computed:` definitions from schema YAML (handled by Task 1 loader)
- Evaluate count and percentage aggregations against the DB
- Queries reference relationships and field values (e.g., "count nodes where types includes task and source references this")
- Results returned on demand (not stored) — computed at query time via `get-node` and `describe-schema`
- API surface: `evaluateComputed(db, nodeId, computedDef)` → value
- Scope limited to: `COUNT`, `COUNT(condition) / COUNT(*)` patterns. Complex expressions deferred.

Depends on: Tasks 1, 4 (needs schemas loaded and references resolved to evaluate relationship-based queries).

## What Phase 2 Does NOT Include

- **Write path** — No file creation/mutation (Phase 3)
- **Complex computed field expressions** — Only `COUNT` and `COUNT(condition) / COUNT(*)` percentage patterns are supported; arbitrary query expressions deferred.
- **Schema enforcement** — Validation warns, never rejects. No gating on index.
- **Schema migration** — Existing files aren't modified when schemas change. Missing fields get warnings.
- **`filename_template` / `serialization`** — Parsed and stored in schema, but not used until Phase 3 write path.

## New Files (Expected)

```
src/schema/
    types.ts          # TypeScript types: SchemaDefinition, FieldDefinition, ResolvedSchema
    loader.ts         # YAML file reading, parsing, inheritance resolution, DB storage
    merger.ts         # Multi-type field merging logic
    validator.ts      # Schema validation against parsed file data
    index.ts          # Re-exports
```

Plus additions to existing files:
- `src/mcp/server.ts` — 3 new tools (list-schemas, describe-schema, validate-node)
- `src/sync/indexer.ts` — validation call during indexing, reference resolution step
- `src/index.ts` — schema loading at startup

## Phase 2 Checklist

- [x] Schema TypeScript types (`SchemaDefinition`, `FieldDefinition`, `ResolvedSchema`)
- [x] YAML schema loader with `extends` inheritance resolution
- [x] Schema storage in `schemas` DB table
- [x] Multi-type field merging (union fields from all types on a node)
- [x] Schema validation on index (warn, don't reject)
- [x] Reference resolution (wiki-link title → node ID lookup)
- [x] MCP tool: `list-schemas`
- [x] MCP tool: `describe-schema`
- [x] MCP tool: `validate-node`
- [ ] Computed field evaluation (count, percentage aggregations)

## Milestone

Agent can ask "describe the work-task schema" and see inherited + own fields. Indexing validates files against their schemas and reports warnings. Wiki-link references resolve to node IDs. Queries filter by any type in the multi-type array (already works from Phase 1, now schema-aware).
