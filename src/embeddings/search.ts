import type Database from 'better-sqlite3';

export interface SemanticSearchFilter {
  field: string;
  operator: 'eq';
  value: string;
}

export interface SemanticSearchOptions {
  schema_type?: string;
  filters?: SemanticSearchFilter[];
  limit?: number;
  include_chunks?: boolean;
}

export interface SemanticSearchResult {
  id: string;
  filePath: string;
  title: string;
  types: string[];
  fields: Record<string, string>;
  score: number;
  matchingChunk?: {
    heading: string | null;
    content: string;
  };
}

export function semanticSearch(
  db: Database.Database,
  queryVector: Buffer,
  options: SemanticSearchOptions,
): SemanticSearchResult[] {
  const limit = options.limit ?? 10;
  const overFetch = limit * 3;

  // Step 1: Nearest neighbors from vec_chunks
  const vecRows = db.prepare(
    'SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
  ).all(queryVector, overFetch) as Array<{ chunk_id: string; distance: number }>;

  if (vecRows.length === 0) return [];

  // Step 2: Deduplicate by node_id (keep best distance per node)
  const bestByNode = new Map<string, { chunkId: string; distance: number }>();
  for (const row of vecRows) {
    const nodeId = row.chunk_id.split('#')[0];
    const existing = bestByNode.get(nodeId);
    if (!existing || row.distance < existing.distance) {
      bestByNode.set(nodeId, { chunkId: row.chunk_id, distance: row.distance });
    }
  }

  // Step 3: Load node data
  const nodeIds = [...bestByNode.keys()];
  const placeholders = nodeIds.map(() => '?').join(',');

  const nodes = db.prepare(`SELECT id, file_path, title FROM nodes WHERE id IN (${placeholders})`)
    .all(...nodeIds) as Array<{ id: string; file_path: string; title: string }>;

  const typeRows = db.prepare(`SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`)
    .all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;

  const typesMap = new Map<string, string[]>();
  for (const row of typeRows) {
    const arr = typesMap.get(row.node_id) ?? [];
    arr.push(row.schema_type);
    typesMap.set(row.node_id, arr);
  }

  const fieldRows = db.prepare(`SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`)
    .all(...nodeIds) as Array<{ node_id: string; key: string; value_text: string }>;

  const fieldsMap = new Map<string, Record<string, string>>();
  for (const row of fieldRows) {
    const rec = fieldsMap.get(row.node_id) ?? {};
    rec[row.key] = row.value_text;
    fieldsMap.set(row.node_id, rec);
  }

  // Step 4: Apply filters and build results
  let results: SemanticSearchResult[] = [];

  for (const node of nodes) {
    const types = typesMap.get(node.id) ?? [];
    const fields = fieldsMap.get(node.id) ?? {};

    if (options.schema_type && !types.includes(options.schema_type)) continue;

    if (options.filters) {
      let pass = true;
      for (const filter of options.filters) {
        if (fields[filter.field] !== filter.value) { pass = false; break; }
      }
      if (!pass) continue;
    }

    const best = bestByNode.get(node.id)!;
    const score = 1 / (1 + best.distance);

    const result: SemanticSearchResult = {
      id: node.id, filePath: node.file_path, title: node.title,
      types, fields, score,
    };

    if (options.include_chunks) {
      const chunk = db.prepare('SELECT heading, content FROM chunks WHERE id = ?')
        .get(best.chunkId) as { heading: string | null; content: string } | undefined;
      if (chunk) {
        result.matchingChunk = { heading: chunk.heading, content: chunk.content };
      }
    }

    results.push(result);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export function getPendingEmbeddingCount(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM embedding_queue WHERE status IN ('pending', 'processing')"
  ).get() as { count: number };
  return row.count;
}
