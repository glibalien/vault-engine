import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import { resolveTarget } from '../resolver/resolve.js';

export interface ExpandOptions {
  types: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  max_nodes: number;
}

export interface ExpandedNode {
  id: string;
  title: string | null;
  types: string[];
  fields: Record<string, { value: unknown; type: string; source: string }>;
  body: string | null;
}

export interface ExpandStats {
  returned: number;
  considered: number;
  truncated: boolean;
}

export interface ExpandResult {
  expanded: Record<string, ExpandedNode>;
  stats: ExpandStats;
}

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  file_mtime: number | null;
}

function collectOutgoingCandidates(db: Database.Database, rootId: string): Set<string> {
  const rows = db.prepare('SELECT target FROM relationships WHERE source_id = ?').all(rootId) as Array<{ target: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    const byTitle = db.prepare('SELECT id FROM nodes WHERE title = ?').get(row.target) as { id: string } | undefined;
    const candidateId = byTitle?.id ?? resolveTarget(db, row.target)?.id ?? null;
    if (candidateId && candidateId !== rootId) ids.add(candidateId);
  }
  return ids;
}

function collectIncomingCandidates(db: Database.Database, rootNode: NodeRow): Set<string> {
  const nodeBasename = basename(rootNode.file_path, '.md');
  const rows = db.prepare(
    'SELECT source_id FROM relationships WHERE (target = ? OR target = ? OR target = ?) AND source_id != ?'
  ).all(rootNode.file_path, nodeBasename, rootNode.title ?? '', rootNode.id) as Array<{ source_id: string }>;
  const ids = new Set<string>();
  for (const row of rows) ids.add(row.source_id);
  return ids;
}

export function performExpansion(
  db: Database.Database,
  rootId: string,
  options: ExpandOptions,
): ExpandResult {
  const rootNode = db.prepare(
    'SELECT id, file_path, title, body, file_mtime FROM nodes WHERE id = ?'
  ).get(rootId) as NodeRow | undefined;
  if (!rootNode) return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };

  const candidates = new Set<string>();

  if (options.direction === 'outgoing' || options.direction === 'both') {
    for (const id of collectOutgoingCandidates(db, rootId)) candidates.add(id);
  }
  if (options.direction === 'incoming' || options.direction === 'both') {
    for (const id of collectIncomingCandidates(db, rootNode)) candidates.add(id);
  }

  if (candidates.size === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const considered = candidates.size;
  // Payload enrichment happens in later tasks (5, 6, 7). For now, return the considered count.
  return {
    expanded: {},
    stats: { returned: 0, considered, truncated: false },
  };
}
