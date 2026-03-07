# Incremental Indexing — Design

## Goal

Add change-detection-gated indexing so only new, modified, or deleted files trigger DB updates. Same parse+insert logic as full rebuild, skipping unchanged files.

## Function Signature

```typescript
export function incrementalIndex(
  db: Database.Database,
  vaultPath: string,
): { indexed: number; skipped: number; deleted: number }
```

## Algorithm

1. Scan all `.md` files on disk via `globMd(vaultPath)`
2. Load all existing `files` rows into a `Map<path, { mtime, hash }>`
3. For each file on disk:
   - `stat()` to get mtime
   - If path not in DB: new file — read, parse, index
   - If path in DB and mtime matches: skip
   - If path in DB and mtime differs: read file, compute SHA-256 hash
     - If hash matches: update mtime only in `files` table, skip re-index
     - If hash differs: parse + re-index
   - Remove path from the map (marks it as "seen")
4. Remaining paths in map = deleted files — remove from all tables
5. Wrap everything in a single transaction

## Change Detection Strategy

Mtime-first, hash-fallback:
- Mtime check is a cheap `stat()` call — avoids reading unchanged files
- Hash check catches files that were touched but not changed (mtime differs, content identical)
- Hash also serves as the definitive change signal when mtime changes

## New Helper: deleteFile

```typescript
export function deleteFile(db: Database.Database, relativePath: string): void
```

Removes all rows associated with a file path: relationships, fields, node_types, nodes, files. Deletion order respects FK constraints.

## Module Changes

- Add `incrementalIndex` and `deleteFile` to `src/sync/indexer.ts`
- Re-export from `src/sync/index.ts`

## What This Doesn't Do

- No file watching (Task 6)
- No single-file incremental API (the watcher will call `indexFile`/`deleteFile` directly)
