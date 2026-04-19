import { unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { safeVaultPath } from './safe-path.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { refreshOnDelete } from '../resolver/refresh.js';

export interface ProposedDeletion {
  source: 'tool' | 'watcher' | 'reconciler' | 'fullIndex' | 'batch';
  node_id: string;
  file_path: string;
  unlink_file: boolean;
  reason?: string;
}

export interface DeletionResult {
  node_id: string;
  file_path: string;
  file_unlinked: boolean;
}

export function executeDeletion(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  deletion: ProposedDeletion,
): DeletionResult {
  const existing = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(deletion.node_id) as
    | { rowid: number }
    | undefined;

  if (!existing) {
    return {
      node_id: deletion.node_id,
      file_path: deletion.file_path,
      file_unlinked: false,
    };
  }

  const details: Record<string, unknown> = {
    file_path: deletion.file_path,
    source: deletion.source,
  };
  if (deletion.reason !== undefined) {
    details.reason = deletion.reason;
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(existing.rowid);
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ).run(deletion.node_id, Date.now(), 'file-deleted', JSON.stringify(details));
    db.prepare('DELETE FROM nodes WHERE id = ?').run(deletion.node_id);
  });
  txn();

  refreshOnDelete(db, deletion.node_id);

  let fileUnlinked = false;
  if (deletion.unlink_file) {
    const absPath = safeVaultPath(vaultPath, deletion.file_path);
    writeLock.withLockSync(absPath, () => {
      try {
        unlinkSync(absPath);
        fileUnlinked = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          fileUnlinked = true;
        }
      }
    });
  }

  return {
    node_id: deletion.node_id,
    file_path: deletion.file_path,
    file_unlinked: fileUnlinked,
  };
}
