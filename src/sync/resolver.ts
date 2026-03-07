import type Database from 'better-sqlite3';

interface NodeLookupRow {
  id: string;
  title: string | null;
}

function buildLookupMaps(db: Database.Database): {
  titleMap: Map<string, string[]>;
  pathMap: Map<string, string[]>;
} {
  const rows = db.prepare('SELECT id, title FROM nodes').all() as NodeLookupRow[];
  const titleMap = new Map<string, string[]>();
  const pathMap = new Map<string, string[]>();

  for (const row of rows) {
    // Title-based lookup
    if (row.title) {
      const key = row.title.toLowerCase();
      const existing = titleMap.get(key);
      if (existing) existing.push(row.id);
      else titleMap.set(key, [row.id]);
    }

    // Path-based lookup: generate all suffixes
    // e.g., "projects/alpha/status.md" → ["status", "alpha/status", "projects/alpha/status"]
    const pathWithoutExt = row.id.replace(/\.md$/, '');
    const parts = pathWithoutExt.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const suffix = parts.slice(i).join('/').toLowerCase();
      const existing = pathMap.get(suffix);
      if (existing) existing.push(row.id);
      else pathMap.set(suffix, [row.id]);
    }
  }

  return { titleMap, pathMap };
}

export function resolveTarget(db: Database.Database, wikiLinkTarget: string): string | null {
  const { titleMap, pathMap } = buildLookupMaps(db);
  return resolveTargetWithMaps(wikiLinkTarget, titleMap, pathMap);
}

export function resolveReferences(db: Database.Database): { resolved: number; unresolved: number } {
  // Step 1: Clear stale resolutions
  db.prepare(`
    UPDATE relationships SET resolved_target_id = NULL
    WHERE resolved_target_id IS NOT NULL
      AND resolved_target_id NOT IN (SELECT id FROM nodes)
  `).run();

  // Step 2: Build lookup maps
  const { titleMap, pathMap } = buildLookupMaps(db);

  // Step 3: Resolve unresolved references
  const unresolvedRows = db.prepare(
    'SELECT id, target_id FROM relationships WHERE resolved_target_id IS NULL'
  ).all() as Array<{ id: number; target_id: string }>;

  const update = db.prepare('UPDATE relationships SET resolved_target_id = ? WHERE id = ?');

  let resolved = 0;
  let stillUnresolved = 0;

  for (const row of unresolvedRows) {
    const nodeId = resolveTargetWithMaps(row.target_id, titleMap, pathMap);
    if (nodeId) {
      update.run(nodeId, row.id);
      resolved++;
    } else {
      stillUnresolved++;
    }
  }

  return { resolved, unresolved: stillUnresolved };
}

function resolveTargetWithMaps(
  wikiLinkTarget: string,
  titleMap: Map<string, string[]>,
  pathMap: Map<string, string[]>,
): string | null {
  const target = wikiLinkTarget.toLowerCase();

  // 1. Try title match
  const titleMatches = titleMap.get(target);
  if (titleMatches && titleMatches.length === 1) {
    return titleMatches[0];
  }

  // 2. Try path suffix match (handles both stem-only and path/stem)
  const pathMatches = pathMap.get(target);
  if (pathMatches && pathMatches.length === 1) {
    return pathMatches[0];
  }

  // 3. If title matched multiple, try path suffix to disambiguate
  if (titleMatches && titleMatches.length > 1) {
    const pathFiltered = pathMap.get(target);
    if (pathFiltered && pathFiltered.length === 1) {
      return pathFiltered[0];
    }
  }

  return null;
}
