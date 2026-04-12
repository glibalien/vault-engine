import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import { resolveTarget } from '../resolver/resolve.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export interface FieldFilter {
  eq?: unknown;
  gt?: unknown;
  lt?: unknown;
  gte?: unknown;
  lte?: unknown;
  contains?: string;
  exists?: boolean;
}

export interface ReferenceFilter {
  target: string;
  rel_type?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
}

export interface NodeQueryFilter {
  types?: string[];
  without_types?: string[];
  fields?: Record<string, FieldFilter>;
  without_fields?: string[];
  full_text?: string;
  references?: ReferenceFilter;
  path_prefix?: string;
  without_path_prefix?: string;
  modified_since?: string;
}

export interface NodeQueryResult {
  sql: string;
  countSql: string;
  params: unknown[];
}

export function buildNodeQuery(filter: NodeQueryFilter, db?: Database.Database): NodeQueryResult {
  const joins: string[] = [];
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let joinIdx = 0;

  // Type filter (intersection: node must have ALL specified types)
  if (filter.types && filter.types.length > 0) {
    for (const t of filter.types) {
      const alias = `t${joinIdx++}`;
      joins.push(`INNER JOIN node_types ${alias} ON ${alias}.node_id = n.id AND ${alias}.schema_type = ?`);
      params.push(t);
    }
  }

  // Negation type filter (node must NOT have any of the specified types)
  if (filter.without_types && filter.without_types.length > 0) {
    for (const t of filter.without_types) {
      whereClauses.push(`n.id NOT IN (SELECT node_id FROM node_types WHERE schema_type = ?)`);
      params.push(t);
    }
  }

  // Field filters
  if (filter.fields) {
    for (const [fieldName, ops] of Object.entries(filter.fields)) {
      const alias = `f${joinIdx++}`;

      // Check for exists: false (LEFT JOIN + IS NULL pattern)
      if ('exists' in ops && ops.exists === false) {
        joins.push(`LEFT JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
        params.push(fieldName);
        whereClauses.push(`${alias}.node_id IS NULL`);
        continue;
      }

      // Normal: INNER JOIN
      joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
      params.push(fieldName);

      for (const [op, value] of Object.entries(ops)) {
        if (op === 'exists') {
          // exists: true is handled by the INNER JOIN itself
          continue;
        }
        if (op === 'contains') {
          whereClauses.push(`${alias}.value_text LIKE ?`);
          params.push(`%${value}%`);
        } else if (op === 'eq') {
          if (typeof value === 'number') {
            whereClauses.push(`${alias}.value_number = ?`);
          } else if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
            whereClauses.push(`${alias}.value_date = ?`);
          } else {
            whereClauses.push(`${alias}.value_text = ?`);
          }
          params.push(value);
        } else if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
          const sqlOp = op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
          if (typeof value === 'string' && ISO_DATE_RE.test(value as string)) {
            whereClauses.push(`${alias}.value_date ${sqlOp} ?`);
          } else {
            whereClauses.push(`${alias}.value_number ${sqlOp} ?`);
          }
          params.push(value);
        }
      }
    }
  }

  // Negation field filter (node must NOT have any of the specified field names)
  if (filter.without_fields && filter.without_fields.length > 0) {
    for (const fieldName of filter.without_fields) {
      whereClauses.push(`n.id NOT IN (SELECT node_id FROM node_fields WHERE field_name = ?)`);
      params.push(fieldName);
    }
  }

  // FTS5 full-text search
  if (filter.full_text) {
    joins.push('INNER JOIN nodes_fts ON nodes_fts.rowid = n.rowid');
    whereClauses.push('nodes_fts MATCH ?');
    params.push(filter.full_text);
  }

  // Reference filter
  if (filter.references) {
    const ref = filter.references;
    const dir = ref.direction ?? 'outgoing';

    if (dir === 'outgoing' || dir === 'both') {
      const alias = `r${joinIdx++}`;
      let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target = ?`;
      params.push(ref.target);
      if (ref.rel_type) {
        joinCond += ` AND ${alias}.rel_type = ?`;
        params.push(ref.rel_type);
      }
      joins.push(joinCond);
    }

    if (dir === 'incoming' || dir === 'both') {
      if (!db) {
        throw new Error('db is required for incoming reference filter (resolveTarget lookup)');
      }
      // "Incoming to X" means: find nodes that link TO X.
      // Result nodes are the sources of those relationships.
      // Strategy: resolve the target param to a node, collect all raw strings
      // that could refer to it, then match relationships whose target is one of those.
      const resolved = resolveTarget(db, ref.target);
      if (!resolved) {
        // Target doesn't resolve — no incoming results possible
        whereClauses.push('1 = 0');
      } else {
        const targetNode = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?')
          .get(resolved.id) as { file_path: string; title: string | null };
        // Collect all raw strings that wiki-links might use to refer to this node
        const possibleTargets: string[] = [];
        if (targetNode.title) possibleTargets.push(targetNode.title);
        possibleTargets.push(targetNode.file_path);
        possibleTargets.push(basename(targetNode.file_path, '.md'));
        const unique = [...new Set(possibleTargets)];

        const alias = `r${joinIdx++}`;
        const placeholders = unique.map(() => '?').join(', ');
        let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target IN (${placeholders})`;
        params.push(...unique);
        if (ref.rel_type) {
          joinCond += ` AND ${alias}.rel_type = ?`;
          params.push(ref.rel_type);
        }
        joins.push(joinCond);
      }
    }
  }

  // Path prefix filter
  if (filter.path_prefix) {
    whereClauses.push('n.file_path LIKE ?');
    params.push(`${filter.path_prefix}%`);
  }

  // Negation path prefix filter
  if (filter.without_path_prefix) {
    whereClauses.push('n.file_path NOT LIKE ?');
    params.push(`${filter.without_path_prefix}%`);
  }

  // Modified since filter
  if (filter.modified_since) {
    whereClauses.push('n.file_mtime >= ?');
    const ts = Math.floor(new Date(filter.modified_since).getTime() / 1000);
    params.push(ts);
  }

  const joinSql = joins.join('\n');
  const whereSql = whereClauses.length > 0
    ? 'WHERE ' + whereClauses.join(' AND ')
    : '';

  const baseFrom = `FROM nodes n`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();

  return { sql, countSql, params };
}
