import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { shouldIgnore } from '../indexer/ignore.js';
import { deleteNodeByPath } from '../indexer/indexer.js';
import { processFileChange } from './watcher.js';
import type { IndexMutex } from './mutex.js';
import type { WriteLockManager } from './write-lock.js';
import type { WriteGate } from './write-gate.js';

export interface ReconcilerOptions {
  initialDelayMs?: number;
  intervalMs?: number;
}

export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock?: WriteLockManager,
  writeGate?: WriteGate,
  options?: ReconcilerOptions,
): { stop: () => void } {
  const initialDelayMs = options?.initialDelayMs ?? 2 * 60 * 1000;
  const intervalMs = options?.intervalMs ?? 15 * 60 * 1000;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function sweep(): void {
    mutex.run(async () => {
      const stats = { indexed: 0, skipped: 0, deleted: 0, errors: 0 };

      // Walk vault and collect files
      const diskFiles = new Set<string>();
      walkDir(vaultPath, vaultPath, diskFiles);

      // Detect deletions
      const dbNodes = db.prepare('SELECT id, file_path FROM nodes').all() as { id: string; file_path: string }[];
      for (const node of dbNodes) {
        if (!diskFiles.has(node.file_path)) {
          deleteNodeByPath(node.file_path, db);
          stats.deleted++;
        }
      }

      // Process changed files
      for (const relPath of diskFiles) {
        try {
          const absPath = join(vaultPath, relPath);
          const st = statSync(absPath);
          const mtime = Math.floor(st.mtimeMs);

          const existing = db.prepare('SELECT content_hash, file_mtime FROM nodes WHERE file_path = ?')
            .get(relPath) as { content_hash: string; file_mtime: number } | undefined;

          // Skip unchanged files
          if (existing && existing.file_mtime === mtime) {
            stats.skipped++;
            continue;
          }

          // Hash check
          const content = readFileSync(absPath, 'utf-8');
          const hash = sha256(content);
          if (existing && existing.content_hash === hash) {
            db.prepare('UPDATE nodes SET file_mtime = ? WHERE file_path = ?').run(mtime, relPath);
            stats.skipped++;
            continue;
          }

          // Process through pipeline if writeLock available, else skip
          if (writeLock) {
            processFileChange(absPath, relPath, db, writeLock, vaultPath, writeGate);
          }
          stats.indexed++;
        } catch {
          stats.errors++;
        }
      }

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

function walkDir(dir: string, vaultPath: string, results: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walkDir(join(dir, entry.name), vaultPath, results);
    } else if (entry.isFile()) {
      const absPath = join(dir, entry.name);
      const relPath = relative(vaultPath, absPath);
      if (!shouldIgnore(relPath)) results.add(relPath);
    }
  }
}
