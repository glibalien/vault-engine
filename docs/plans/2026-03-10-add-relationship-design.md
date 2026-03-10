# `add-relationship` MCP Tool — Design

**Phase 3, Task 5** — Thin wrapper over `update-node`'s write pipeline for agent ergonomics ("link A to B" instead of "update A's fields").

## Tool Parameters

```typescript
{
  source_id: string,    // vault-relative file path (e.g., "tasks/Review PR.md")
  target: string,       // wiki-link title or [[target]] syntax
  rel_type: string,     // schema field name, or 'wiki-link' for body
}
```

All three params required.

## Routing Logic

1. **Normalize target** — wrap in `[[...]]` if not already wrapped.
2. **Force body** — if `rel_type === 'wiki-link'`, skip schema lookup, go straight to body append.
3. **Schema lookup** — call `mergeSchemaFields(db, nodeTypes)` to check if `rel_type` matches a field definition.
   - **List field** (`type.startsWith('list<')`) — read current array value, check for duplicate (skip if present), append target, pass full array as field update.
   - **Scalar field** — pass target as field update (overwrites existing value).
4. **Schema-less fallback** (no schemas loaded for the node's types) — check existing frontmatter fields:
   - Existing array field → check for duplicate, append.
   - Existing scalar field → overwrite.
   - No existing field → body append.
5. **Body fallback** — anything unmatched appends `[[target]]` via `append_body`.

This routing logic matches `create-node`'s relationship handling pattern.

## Implementation Approach

An `addRelationship` helper inside the `createServer` closure (same pattern as `createNode`/`updateNode`). Pipeline:

1. Validate params — all three required.
2. Read + parse existing file via `readFileSync` + `parseFile()` to get current fields, types, and wiki-links.
3. Normalize target to `[[...]]` syntax.
4. Determine routing per logic above.
5. Delegate to `updateNode` with computed `fields` or `append_body` args.
6. Return the same shape as `updateNode` — hydrated node + warnings.

`addRelationship` does not duplicate the write pipeline. It computes the right `updateNode` call and delegates. The double file-read (once here to inspect current state, once in `updateNode` for the write pipeline) is negligible for small markdown files and keeps the code simple.

## Deduplication

Idempotent behavior — adding an existing relationship is a successful no-op.

### List fields
Check if the normalized `[[target]]` already exists in the current array value. Case-insensitive comparison on the inner target text. If present, return the current node unchanged — no write.

### Body links
Check `parsed.wikiLinks.filter(l => l.source === 'body')` for a matching target (case-insensitive on inner text). This uses the AST-extracted links from `parseFile()`, which is more correct than raw string search (won't false-match inside code blocks). If found, return the current node unchanged — no write.

### Scalar fields
Always overwrite. Replacing one reference with another is valid, and setting the same value produces identical serializer output (effective no-op at the file level).

## Error Cases

- `source_id` doesn't exist in DB or on disk → error (same as `update-node`).
- Missing required params → error.

No other error cases. Warn-never-reject philosophy applies — schema validation warnings pass through from `updateNode`.

## Dependencies

- `updateNode` helper (Task 4) — delegated write pipeline.
- `mergeSchemaFields` (Phase 2) — schema field lookup for routing.
- `parseFile` (Phase 1) — reading current state + body wiki-link extraction for dedup.

## Return Shape

Same as `update-node`:
```typescript
{
  node: { id, title, types, fields, created_at, updated_at },
  warnings: ValidationWarning[]
}
```
