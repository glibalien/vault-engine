import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { watch, type FSWatcher } from 'chokidar';
import { sha256 } from '../indexer/hash.js';
import { shouldIgnore } from '../indexer/ignore.js';
import { indexFile, deleteNodeByPath } from '../indexer/indexer.js';
import type { IndexMutex } from './mutex.js';
import type { WriteLockManager } from './write-lock.js';

export interface WatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
}

interface PendingTimer {
  debounce: ReturnType<typeof setTimeout>;
  maxWait: ReturnType<typeof setTimeout>;
}

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  options?: WatcherOptions,
): FSWatcher {
  const debounceMs = options?.debounceMs ?? 500;
  const maxWaitMs = options?.maxWaitMs ?? 5000;
  const pendingTimers = new Map<string, PendingTimer>();

  // Wire mutex.processEvent to handle queued events during indexing
  mutex.processEvent = async (event) => {
    if (event.type === 'unlink') {
      const relPath = relative(vaultPath, join(vaultPath, event.path));
      deleteNodeByPath(relPath, db);
    } else {
      const absPath = join(vaultPath, event.path);
      indexFile(absPath, vaultPath, db);
    }
  };

  function scheduleIndex(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Clear existing debounce timer if any
    const existing = pendingTimers.get(absPath);
    if (existing) {
      clearTimeout(existing.debounce);
    }

    const fire = () => {
      const timers = pendingTimers.get(absPath);
      if (timers) {
        clearTimeout(timers.debounce);
        clearTimeout(timers.maxWait);
        pendingTimers.delete(absPath);
      }

      // Check write lock
      if (writeLock.isLocked(absPath)) return;

      // Hash check: skip if content unchanged
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        // File may have been deleted between event and fire
        return;
      }
      const hash = sha256(content);
      const row = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(relPath) as
        | { content_hash: string }
        | undefined;
      if (row && row.content_hash === hash) return;

      // Index through mutex
      mutex.run(async () => {
        indexFile(absPath, vaultPath, db);
      });
    };

    const debounceTimer = setTimeout(fire, debounceMs);

    if (existing) {
      // Keep existing maxWait timer, just reset debounce
      pendingTimers.set(absPath, { debounce: debounceTimer, maxWait: existing.maxWait });
    } else {
      // First event for this path: set up max-wait timer too
      const maxWaitTimer = setTimeout(fire, maxWaitMs);
      pendingTimers.set(absPath, { debounce: debounceTimer, maxWait: maxWaitTimer });
    }
  }

  function handleUnlink(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Clear any pending timers for this file
    const timers = pendingTimers.get(absPath);
    if (timers) {
      clearTimeout(timers.debounce);
      clearTimeout(timers.maxWait);
      pendingTimers.delete(absPath);
    }

    if (writeLock.isLocked(absPath)) return;

    if (mutex.isRunning()) {
      mutex.enqueue({ type: 'unlink', path: relPath });
    } else {
      mutex.run(async () => {
        deleteNodeByPath(relPath, db);
      });
    }
  }

  const watcher = watch(vaultPath, {
    ignoreInitial: true,
    ignored: [/(^|[/\\])\./, '**/node_modules/**'],
  });

  watcher.on('add', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    scheduleIndex(filePath);
  });

  watcher.on('change', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    scheduleIndex(filePath);
  });

  watcher.on('unlink', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    handleUnlink(filePath);
  });

  return watcher;
}
