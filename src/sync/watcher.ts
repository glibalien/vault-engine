import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { parseFile } from '../parser/index.js';
import { indexFile, deleteFile } from './indexer.js';

const writeLocks = new Set<string>();

export function acquireWriteLock(relativePath: string): void {
  writeLocks.add(relativePath);
}

export function releaseWriteLock(relativePath: string): void {
  writeLocks.delete(relativePath);
}

export function isWriteLocked(relativePath: string): boolean {
  return writeLocks.has(relativePath);
}

export interface WatcherOptions {
  debounceMs?: number;
  ignorePaths?: string[];
}

export function watchVault(
  db: Database.Database,
  vaultPath: string,
  opts?: WatcherOptions,
): { close(): Promise<void>; ready: Promise<void> } {
  const debounceMs = opts?.debounceMs ?? 300;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const ignored: (string | RegExp)[] = [
    '**/node_modules/**',
    '**/.git/**',
    ...(opts?.ignorePaths ?? []),
  ];

  const watcher: FSWatcher = watch(vaultPath, {
    ignoreInitial: true,
    ignored: [
      ...ignored,
      (path: string, stats?: import('node:fs').Stats) => {
        if (!stats || stats.isDirectory()) return false;
        return !path.endsWith('.md');
      },
    ],
  });

  function debounced(relPath: string, action: () => void): void {
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        action();
      }, debounceMs),
    );
  }

  function handleAddOrChange(absPath: string): void {
    const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
    if (isWriteLocked(rel)) return;

    debounced(rel, () => {
      try {
        const raw = readFileSync(absPath, 'utf-8');
        const mtime = statSync(absPath).mtime.toISOString();
        const parsed = parseFile(rel, raw);
        db.transaction(() => {
          indexFile(db, parsed, rel, mtime, raw);
        })();
      } catch (err) {
        console.error(`[vault-engine] failed to index ${rel}:`, err);
      }
    });
  }

  watcher.on('add', handleAddOrChange);
  watcher.on('change', handleAddOrChange);

  watcher.on('error', (err) => {
    console.error('[vault-engine] watcher error:', err);
  });

  watcher.on('unlink', (absPath: string) => {
    const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
    if (isWriteLocked(rel)) return;

    debounced(rel, () => {
      try {
        db.transaction(() => {
          deleteFile(db, rel);
        })();
      } catch (err) {
        console.error(`[vault-engine] failed to delete ${rel}:`, err);
      }
    });
  });

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', resolve);
  });

  return {
    ready,
    close: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      return watcher.close();
    },
  };
}
