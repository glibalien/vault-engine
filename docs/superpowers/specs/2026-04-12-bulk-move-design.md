# Bulk Move — Design Spec

**Date:** 2026-04-12
**Status:** Approved

## Problem

There is no way to move many files at once via MCP tools. `rename-node` handles single-node moves (with reference rewriting), but bulk operations require N individual calls — slow and token-heavy for AI callers.

Real-world example: "Move all person files from vault root to `Persons/` and add `types: person`."

## Decision: Add `set_path` to `update-node` Query Mode

Bulk move is a new parameter on the existing `update-node` query mode, alongside `add_types`, `remove_types`, and `set_fields`. This reuses the filter, dry-run, best-effort, and batch-guard infrastructure already in place.

`set_path` changes the directory a file lives in. It does NOT change the title or rewrite references — wiki-links are title-based, so moves are transparent to the link graph.

This is distinct from `rename-node`, which changes identity (title + references). `set_path` changes location (directory only).

## Interface

```json
{
  "query": { "path_prefix": "", "without_types": ["person"] },
  "add_types": ["person"],
  "set_path": "Persons",
  "dry_run": false
}
```

- `set_path: "Persons"` → move to `Persons/{title}.md`
- `set_path: ""` or `set_path: "."` → move to vault root
- Combinable with `add_types`, `remove_types`, `set_fields` in the same call
- Nodes already at the target path are skipped (no-op), counted in `skipped`
- `set_path` is query-mode only. In single-node mode, return an error directing the caller to `rename-node`.

### Operation Ordering

**move → add_types → remove_types → set_fields**

Move first because `executeMutation` needs the correct `file_path` for rendering.

## Execution (Per Node)

For each matched node where `set_path` moves the file to a new directory:

1. **Compute new path:** `{set_path}/{title}.md` (or `{title}.md` if root)
2. **Conflict check:** Query DB + `existsSync` at target. If conflict, add to `errors`, skip node.
3. **Mkdir:** `mkdirSync(targetDir, { recursive: true })`
4. **Write-lock both paths:** `writeLock.withLockSync` for old and new absolute paths, so the watcher ignores the `unlink` + `add` chokidar events from the move.
5. **Disk move:** `renameSync(oldAbs, newAbs)`
6. **DB update:** `UPDATE nodes SET file_path = ? WHERE id = ?`
7. **Continue pipeline:** Pass new `file_path` to `add_types`/`remove_types`/`set_fields` and `executeMutation`, which re-renders at the new path.

No reference rewriting. After locks release, the watcher sees the new file, hashes it, matches `content_hash`, skips.

## Dry Run

Preview adds `path_changed` to the per-node diff:

```json
{
  "node_id": "abc123",
  "file_path": "John Smith.md",
  "title": "John Smith",
  "changes": {
    "path_changed": { "from": "", "to": "Persons" },
    "types_added": ["person"],
    "types_removed": [],
    "fields_set": {},
    "would_fail": false
  }
}
```

- `would_fail` covers both validation errors and move conflicts
- A node that only moves counts as `would_update`
- A node already at the target path with no other changes counts as `would_skip`

## Error Handling

- **Conflict at target:** Per-node error, skip and continue (best-effort).
- **Title contains path separators:** Reject defensively (should not occur — `create-node` enforces this).
- **Target directory doesn't exist:** Created automatically (`mkdirSync recursive`).
- **Source file missing from disk:** Skip with error.
- **Move succeeds but subsequent mutation fails:** Node stays moved. Consistent with best-effort semantics. Error is reported.
- **`set_path` in single-node mode:** Error with message directing to `rename-node`.

## What This Does Not Do

- **Change titles** — `set_path` moves files, it does not rename them.
- **Rewrite references** — title-based wiki-links are unaffected by directory changes.
- **Bulk rename with title changes** — separate future capability requiring batched reference resolution.
