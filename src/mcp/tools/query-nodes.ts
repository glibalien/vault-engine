import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult } from './errors.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const paramsShape = {
  types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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
      const opts = params;
      const joins: string[] = [];
      const whereClauses: string[] = [];
      const sqlParams: unknown[] = [];
      let joinIdx = 0;

      // Type filter (intersection: node must have ALL specified types)
      if (opts.types && opts.types.length > 0) {
        for (const t of opts.types) {
          const alias = `t${joinIdx++}`;
          joins.push(`INNER JOIN node_types ${alias} ON ${alias}.node_id = n.id AND ${alias}.schema_type = ?`);
          sqlParams.push(t);
        }
      }

      // Field filters
      if (opts.fields) {
        for (const [fieldName, ops] of Object.entries(opts.fields)) {
          const alias = `f${joinIdx++}`;

          // Check for exists: false (LEFT JOIN + IS NULL pattern)
          if ('exists' in ops && ops.exists === false) {
            joins.push(`LEFT JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
            sqlParams.push(fieldName);
            whereClauses.push(`${alias}.node_id IS NULL`);
            continue;
          }

          // Normal: INNER JOIN
          joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
          sqlParams.push(fieldName);

          for (const [op, value] of Object.entries(ops)) {
            if (op === 'exists') {
              // exists: true is handled by the INNER JOIN itself
              continue;
            }
            if (op === 'contains') {
              whereClauses.push(`${alias}.value_text LIKE ?`);
              sqlParams.push(`%${value}%`);
            } else if (op === 'eq') {
              if (typeof value === 'number') {
                whereClauses.push(`${alias}.value_number = ?`);
              } else if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
                whereClauses.push(`${alias}.value_date = ?`);
              } else {
                whereClauses.push(`${alias}.value_text = ?`);
              }
              sqlParams.push(value);
            } else if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
              const sqlOp = op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
              if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
                whereClauses.push(`${alias}.value_date ${sqlOp} ?`);
              } else {
                whereClauses.push(`${alias}.value_number ${sqlOp} ?`);
              }
              sqlParams.push(value);
            }
          }
        }
      }

      // FTS5 full-text search
      if (opts.full_text) {
        joins.push('INNER JOIN nodes_fts ON nodes_fts.rowid = n.rowid');
        whereClauses.push('nodes_fts MATCH ?');
        sqlParams.push(opts.full_text);
      }

      // Reference filter
      if (opts.references) {
        const ref = opts.references;
        const dir = ref.direction ?? 'outgoing';

        if (dir === 'outgoing' || dir === 'both') {
          const alias = `r${joinIdx++}`;
          let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target = ?`;
          sqlParams.push(ref.target);
          if (ref.rel_type) {
            joinCond += ` AND ${alias}.rel_type = ?`;
            sqlParams.push(ref.rel_type);
          }
          joins.push(joinCond);
        }

        if (dir === 'incoming' || dir === 'both') {
          const alias = `r${joinIdx++}`;
          let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.target = n.title AND ${alias}.source_id IN (SELECT id FROM nodes WHERE title = ? OR file_path = ?)`;
          sqlParams.push(ref.target, ref.target);
          if (ref.rel_type) {
            joinCond += ` AND ${alias}.rel_type = ?`;
            sqlParams.push(ref.rel_type);
          }
          joins.push(joinCond);
        }
      }

      // Path prefix filter
      if (opts.path_prefix) {
        whereClauses.push('n.file_path LIKE ?');
        sqlParams.push(`${opts.path_prefix}%`);
      }

      // Modified since filter
      if (opts.modified_since) {
        whereClauses.push('n.file_mtime >= ?');
        const ts = Math.floor(new Date(opts.modified_since).getTime() / 1000);
        sqlParams.push(ts);
      }

      const joinSql = joins.join('\n');
      const whereSql = whereClauses.length > 0
        ? 'WHERE ' + whereClauses.join(' AND ')
        : '';

      // Count query
      const countSql = `SELECT COUNT(DISTINCT n.id) as total FROM nodes n ${joinSql} ${whereSql}`;
      const total = (db.prepare(countSql).get(...sqlParams) as { total: number }).total;

      // Data query
      const sortCol = sortBy === 'title' ? 'n.title' : sortBy === 'file_mtime' ? 'n.file_mtime' : 'n.indexed_at';
      const dataSql = `SELECT DISTINCT n.id, n.file_path, n.title FROM nodes n ${joinSql} ${whereSql} ORDER BY ${sortCol} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`;
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
