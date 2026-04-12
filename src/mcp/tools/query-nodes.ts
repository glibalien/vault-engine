import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';

const paramsShape = {
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  without_fields: z.array(z.string()).optional(),
  full_text: z.string().optional(),
  references: z.object({
    target: z.string(),
    rel_type: z.string().optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  }).optional(),
  path_prefix: z.string().optional(),
  modified_since: z.string().optional(),
  sort_by: z.enum(['title', 'file_mtime', 'indexed_at']).default('title'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
};

export function registerQueryNodes(server: McpServer, db: Database.Database): void {
  server.tool(
    'query-nodes',
    'Query nodes with filtering by type, fields, full-text search, references, path, and date. Returns paginated results.',
    paramsShape,
    async (params) => {
      const sortBy = params.sort_by ?? 'title';
      const sortOrder = params.sort_order ?? 'asc';
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const filter: NodeQueryFilter = {
        types: params.types,
        without_types: params.without_types,
        fields: params.fields as NodeQueryFilter['fields'],
        without_fields: params.without_fields,
        full_text: params.full_text,
        references: params.references,
        path_prefix: params.path_prefix,
        modified_since: params.modified_since,
      };

      const { sql, countSql, params: sqlParams } = buildNodeQuery(filter, db);

      // Count query
      const total = (db.prepare(countSql).get(...sqlParams) as { total: number }).total;

      // Data query with ORDER BY / LIMIT / OFFSET
      const sortCol = sortBy === 'title' ? 'n.title' : sortBy === 'file_mtime' ? 'n.file_mtime' : 'n.indexed_at';
      const dataSql = `${sql} ORDER BY ${sortCol} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`;
      const dataParams = [...sqlParams, limit, offset];
      const rows = db.prepare(dataSql).all(...dataParams) as Array<{ id: string; file_path: string; title: string | null }>;

      // Enrich with types and field_count
      const getTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?');
      const getFieldCount = db.prepare('SELECT COUNT(*) as count FROM node_fields WHERE node_id = ?');

      const nodes = rows.map(row => ({
        id: row.id,
        file_path: row.file_path,
        title: row.title,
        types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
        field_count: (getFieldCount.get(row.id) as { count: number }).count,
      }));

      return toolResult({ nodes, total });
    },
  );
}
