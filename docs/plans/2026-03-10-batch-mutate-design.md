# batch-mutate + remove-relationship Design

## Overview

Two new capabilities to finish Phase 3:

1. **`remove-relationship`** — standalone MCP tool + internal helper; inverse of `add-relationship`
2. **`batch-mutate`** — MCP tool that orchestrates multiple mutations atomically

## `remove-relationship`

### Params

- `source_id` (string) — vault-relative file path of the source node
- `target` (string) — wiki-link target, e.g. `"Alice"` or `"[[Alice]]"`
- `rel_type` (string) — relationship type (schema field name, or `"wiki-link"` for body)

### Pipeline

Read + parse source file → locate reference → remove it → serialize → write → re-index + resolve references.

### Routing (mirrors `add-relationship`)

- `rel_type === 'wiki-link'` → remove `[[target]]` from body
- Schema field + list type → remove matching item from array
- Schema field + scalar → set field to `null` (removes it via `updateNode`)
- Schema-less fallback → check frontmatter fields first, then body
- **No-op:** if the reference doesn't exist, return current node (no error)

### Body link removal

AST-position-based: parse MDAST, find matching `wikiLink` node, remove the text at that position from the raw string. If the link is on its own line, remove the entire line. If inline, remove just the `[[target]]` text.

### Deduplication

Case-insensitive inner-target comparison, same as `add-relationship`.

## `batch-mutate`

### Params

```typescript
{
  operations: Array<{
    op: 'create' | 'update' | 'delete' | 'link' | 'unlink';
    params: Record<string, unknown>;
  }>
}
```

Each `op` maps to its corresponding internal helper:

| op       | helper               | params (same as standalone tool) |
|----------|----------------------|----------------------------------|
| create   | createNodeInner      | title, types, fields, body, parent_path, relationships |
| update   | updateNodeInner      | node_id, fields, body, append_body |
| delete   | deleteNodeInner      | node_id |
| link     | addRelationshipInner | source_id, target, rel_type |
| unlink   | removeRelationshipInner | source_id, target, rel_type |

### Execution model

- **Sequential in array order** — each op sees prior ops' filesystem and DB state
- **Single DB transaction** wrapping all operations
- **File snapshot/rollback** for atomicity

### Transaction extraction pattern

Each existing helper (createNode, updateNode, etc.) currently wraps its own `db.transaction()`. Refactor to:

```
createNodeInner(params)  — does file I/O + DB writes, no transaction
createNode(params)       — calls db.transaction(() => createNodeInner(params))
```

`batch-mutate` calls the inner functions directly inside one outer transaction. Standalone tools continue using the public wrappers unchanged.

### File rollback strategy

Before each file write/delete, snapshot:
- **Modified/deleted files:** save `{ path, content }` (original content read from disk)
- **Created files:** save `{ path, created: true }` (no prior content)

On any operation failure:
1. Restore modified/deleted files from snapshots (write back original content)
2. Delete created files
3. DB transaction rolls back automatically (no explicit DB cleanup needed)

Empty parent directories created during `create` operations are not cleaned up on rollback.

### `delete` operation

- Params: `{ node_id: string }`
- Validates node exists in DB and on disk
- Snapshots file content before deletion
- Deletes `.md` file via `deleteNodeFile` + removes DB rows via `deleteFile(db, path)`
- Stale references become unresolved naturally on `resolveReferences` pass

### Reference resolution

`resolveReferences(db)` runs once at the end of the batch, not per-operation.

### Response format

Success:
```json
{
  "results": [
    { "op": "create", "node": { "id": "...", ... } },
    { "op": "update", "node": { "id": "...", ... } },
    { "op": "delete", "node_id": "deleted/path.md" },
    { "op": "link", "node": { "id": "...", ... } },
    { "op": "unlink", "node": { "id": "...", ... } }
  ],
  "warnings": [...]
}
```

Failure (after rollback):
```json
{
  "error": "Operation 2 (update) failed: Node not found: foo.md",
  "rolled_back": true
}
```

### Error semantics

- Validation errors from individual ops (node not found, file not found, etc.) cause the entire batch to fail and roll back
- The error message identifies which operation (by index and op type) failed
- All prior ops' file and DB changes are reverted

## What this does NOT include

- `rename` operation in batch-mutate — rename already touches many files across the vault; batching renames with other ops adds significant complexity for unclear value. Users can call `rename-node` standalone.
- Cascade delete — stale references resolve naturally
- Empty directory cleanup on rollback
