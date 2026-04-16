# Vault Engine Sync Service — Design Spec

**Date:** 2026-04-15
**Status:** Initial design
**Origin:** Vault note "Vault Engine Sync Service — Design Note"

## Summary

A custom sync service that replaces Obsidian Sync. An Obsidian plugin acts as a thin sync client, sending edited file content to the vault-engine server over HTTP and receiving canonical rendered versions back. The server pushes changes to connected clients via WebSocket. The plugin mediates all writes on the client, eliminating the two-writer race condition that is the root cause of every clobbering bug in the current system.

## Motivation

The engine's current approach to coexisting with Obsidian Sync works well. A set of defensive mechanisms — debounce, write-lock, hash checks, parse-retry, stale-file guard, and others — handle the unpredictability of an external sync service writing files to disk at arbitrary times. The key insight that made the system stable was deferring coercion and re-rendering to a scheduled daily normalizer run rather than fighting edits the user is actively making.

But that stability comes with a ceiling. Because the engine can't coordinate writes with Obsidian Sync, it must defer normalization — coercing field values, re-rendering canonical frontmatter, propagating schema changes to files — to a batch process that runs when the user isn't editing. A custom sync service wouldn't fix something broken; it would remove the constraint that forces this deferral, unlocking more aggressive real-time normalization that the engine currently can't do safely.

Specifically, if the engine owned the sync layer via an Obsidian plugin, it could:
- Coerce and re-render immediately on each edit, because the plugin controls when the file on disk changes
- Eliminate the two-writer race condition entirely, because the plugin mediates all writes
- Push schema changes and normalizer corrections to clients in real-time, rather than waiting for a daily sweep
- Surface validation feedback instantly, rather than logging it to edits.log for later review

## Architecture

### Topology

- **One central server** running vault-engine (the existing archalien deployment). The server is the single source of truth.
- **Multiple client devices** running Obsidian with a custom sync plugin. Clients are thin — they don't run vault-engine, don't understand schemas, and don't resolve conflicts.
- Obsidian remains the editor on all devices. The plugin replaces Obsidian Sync for file transport.

### Why This Eliminates Clobbering

The clobbering problem requires two independent writers to the same file. This design eliminates that:

- **Client side:** The plugin is the sole writer to disk. Obsidian edits are intercepted by the plugin, sent to the server, and only the canonical response is written back. The version-check mechanism ensures stale responses are never written.
- **Server side:** The existing pipeline is the sole writer. The write-lock prevents the watcher from racing with pipeline writes (unchanged from today).
- **Between client and server:** The plugin mediates. There's no filesystem sync running underneath — files move over HTTP/WebSocket, not file-level sync.

## Core Data Structure: Sync Log

An append-only table in the existing SQLite database:

```sql
CREATE TABLE sync_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path    TEXT NOT NULL,
  action       TEXT NOT NULL,    -- 'update' | 'create' | 'delete' | 'rename'
  content_hash TEXT NOT NULL,
  timestamp    TEXT NOT NULL,    -- ISO 8601
  source       TEXT NOT NULL     -- 'tool' | 'watcher' | 'normalizer' | 'plugin'
);
```

Every mutation that changes a file's rendered output appends a row. The sequence number is the client's cursor — "give me everything after seq N" is a single indexed query.

**What writes to the log:** `executeMutation` after a successful file write (tool calls, plugin pushes), the normalizer after re-rendering a drifted file, and the watcher if it triggers a file rewrite.

**What doesn't write to the log:** DB-only watcher updates (no file changed on disk), failed mutations.

**Retention:** Configurable. Default 30 days or 10,000 entries, whichever is larger. Clients behind the retention window do a full snapshot sync.

## Server Sync API

Four endpoints, all behind existing OAuth:

### `POST /sync/push` — Client sends an edited file

- Request: `{ file_path, content, client_seq }`
- Server runs content through the full pipeline (parse → validate → coerce → render)
- Response: `{ file_path, canonical_content, content_hash, seq }`
- If the server had newer changes to the same file, response includes a `conflicts` field (informational only — server already resolved it)

### `GET /sync/pull?since={seq}` — Client requests changes since a sequence number

- Response: `{ changes: [{ seq, file_path, action, content_hash, content }], latest_seq }`
- For `delete` and `rename` actions, `content` is null (rename includes `new_path`)
- Returns `410 Gone` if `since` is older than retention window

### `GET /sync/snapshot` — Full vault download

- Streamed response of `{ file_path, content, content_hash }` entries plus `latest_seq`
- Used on first connection and when client falls too far behind

### WebSocket `/sync/ws` — Real-time push from server

- Client sends `{ last_seq }` on connect; server replays missed changes then streams new ones
- Messages match the pull response shape
- Serves as both notification and delivery — client doesn't need a follow-up pull

## Obsidian Plugin (Client)

A thin sync client. Does not understand schemas, validation, or the pipeline.

### Core State

- `last_seq` — persisted locally, highest sequence number processed
- `pending_versions` — map of `file_path → version_counter` for debounce/versioning
- `in_flight` — set of file paths awaiting server response (plugin suppresses local events for these)

### Client→Server (push)

1. `vault.on('modify')` fires → plugin increments `pending_versions[path]`
2. Debounce (1.5s idle) fires → plugin snapshots content, records version, sends `POST /sync/push`
3. Response arrives → if version is still current, write canonical content to disk via `vault.adapter.write()`. If version is stale (user kept editing), discard response.
4. Update `last_seq`

### Server→Client (push)

1. WebSocket message arrives with file change
2. Plugin adds path to `in_flight` (suppresses the modify event the write will trigger)
3. Writes content via `vault.adapter.write()`
4. Updates `last_seq`, removes from `in_flight` after short delay

### Reconnect

1. Plugin connects WebSocket, sends `last_seq`
2. Server replays missed changes
3. If server responds with 410 (too far behind), full snapshot sync

### Conflict Surfacing

Informational Obsidian notice ("Server had newer changes to X — your edit was applied on top"). No merge UI, no conflict files. Server is authoritative.

### Offline Support

Plugin queues pushes locally. On reconnect, replays queue sequentially. Server processes through normal pipeline.

### What the Plugin Does NOT Do

- Parse YAML or understand frontmatter
- Validate fields or schemas
- Resolve conflicts — server is authoritative
- Sync the `.vault-engine/` directory or any ignored paths

## Interaction with Existing Subsystems

### Pipeline (`executeMutation`)

Gains one responsibility: append to `sync_log` after a successful file write. Plugin pushes enter as `source: 'plugin'` through the same parse → validate → coerce → render path as everything else. No other changes.

### Watcher

Remains on server for direct-to-disk edits (VS Code, vim). Not running on clients. Existing write-lock prevents watcher from racing with plugin-initiated pipeline writes — no change needed.

### Normalizer

Appends to sync log when it re-renders. Connected clients receive updates via WebSocket. No change to normalizer logic.

### MCP Tools

Unchanged. Another mutation source that appends to the sync log.

### File Creation/Deletion/Rename

All go through pipeline, all append to sync log with appropriate action type. Plugin creates, deletes, or moves local files via Obsidian's API.

## What This Eliminates (for Plugin Clients)

| Mechanism | Why it goes away |
|---|---|
| Parse-retry (truncation bug) | Obsidian Sync caused truncated files. No Obsidian Sync, no truncation. |
| 2.5s debounce tuned to Obsidian | Plugin has its own debounce with version tracking |
| Write-lock TTL | Plugin mediates all writes, no two-writer race |
| `.sync-conflict-*` ignoring | No Obsidian Sync, no conflict files |
| Normalizer quiescence | Server pushes normalizer changes cleanly via sync log |
| Stale-file guard | Plugin's version numbering is a stronger guarantee |

**What remains:** `uniqueKeys: false` (Obsidian's property editor still creates duplicates), server-side watcher (for non-plugin editors), the full pipeline, schema system, MCP tools.

## New Risks

- **Network dependency.** Client can edit locally while offline but changes don't sync until reconnection. Plugin queues and replays.
- **Offline batch.** Many offline edits replayed at once on reconnect. Server processes sequentially — may take seconds for large batches but is otherwise safe.
- **Plugin as critical dependency.** If plugin breaks or Obsidian changes its API, sync stops. Fallback: files are local markdown, user can copy manually or re-enable Obsidian Sync. No data loss.

## Open Questions

- Obsidian plugin API stability — how often do breaking changes happen? Maintenance burden assessment needed.
- Mobile performance — WebSocket keepalive on iOS/Android has platform-specific constraints (background execution limits, battery).
- Large vault initial sync — streaming snapshot for a vault with thousands of files needs backpressure handling.
- Binary attachments (images, PDFs) — sync log is designed for markdown. Attachments may need a separate channel or content-addressable store.
- Encryption in transit — Cloudflare tunnel provides TLS, but should we also encrypt file content at the application layer?
