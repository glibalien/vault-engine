// Query-time resolution (model A): relationships store raw target strings only.
// There is no resolved_target_id column or resolution pass during indexing.
// Resolution happens here, at query time, via four-tier basename matching.
// This is simpler and fast enough at 7k nodes. If query latency becomes a
// problem, switch to model B: add a resolved_target_id column to relationships
// and populate it during indexing with a resolution pass after each index.

import type Database from 'better-sqlite3';
import { basename } from 'node:path';

export interface ResolvedTarget {
  id: string;
  title: string | null;
}

export function resolveTarget(db: Database.Database, rawTarget: string): ResolvedTarget | null {
  // Tier 1: Exact file_path match
  const exact = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?')
    .get(rawTarget) as ResolvedTarget | undefined;
  if (exact) return exact;

  const allNodes = db.prepare('SELECT id, file_path, title FROM nodes')
    .all() as { id: string; file_path: string; title: string | null }[];

  const target = rawTarget.endsWith('.md') ? rawTarget.slice(0, -3) : rawTarget;

  // Tier 2: Exact basename match
  const exactBasename = allNodes.filter(n => basename(n.file_path, '.md') === target);
  if (exactBasename.length === 1) return { id: exactBasename[0].id, title: exactBasename[0].title };
  if (exactBasename.length > 1) return pickShortest(exactBasename);

  // Tier 3: Case-insensitive basename match
  const targetLower = target.toLowerCase();
  const caseInsensitive = allNodes.filter(n => basename(n.file_path, '.md').toLowerCase() === targetLower);
  if (caseInsensitive.length === 1) return { id: caseInsensitive[0].id, title: caseInsensitive[0].title };
  if (caseInsensitive.length > 1) return pickShortest(caseInsensitive);

  // Tier 4: Unicode NFC-normalized case-insensitive match
  const targetNormalized = target.normalize('NFC').toLowerCase();
  const normalized = allNodes.filter(n =>
    basename(n.file_path, '.md').normalize('NFC').toLowerCase() === targetNormalized
  );
  if (normalized.length === 1) return { id: normalized[0].id, title: normalized[0].title };
  if (normalized.length > 1) return pickShortest(normalized);

  return null;
}

function pickShortest(
  candidates: { id: string; file_path: string; title: string | null }[],
): ResolvedTarget {
  const sorted = candidates.slice().sort((a, b) => a.file_path.length - b.file_path.length);
  return { id: sorted[0].id, title: sorted[0].title };
}
