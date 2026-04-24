import type Database from 'better-sqlite3';
import { resolveFieldValue, type FieldRow } from './field-value.js';

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
  const rows = db.prepare(
    `SELECT DISTINCT resolved_target_id FROM relationships
     WHERE source_id = ? AND resolved_target_id IS NOT NULL AND resolved_target_id != ?`
  ).all(rootId, rootId) as Array<{ resolved_target_id: string }>;
  return new Set(rows.map(r => r.resolved_target_id));
}

function collectIncomingCandidates(db: Database.Database, rootNode: NodeRow): Set<string> {
  const rows = db.prepare(
    'SELECT DISTINCT source_id FROM relationships WHERE resolved_target_id = ? AND source_id != ?'
  ).all(rootNode.id, rootNode.id) as Array<{ source_id: string }>;
  const ids = new Set<string>();
  for (const row of rows) ids.add(row.source_id);
  return ids;
}

function filterCandidatesByType(
  db: Database.Database,
  candidateIds: string[],
  allowedTypes: string[],
): string[] {
  if (candidateIds.length === 0 || allowedTypes.length === 0) return [];
  const idPlaceholders = candidateIds.map(() => '?').join(',');
  const typePlaceholders = allowedTypes.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT node_id FROM node_types
     WHERE node_id IN (${idPlaceholders}) AND schema_type IN (${typePlaceholders})`
  ).all(...candidateIds, ...allowedTypes) as Array<{ node_id: string }>;
  const matched = new Set(rows.map(r => r.node_id));
  return candidateIds.filter(id => matched.has(id));
}

function rankAndTruncate(
  db: Database.Database,
  filteredIds: string[],
  maxNodes: number,
): { ordered: NodeRow[]; truncated: boolean } {
  if (filteredIds.length === 0) return { ordered: [], truncated: false };
  const placeholders = filteredIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, file_path, title, body, file_mtime FROM nodes
     WHERE id IN (${placeholders})
     ORDER BY file_mtime IS NULL, file_mtime DESC, id ASC
     LIMIT ?`
  ).all(...filteredIds, maxNodes + 1) as NodeRow[];
  const truncated = rows.length > maxNodes;
  return { ordered: rows.slice(0, maxNodes), truncated };
}

function fetchTypesByNode(db: Database.Database, nodeIds: string[]): Record<string, string[]> {
  if (nodeIds.length === 0) return {};
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders}) ORDER BY rowid`
  ).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;
  const out: Record<string, string[]> = {};
  for (const id of nodeIds) out[id] = [];
  for (const row of rows) out[row.node_id].push(row.schema_type);
  return out;
}

function fetchFieldsByNode(
  db: Database.Database,
  nodeIds: string[],
): Record<string, Record<string, { value: unknown; type: string; source: string }>> {
  if (nodeIds.length === 0) return {};
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT node_id, field_name, value_text, value_number, value_date, value_json, source
     FROM node_fields WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<FieldRow & { node_id: string }>;
  const out: Record<string, Record<string, { value: unknown; type: string; source: string }>> = {};
  for (const id of nodeIds) out[id] = {};
  for (const row of rows) {
    const value = resolveFieldValue(row);
    const type = row.value_json !== null ? 'json'
      : row.value_number !== null ? 'number'
      : row.value_date !== null ? 'date'
      : 'text';
    out[row.node_id][row.field_name] = { value, type, source: row.source };
  }
  return out;
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

  const filtered = filterCandidatesByType(db, Array.from(candidates), options.types);
  if (filtered.length === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const considered = filtered.length;
  const { ordered, truncated } = rankAndTruncate(db, filtered, options.max_nodes);
  const orderedIds = ordered.map(r => r.id);
  const typesByNode = fetchTypesByNode(db, orderedIds);
  const fieldsByNode = fetchFieldsByNode(db, orderedIds);
  const expanded: Record<string, ExpandedNode> = {};
  for (const row of ordered) {
    expanded[row.id] = {
      id: row.id,
      title: row.title,
      types: typesByNode[row.id] ?? [],
      fields: fieldsByNode[row.id] ?? {},
      body: row.body,
    };
  }
  return {
    expanded,
    stats: { returned: ordered.length, considered, truncated },
  };
}
