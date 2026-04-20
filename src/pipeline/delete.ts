import { unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { safeVaultPath } from './safe-path.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import { refreshOnDelete } from '../resolver/refresh.js';
import type { UndoContext } from './types.js';

export interface ProposedDeletion {
  source: 'tool' | 'watcher' | 'reconciler' | 'fullIndex' | 'batch' | 'undo';
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
  undoContext?: UndoContext,
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
    // ── Undo snapshot capture (pre-delete state) ────────────────────
    if (undoContext) {
      const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
        .get(deletion.node_id) as { file_path: string; title: string | null; body: string | null } | undefined;
      if (nodeRow) {
        const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
          .all(deletion.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);
        const fieldsRows = db.prepare(
          'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
        ).all(deletion.node_id);
        const relRows = db.prepare(
          'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
        ).all(deletion.node_id);

        // OR IGNORE: keep the first snapshot if multiple calls share an
        // operation_id for the same node (defensive; delete-paths normally
        // run once per node).
        db.prepare(`
          INSERT OR IGNORE INTO undo_snapshots (
            operation_id, node_id, file_path, title, body, types, fields, relationships,
            was_deleted, post_mutation_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          undoContext.operation_id,
          deletion.node_id,
          nodeRow.file_path,
          nodeRow.title,
          nodeRow.body,
          JSON.stringify(typesArr),
          JSON.stringify(fieldsRows),
          JSON.stringify(relRows),
        );
      }
    }

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
