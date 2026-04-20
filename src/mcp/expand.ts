import type Database from 'better-sqlite3';
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

export function performExpansion(
  db: Database.Database,
  rootId: string,
  options: ExpandOptions,
): ExpandResult {
  const candidates = new Set<string>();

  if (options.direction === 'outgoing' || options.direction === 'both') {
    for (const id of collectOutgoingCandidates(db, rootId)) candidates.add(id);
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
