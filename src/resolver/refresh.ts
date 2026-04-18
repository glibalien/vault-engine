import type Database from 'better-sqlite3';
import { candidateKeysForNode } from './candidate-keys.js';

/**
 * Called after a node is created. Resolves any existing NULL-resolved
 * relationships whose raw `target` matches one of the new node's
 * candidate keys (file_path, title, basename, case-folded basename,
 * NFC-normalized basename).
 *
 * Does NOT supersede already-resolved edges — see documented v1 limitation.
 */
export function refreshOnCreate(db: Database.Database, nodeId: string): void {
  const row = db
    .prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
    .get(nodeId) as { id: string; file_path: string; title: string | null } | undefined;
  if (!row) return;
  const keys = candidateKeysForNode(row);

  const tx = db.transaction(() => {
    // Tier 1: exact file_path
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND target = ?`
    ).run(nodeId, keys.file_path);

    // Tier 2: exact title (when present)
    if (keys.title !== null) {
      db.prepare(
        `UPDATE relationships SET resolved_target_id = ?
           WHERE resolved_target_id IS NULL AND target = ?`
      ).run(nodeId, keys.title);
    }

    // Tier 3: exact basename
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND target = ?`
    ).run(nodeId, keys.basename);

    // Tier 4: case-folded basename (compare lowercased target to basenameLower)
    db.prepare(
      `UPDATE relationships SET resolved_target_id = ?
         WHERE resolved_target_id IS NULL AND LOWER(target) = ?`
    ).run(nodeId, keys.basenameLower);

    // Tier 5: NFC-normalized, case-folded basename.
    // SQLite has no NFC normalization; handle with a scan restricted to NULL rows.
    const nullRows = db
      .prepare(`SELECT id, target FROM relationships WHERE resolved_target_id IS NULL`)
      .all() as Array<{ id: number; target: string }>;
    const upd = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
    for (const r of nullRows) {
      if (r.target.normalize('NFC').toLowerCase() === keys.basenameNfcLower) {
        upd.run(nodeId, r.id);
      }
    }
  });
  tx();
}
