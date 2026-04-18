// src/resolver/resolved-targets-version.ts
//
// Tracks the resolved_target_id backfill version. Bump
// CURRENT_RESOLVED_TARGETS_VERSION whenever a change to the resolver semantics
// (e.g. candidate-keys list, case-folding rules) requires a full re-resolve of
// stored relationship rows. At startup the engine compares the stored version
// against the constant and runs a full backfill if the stored value is lower.

import type Database from 'better-sqlite3';

/**
 * v1: initial rollout of resolved_target_id — candidate keys are basename,
 * full path, and title (case-sensitive match via src/resolver/resolve.ts).
 */
export const CURRENT_RESOLVED_TARGETS_VERSION = 1;

const KEY = 'resolved_targets_version';

export function getResolvedTargetsVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (!row) return 0;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
}

export function setResolvedTargetsVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KEY, String(version));
}
