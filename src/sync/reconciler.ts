import type Database from 'better-sqlite3';
import { fullIndex } from '../indexer/indexer.js';
import type { IndexMutex } from './mutex.js';

export interface ReconcilerOptions {
  initialDelayMs?: number;
  intervalMs?: number;
}

export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  options?: ReconcilerOptions,
): { stop: () => void } {
  const initialDelayMs = options?.initialDelayMs ?? 2 * 60 * 1000;
  const intervalMs = options?.intervalMs ?? 15 * 60 * 1000;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function sweep(): void {
    mutex.run(async () => {
      const stats = fullIndex(vaultPath, db);
      const logStmt = db.prepare(
        'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
      );
      logStmt.run(null, Date.now(), 'reconciler-sweep', JSON.stringify(stats));
    });
  }

  const initialHandle = setTimeout(() => {
    sweep();
    intervalHandle = setInterval(sweep, intervalMs);
  }, initialDelayMs);

  return {
    stop: () => {
      clearTimeout(initialHandle);
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
      }
    },
  };
}
