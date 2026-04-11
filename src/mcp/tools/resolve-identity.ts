// src/mcp/tools/resolve-identity.ts
//
// Shared node identity resolution for all mutation tools.

import type Database from 'better-sqlite3';
import { resolveTarget } from '../../resolver/resolve.js';
import type { ErrorCode } from './errors.js';

export interface ResolvedNode {
  node_id: string;
  file_path: string;
  title: string;
}

export type ResolveResult =
  | { ok: true; node: ResolvedNode }
  | { ok: false; code: ErrorCode; message: string };

/**
 * Resolve a node from exactly one of: node_id, file_path, or title.
 * Returns the node's identity or an error result.
 */
export function resolveNodeIdentity(
  db: Database.Database,
  params: { node_id?: string; file_path?: string; title?: string },
): ResolveResult {
  const { node_id, file_path, title } = params;

  const provided = [node_id, file_path, title].filter(v => v !== undefined);
  if (provided.length === 0) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Exactly one of node_id, file_path, or title is required' };
  }
  if (provided.length > 1) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Exactly one of node_id, file_path, or title is required' };
  }

  type NodeRow = { id: string; file_path: string; title: string | null };
  let row: NodeRow | undefined;

  if (node_id) {
    row = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(node_id) as NodeRow | undefined;
  } else if (file_path) {
    row = db.prepare('SELECT id, file_path, title FROM nodes WHERE file_path = ?').get(file_path) as NodeRow | undefined;
  } else if (title) {
    row = db.prepare('SELECT id, file_path, title FROM nodes WHERE title = ?').get(title) as NodeRow | undefined;
    if (!row) {
      const resolved = resolveTarget(db, title);
      if (resolved) {
        row = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?').get(resolved.id) as NodeRow | undefined;
      }
    }
  }

  if (!row) {
    return { ok: false, code: 'NOT_FOUND', message: 'Node not found' };
  }

  return {
    ok: true,
    node: {
      node_id: row.id,
      file_path: row.file_path,
      title: row.title ?? row.file_path,
    },
  };
}
