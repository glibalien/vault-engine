import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
import { resolveFieldValue, type FieldRow } from '../field-value.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { Embedder } from '../../search/embedder.js';
import { hybridSearch } from '../../search/search.js';

const paramsShape = {
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  without_fields: z.array(z.string()).optional(),
  query: z.string().optional(),
  references: z.object({
    target: z.string(),
    rel_type: z.string().optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  }).optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  sort_by: z.enum(['title', 'file_mtime', 'indexed_at']).default('title'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  include_fields: z.array(z.string()).optional(),
};

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
}

function enrichRows(
  db: Database.Database,
  rows: NodeRow[],
  includeFields: string[] | undefined,
): Array<Record<string, unknown>> {
  const getTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?');
  const getFieldCount = db.prepare('SELECT COUNT(*) as count FROM node_fields WHERE node_id = ?');

  const wantFields = includeFields && includeFields.length > 0;
  const isWildcard = includeFields?.length === 1 && includeFields[0] === '*';

  const getFieldsAll = wantFields && isWildcard
    ? db.prepare('SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?')
    : undefined;
  const getFieldsSome = wantFields && !isWildcard
    ? db.prepare(`SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ? AND field_name IN (${includeFields!.map(() => '?').join(', ')})`)
    : undefined;

  return rows.map(row => {
    const node: Record<string, unknown> = {
      id: row.id,
      file_path: row.file_path,
      title: row.title,
      types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
      field_count: (getFieldCount.get(row.id) as { count: number }).count,
    };

    if (getFieldsAll) {
      const fieldRows = getFieldsAll.all(row.id) as FieldRow[];
      const fields: Record<string, unknown> = {};
      for (const f of fieldRows) {
        fields[f.field_name] = resolveFieldValue(f);
      }
      node.fields = fields;
    } else if (getFieldsSome) {
      const fieldRows = getFieldsSome.all(row.id, ...includeFields!) as FieldRow[];
      const fields: Record<string, unknown> = {};
      for (const f of fieldRows) {
        fields[f.field_name] = resolveFieldValue(f);
      }
      node.fields = fields;
    }

    return node;
  });
}

export function registerQueryNodes(
  server: McpServer,
  db: Database.Database,
  _embeddingIndexer?: EmbeddingIndexer,
  embedder?: Embedder,
): void {
  server.tool(
    'query-nodes',
    'Query nodes with filtering by type, fields, semantic search, references, path, and date. Use the query param for full-text and semantic (vector) search with ranked results. Scores use Reciprocal Rank Fusion (RRF) — absolute values are not meaningful, only relative ordering matters. match_sources indicates retrieval method: "fts" (full-text match), "semantic" (vector/embedding match), or both. Returns paginated results. Use include_fields to return field values inline (e.g. ["project","status"] or ["*"] for all).',
    paramsShape,
    async (params) => {
      const sortBy = params.sort_by ?? 'title';
      const sortOrder = params.sort_order ?? 'asc';
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const query = params.query;
      const includeFields = params.include_fields;

      const hasStructuredFilters = Boolean(
        params.types?.length ||
        params.without_types?.length ||
        params.fields ||
        params.without_fields?.length ||
        params.references ||
        params.path_prefix ||
        params.without_path_prefix ||
        params.path_dir !== undefined ||
        params.modified_since,
      );

      // Hybrid search path: query present AND embedder available
      if (query && embedder) {
        let candidateIds: string[] | undefined;

        if (hasStructuredFilters) {
          const filter: NodeQueryFilter = {
            types: params.types,
            without_types: params.without_types,
            fields: params.fields as NodeQueryFilter['fields'],
            without_fields: params.without_fields,
            references: params.references,
            path_prefix: params.path_prefix,
            without_path_prefix: params.without_path_prefix,
            path_dir: params.path_dir,
            modified_since: params.modified_since,
          };

          const { sql, params: sqlParams } = buildNodeQuery(filter, db);
          // Fetch all candidate IDs (no LIMIT — hybrid search applies its own ranking)
          const idSql = sql.replace(
            /^SELECT DISTINCT n\.id, n\.file_path, n\.title, n\.body/,
            'SELECT DISTINCT n.id',
          );
          const idRows = db.prepare(idSql).all(...sqlParams) as Array<{ id: string }>;
          candidateIds = idRows.map(r => r.id);
        }

        const searchHits = await hybridSearch(db, embedder, query, {
          candidateIds,
          limit: limit + offset,
        });

        // Pagination: slice after ranking
        const pageHits = searchHits.slice(offset, offset + limit);
        const total = searchHits.length;

        // Fetch node rows for the page
        const getNode = db.prepare('SELECT id, file_path, title FROM nodes WHERE id = ?');
        const rows: NodeRow[] = [];
        for (const hit of pageHits) {
          const row = getNode.get(hit.node_id) as NodeRow | undefined;
          if (row) rows.push(row);
        }

        const enriched = enrichRows(db, rows, includeFields);

        // Merge search metadata onto each node
        const hitMap = new Map(pageHits.map(h => [h.node_id, h]));
        const nodes = enriched.map(node => {
          const hit = hitMap.get(node.id as string);
          if (hit) {
            node.score = hit.score;
            node.match_sources = hit.match_sources;
            if (hit.matched_embed !== undefined) node.matched_embed = hit.matched_embed;
            if (hit.snippet !== undefined) node.snippet = hit.snippet;
          }
          return node;
        });

        return toolResult({ nodes, total });
      }

      // Standard structured query path (no query param, or no embedder)
      const filter: NodeQueryFilter = {
        types: params.types,
        without_types: params.without_types,
        fields: params.fields as NodeQueryFilter['fields'],
        without_fields: params.without_fields,
        references: params.references,
        path_prefix: params.path_prefix,
        without_path_prefix: params.without_path_prefix,
        path_dir: params.path_dir,
        modified_since: params.modified_since,
      };

      const { sql, countSql, params: sqlParams } = buildNodeQuery(filter, db);

      // Count query
      const total = (db.prepare(countSql).get(...sqlParams) as { total: number }).total;

      // Data query with ORDER BY / LIMIT / OFFSET
      const sortCol = sortBy === 'title' ? 'n.title' : sortBy === 'file_mtime' ? 'n.file_mtime' : 'n.indexed_at';
      const dataSql = `${sql} ORDER BY ${sortCol} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`;
      const dataParams = [...sqlParams, limit, offset];
      const rows = db.prepare(dataSql).all(...dataParams) as NodeRow[];

      const nodes = enrichRows(db, rows, includeFields);

      return toolResult({ nodes, total });
    },
  );
}
