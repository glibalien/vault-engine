import type Database from 'better-sqlite3';
import type { Embedder } from './embedder.js';
import type { SearchHit } from './types.js';

const RRF_K = 60;
const VECTOR_LIMIT = 400;
const SNIPPET_CONTEXT = 40; // characters around match

/**
 * Build a simple highlighted snippet from text, wrapping matched terms with <mark>.
 * Since nodes_fts uses content='' (contentless), SQLite highlight() returns null,
 * so we generate snippets in JavaScript.
 */
function buildSnippet(text: string | null, queryTerms: string[]): string | null {
  if (!text) return null;

  let result = text;
  // Escape terms and wrap with <mark>
  for (const term of queryTerms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      result = result.replace(new RegExp(escaped, 'gi'), match => `<mark>${match}</mark>`);
    } catch {
      // Ignore regex errors for unusual terms
    }
  }

  // If no marks were inserted, return null to signal no match in this field
  if (!result.includes('<mark>')) return null;

  // Trim to a reasonable length around the first match
  const firstMark = result.indexOf('<mark>');
  const start = Math.max(0, firstMark - SNIPPET_CONTEXT);
  const end = Math.min(result.length, firstMark + SNIPPET_CONTEXT * 3);
  let snippet = result.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < result.length) snippet = snippet + '...';

  return snippet;
}

export interface HybridSearchOptions {
  candidateIds?: string[];
  limit?: number;
}

interface FtsHit {
  node_id: string;
  title: string | null;
  body: string | null;
}

interface VecHit {
  meta_id: number;
  node_id: string;
  source_type: 'node' | 'extraction';
  extraction_ref: string | null;
  chunk_index: number;
  distance: number;
}

function ftsSearch(
  db: Database.Database,
  query: string,
  candidateIds?: string[],
): FtsHit[] {
  try {
    if (candidateIds !== undefined && candidateIds.length === 0) {
      return [];
    }

    let sql: string;
    let params: unknown[];

    // Note: nodes_fts uses content='' (contentless), so highlight() returns null.
    // We fetch title and body from the nodes table and build snippets in JS.
    if (candidateIds !== undefined && candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => '?').join(', ');
      sql = `
        SELECT n.id as node_id, n.title, n.body
        FROM nodes_fts
        INNER JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?
          AND n.id IN (${placeholders})
        ORDER BY rank
      `;
      params = [query, ...candidateIds];
    } else {
      sql = `
        SELECT n.id as node_id, n.title, n.body
        FROM nodes_fts
        INNER JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?
        ORDER BY rank
      `;
      params = [query];
    }

    const rows = db.prepare(sql).all(...params) as FtsHit[];
    return rows;
  } catch {
    // FTS5 MATCH can throw on invalid query syntax
    return [];
  }
}

function vectorSearch(
  db: Database.Database,
  queryVec: Float32Array,
  candidateIds?: string[],
): VecHit[] {
  if (candidateIds !== undefined && candidateIds.length === 0) {
    return [];
  }

  const queryBytes = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);

  // sqlite-vec may not support complex WHERE clauses on the virtual table,
  // so we do candidate filtering in JS afterward.
  const sql = `
    SELECT v.id as meta_id, m.node_id, m.source_type, m.extraction_ref, m.chunk_index, v.distance
    FROM embedding_vec v
    INNER JOIN embedding_meta m ON m.id = v.id
    WHERE v.vector MATCH ? AND k = ?
  `;

  const rows = db.prepare(sql).all(queryBytes, VECTOR_LIMIT) as VecHit[];

  if (candidateIds !== undefined) {
    const candidateSet = new Set(candidateIds);
    return rows.filter(r => candidateSet.has(r.node_id));
  }

  return rows;
}

function fuseResults(
  ftsHits: FtsHit[],
  vecHits: VecHit[],
  limit: number,
  queryTerms: string[],
): SearchHit[] {
  // Map from node_id to accumulated score and metadata
  const nodeMap = new Map<
    string,
    {
      score: number;
      match_sources: Set<'fts' | 'semantic'>;
      snippet?: string;
      matched_embed?: string;
      bestChunkScore?: number;
      matched_chunk_index?: number;
    }
  >();

  function getOrCreate(nodeId: string) {
    let entry = nodeMap.get(nodeId);
    if (!entry) {
      entry = { score: 0, match_sources: new Set() };
      nodeMap.set(nodeId, entry);
    }
    return entry;
  }

  // Apply FTS ranks (rank 1-based)
  for (let i = 0; i < ftsHits.length; i++) {
    const hit = ftsHits[i];
    const rank = i + 1;
    const entry = getOrCreate(hit.node_id);
    entry.score += 1 / (RRF_K + rank);
    entry.match_sources.add('fts');
    // Build snippet from FTS hit content (highlight/snippet doesn't work on contentless FTS5)
    if (!entry.snippet) {
      const text = [hit.title, hit.body].filter(Boolean).join(' ');
      entry.snippet = buildSnippet(text, queryTerms) ?? undefined;
    }
  }

  // Apply vector ranks (rank 1-based)
  for (let i = 0; i < vecHits.length; i++) {
    const hit = vecHits[i];
    const rank = i + 1;
    const rankScore = 1 / (RRF_K + rank);
    const entry = getOrCreate(hit.node_id);
    entry.score += rankScore;
    entry.match_sources.add('semantic');

    if (hit.source_type === 'extraction' && hit.extraction_ref !== null && !entry.matched_embed) {
      entry.matched_embed = hit.extraction_ref;
    }

    if (entry.bestChunkScore === undefined || rankScore > entry.bestChunkScore) {
      entry.bestChunkScore = rankScore;
      entry.matched_chunk_index = hit.chunk_index;
    }
  }

  // Convert to SearchHit array
  const hits: SearchHit[] = [];
  for (const [node_id, entry] of nodeMap) {
    const hit: SearchHit = {
      node_id,
      score: entry.score,
      match_sources: Array.from(entry.match_sources),
    };
    if (entry.snippet !== undefined) {
      hit.snippet = entry.snippet;
    }
    if (entry.matched_embed !== undefined) {
      hit.matched_embed = entry.matched_embed;
    }
    if (entry.matched_chunk_index !== undefined) {
      hit.matched_chunk_index = entry.matched_chunk_index;
    }
    hits.push(hit);
  }

  // Sort by score descending, slice to limit
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export async function hybridSearch(
  db: Database.Database,
  embedder: Embedder,
  query: string,
  options: HybridSearchOptions,
): Promise<SearchHit[]> {
  const limit = options.limit ?? 20;
  const candidateIds = options.candidateIds;

  // Run FTS search
  const ftsHits = ftsSearch(db, query, candidateIds);

  // Run vector search
  const queryVec = await embedder.embedQuery(query);
  const vecHits = vectorSearch(db, queryVec, candidateIds);

  // Fuse results — pass query terms for snippet highlighting
  const queryTerms = query.split(/\s+/).filter(Boolean);
  return fuseResults(ftsHits, vecHits, limit, queryTerms);
}
