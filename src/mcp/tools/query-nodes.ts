import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
import { resolveFieldValue, type FieldRow } from '../field-value.js';

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
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  sort_by: z.enum(['title', 'file_mtime', 'indexed_at']).default('title'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  include_fields: z.array(z.string()).optional(),
};

export function registerQueryNodes(server: McpServer, db: Database.Database): void {
  server.tool(
    'query-nodes',
    'Query nodes with filtering by type, fields, full-text search, references, path, and date. Returns paginated results. Use include_fields to return field values inline (e.g. ["project","status"] or ["*"] for all).',
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
      const rows = db.prepare(dataSql).all(...dataParams) as Array<{ id: string; file_path: string; title: string | null }>;

      // Enrich with types and field_count
      const getTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?');
      const getFieldCount = db.prepare('SELECT COUNT(*) as count FROM node_fields WHERE node_id = ?');

      const includeFields = params.include_fields;
      const isWildcard = includeFields?.length === 1 && includeFields[0] === '*';

      // Prepare field query if needed
      let getFields: ReturnType<typeof db.prepare> | undefined;
      if (includeFields && includeFields.length > 0) {
        if (isWildcard) {
          getFields = db.prepare(
            'SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ?'
          );
        } else {
          const placeholders = includeFields.map(() => '?').join(', ');
          getFields = db.prepare(
            `SELECT field_name, value_text, value_number, value_date, value_json, source FROM node_fields WHERE node_id = ? AND field_name IN (${placeholders})`
          );
        }
      }

      const nodes = rows.map(row => {
        const node: Record<string, unknown> = {
          id: row.id,
          file_path: row.file_path,
          title: row.title,
          types: (getTypes.all(row.id) as Array<{ schema_type: string }>).map(t => t.schema_type),
          field_count: (getFieldCount.get(row.id) as { count: number }).count,
        };

        if (getFields) {
          const fieldArgs = isWildcard ? [row.id] : [row.id, ...includeFields!];
          const fieldRows = getFields.all(...fieldArgs) as FieldRow[];
          const fields: Record<string, unknown> = {};
          for (const f of fieldRows) {
            fields[f.field_name] = resolveFieldValue(f);
          }
          node.fields = fields;
        }

        return node;
      });

      return toolResult({ nodes, total });
    },
  );
}
