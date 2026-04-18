import type Database from 'better-sqlite3';
import { candidateKeysForNode } from './candidate-keys.js';
import { resolveTarget } from './resolve.js';

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

/**
 * Called after a node's file_path or title changes.
 * Step 1: null out every relationship whose resolved_target_id = nodeId.
 * Step 2: for each unique raw target in those rows, call resolveTarget and
 *         repopulate. (Deduping keeps N resolver calls down to U unique
 *         targets.)
 * Step 3: run refreshOnCreate-equivalent over still-NULL rows — rows whose
 *         raw target now matches the renamed node's new keys.
 */
export function refreshOnRename(db: Database.Database, nodeId: string): void {
  const tx = db.transaction(() => {
    const affected = db
      .prepare(
        'SELECT DISTINCT target FROM relationships WHERE resolved_target_id = ?'
      )
      .all(nodeId) as Array<{ target: string }>;

    db.prepare('UPDATE relationships SET resolved_target_id = NULL WHERE resolved_target_id = ?').run(nodeId);

    const upd = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE target = ? AND resolved_target_id IS NULL');
    for (const { target } of affected) {
      const resolved = resolveTarget(db, target);
      if (resolved) {
        upd.run(resolved.id, target);
      }
    }

    // Step 3: cover edges whose raw target matches the new name.
    // Inline the create-logic rather than nesting transactions.
    const row = db
      .prepare('SELECT id, file_path, title FROM nodes WHERE id = ?')
      .get(nodeId) as { id: string; file_path: string; title: string | null } | undefined;
    if (!row) return;
    const keys = candidateKeysForNode(row);

    db.prepare(
      'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?'
    ).run(nodeId, keys.file_path);
    if (keys.title !== null) {
      db.prepare(
        'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?'
      ).run(nodeId, keys.title);
    }
    db.prepare(
      'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND target = ?'
    ).run(nodeId, keys.basename);
    db.prepare(
      'UPDATE relationships SET resolved_target_id = ? WHERE resolved_target_id IS NULL AND LOWER(target) = ?'
    ).run(nodeId, keys.basenameLower);

    const nullRows = db
      .prepare('SELECT id, target FROM relationships WHERE resolved_target_id IS NULL')
      .all() as Array<{ id: number; target: string }>;
    const updById = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
    for (const r of nullRows) {
      if (r.target.normalize('NFC').toLowerCase() === keys.basenameNfcLower) {
        updById.run(nodeId, r.id);
      }
    }
  });
  tx();
}

/**
 * v1: no-op. FK `ON DELETE SET NULL` handles the row-level nulling.
 * Exported so callers can wire in advance; future versions may promote
 * runner-up resolutions for affected rows.
 */
export function refreshOnDelete(_db: Database.Database, _nodeId: string): void {
  // Intentionally empty. See spec: "Re-resolution on delete ... documented v1 limitation."
}

export interface BackfillStats {
  scanned: number;
  uniqueTargets: number;
  updated: number;
}

/**
 * Walks every NULL-resolved relationship, dedupes by raw target, calls
 * resolveTarget per unique string, and UPDATEs in chunks. Intended for
 * one-shot use at startup after the migration (version-gated by caller).
 */
export function backfillResolvedTargets(db: Database.Database): BackfillStats {
  const nullRows = db
    .prepare('SELECT id, target FROM relationships WHERE resolved_target_id IS NULL')
    .all() as Array<{ id: number; target: string }>;

  const scanned = nullRows.length;
  if (scanned === 0) {
    return { scanned: 0, uniqueTargets: 0, updated: 0 };
  }

  // Dedupe by raw target.
  const byTarget = new Map<string, number[]>();
  for (const r of nullRows) {
    const list = byTarget.get(r.target);
    if (list) list.push(r.id);
    else byTarget.set(r.target, [r.id]);
  }

  let updated = 0;
  const upd = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const [target, ids] of byTarget) {
      const resolved = resolveTarget(db, target);
      if (!resolved) continue;
      for (const id of ids) {
        upd.run(resolved.id, id);
        updated++;
      }
    }
  });
  tx();

  return { scanned, uniqueTargets: byTarget.size, updated };
}
