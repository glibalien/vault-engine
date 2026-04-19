// src/undo/cleanup.ts

import type Database from 'better-sqlite3';

export interface CleanupOptions {
  retentionHours?: number;
  orphanGraceMs?: number;   // age below which node_count=0 rows are considered in-flight
}

export function runUndoCleanup(db: Database.Database, opts: CleanupOptions = {}): void {
  const retentionHours = opts.retentionHours ?? 24;
  const orphanGraceMs = opts.orphanGraceMs ?? 60_000;
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const orphanCutoff = Date.now() - orphanGraceMs;

  const run = db.transaction(() => {
    // 1. Delete already-expired active rows.
    db.prepare("DELETE FROM undo_operations WHERE status = 'expired'").run();

    // 2. Flip active rows past retention to expired.
    db.prepare("UPDATE undo_operations SET status = 'expired' WHERE status = 'active' AND timestamp < ?")
      .run(cutoff);

    // 3. Delete undone rows past retention.
    db.prepare("DELETE FROM undo_operations WHERE status = 'undone' AND timestamp < ?")
      .run(cutoff);

    // 4. Delete orphans (node_count=0) older than the grace window.
    db.prepare("DELETE FROM undo_operations WHERE node_count = 0 AND timestamp < ?")
      .run(orphanCutoff);
  });
  run();
}

export function startUndoCleanup(db: Database.Database, opts: CleanupOptions = {}): { stop: () => void } {
  runUndoCleanup(db, opts);
  const intervalMs = 60 * 60 * 1000;
  const handle = setInterval(() => runUndoCleanup(db, opts), intervalMs);
  return { stop: () => clearInterval(handle) };
}
