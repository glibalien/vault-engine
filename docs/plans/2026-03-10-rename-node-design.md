# rename-node MCP Tool — Design

Phase 3, Task 6. Renames a node and updates every reference to it across the entire vault.

## Tool Parameters

```typescript
{
  node_id: string,      // vault-relative path (existing node)
  new_title: string,    // new title value
  new_path?: string     // explicit new path (derived from schema template if omitted)
}
```

## Pipeline

1. **Validate** — Check node exists in DB and on disk. Error if `new_path` (or derived path) already exists.
2. **Derive new path** — If `new_path` not provided, use `generateFilePath(new_title, types, db)` from schema templates. Fall back to `{{title}}.md`.
3. **Find referencing files** — Query `relationships` where `resolved_target_id = old_node_id OR LOWER(target_id) = LOWER(old_title)`. Collect distinct `source_id` values (exclude self-references from the set — self-references are handled as part of the source file update in step 5).
4. **Update source file** — Read + parse existing file. Update references in body and frontmatter field values (handles self-references while content still has old title). Then serialize with new title. Write to new path via `writeNodeFile`. Delete old file via `deleteNodeFile`.
5. **Update each referencing file** — For each referencing file:
   - Read + parse
   - **Body references**: Parse to MDAST, walk `wikiLink` nodes to get positions of matching targets, do targeted string replacements at those positions in the raw body string. Aliases preserved.
   - **Frontmatter references**: Regex replace `[[Old Title]]` → `[[New Title]]` in raw field values.
   - Serialize + write in place via `writeNodeFile`
6. **Re-index in one transaction** — `deleteFile(db, oldPath)` for the source node, then `indexFile()` the new source file + all modified referencing files, then `resolveReferences(db)`.
7. **Return** — Hydrated renamed node + count of updated references.

## Body Reference Update (Position-based)

Parse the body to MDAST with `wikiLink` nodes that carry position information. Collect positions where `wikiLink.target` matches old title (case-insensitive). Replace from end-to-start so positions stay valid in the raw body string:

```
[[Old Title]]       → [[New Title]]
[[Old Title|alias]] → [[New Title|alias]]
```

Aliases are always preserved — the alias was intentionally chosen by the user.

## Frontmatter Reference Update

Regex replacement on raw YAML string values, per-field:

```
\[\[Old Title(\|[^\]]+)?\]\]  →  [[New Title$1]]
```

Applied to each field value individually. Bounded by `[[` and `]]` so no substring false matches.

## Finding Referencing Nodes

Query both columns in the `relationships` table:

```sql
SELECT DISTINCT source_id FROM relationships
WHERE resolved_target_id = ? OR LOWER(target_id) = LOWER(?)
```

This catches both resolved references (precise) and unresolved references that textually match the old title (thorough).

## Error Cases

- `node_id` not found in DB → error
- File missing from disk → error
- `new_path` already exists → error
- Derived path already exists → error

## Edge Cases

- **No-op**: `new_title` same as current title and no `new_path` provided → return current node
- **Self-references**: `[[Old Title]]` in the source file itself — handled naturally; source file goes through reference update before serialization with new title
- **Old title as substring**: `[[Alice]]` vs `[[Alice Cooper]]` — AST walk matches exact `wikiLink.target`, not substring. Frontmatter regex bounded by `]]`
- **Multiple references in one file**: All updated in single pass
- **Cross-referencing files**: No issue since all writes happen first, then one re-index pass

## Design Decisions

- **Position-based body replacement** (not remark-stringify round-trip) — avoids formatting drift on user-written markdown. Parse MDAST for positions, replace in raw string.
- **Always preserve aliases** — `[[Old|alias]]` → `[[New|alias]]`. User intent respected.
- **Delete-then-index for source node** — `deleteFile(oldPath)` + `indexFile(newPath)` + `resolveReferences()`. Leverages existing infrastructure, avoids hand-rolling cascading ID updates.
- **Error on path collision** — consistent with `create-node`. User provides explicit `new_path` to resolve.
- **Query both `resolved_target_id` and `target_id`** — catches resolved and unresolved references.

## Location

`renameNode` helper inside `createServer` closure in `src/mcp/server.ts`, following the same pattern as `createNode`, `updateNode`, and `addRelationship`.
