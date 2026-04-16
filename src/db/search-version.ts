// src/db/search-version.ts
//
// Tracks the embedding pipeline version so the engine can detect when an
// upgrade requires a full clear + re-embed. Bump CURRENT_SEARCH_VERSION
// whenever a change makes existing stored vectors semantically wrong.

import type Database from 'better-sqlite3';

/**
 * v1: full-content embeddings, truncated by tokenizer at 8192 tokens.
 * v2: chunked embeddings + extraction embeddings.
 */
export const CURRENT_SEARCH_VERSION = 2;

const KEY = 'search_version';

export function getSearchVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (!row) return 1;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 1;
}

export function setSearchVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KEY, String(version));
}
