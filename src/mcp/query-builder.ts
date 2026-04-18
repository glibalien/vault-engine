import type Database from 'better-sqlite3';
import { resolveTarget } from '../resolver/resolve.js';

export interface FieldFilter {
  eq?: unknown;
  ne?: unknown;
  gt?: unknown;
  lt?: unknown;
  gte?: unknown;
  lte?: unknown;
  contains?: string;
  includes?: unknown;
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
  references?: ReferenceFilter;
  title_eq?: string;
  title_contains?: string;
  path_prefix?: string;
  without_path_prefix?: string;
  path_dir?: string;
  modified_since?: string;
}

export interface NodeQueryResult {
  sql: string;
  countSql: string;
  params: unknown[];
}

export function buildNodeQuery(filter: NodeQueryFilter, db?: Database.Database): NodeQueryResult {
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];
  let joinIdx = 0;

  // Type filter (intersection: node must have ALL specified types)
  if (filter.types && filter.types.length > 0) {
    for (const t of filter.types) {
      const alias = `t${joinIdx++}`;
      joins.push(`INNER JOIN node_types ${alias} ON ${alias}.node_id = n.id AND ${alias}.schema_type = ?`);
      joinParams.push(t);
    }
  }

  // Negation type filter (node must NOT have any of the specified types)
  if (filter.without_types && filter.without_types.length > 0) {
    for (const t of filter.without_types) {
      whereClauses.push(`n.id NOT IN (SELECT node_id FROM node_types WHERE schema_type = ?)`);
      whereParams.push(t);
    }
  }

  // Field filters
  if (filter.fields) {
    for (const [fieldName, ops] of Object.entries(filter.fields)) {
      const alias = `f${joinIdx++}`;

      // Check for exists: false (LEFT JOIN + IS NULL pattern)
      if ('exists' in ops && ops.exists === false) {
        joins.push(`LEFT JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
        joinParams.push(fieldName);
        whereClauses.push(`${alias}.node_id IS NULL`);
        continue;
      }

      // Normal: INNER JOIN
      joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
      joinParams.push(fieldName);

      for (const [op, value] of Object.entries(ops)) {
        if (op === 'exists') {
          // exists: true is handled by the INNER JOIN itself
          continue;
        }
        if (op === 'contains') {
          // Search both value_text (scalar strings) and value_json (arrays/objects)
          whereClauses.push(`(${alias}.value_text LIKE ? OR ${alias}.value_json LIKE ?)`);
          whereParams.push(`%${value}%`, `%${value}%`);
        } else if (op === 'includes') {
          // Array membership: check if value_json (a JSON array) contains the given element
          whereClauses.push(
            `EXISTS (SELECT 1 FROM json_each(${alias}.value_json) WHERE json_each.value = ?)`
          );
          whereParams.push(value);
        } else if (op === 'eq') {
          if (typeof value === 'number') {
            whereClauses.push(`${alias}.value_number = ?`);
          } else {
            whereClauses.push(`${alias}.value_text = ?`);
          }
          whereParams.push(value);
        } else if (op === 'ne') {
          if (typeof value === 'number') {
            whereClauses.push(`${alias}.value_number != ?`);
          } else {
            whereClauses.push(`${alias}.value_text != ?`);
          }
          whereParams.push(value);
        } else if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
          const sqlOp = op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
          if (typeof value === 'number') {
            whereClauses.push(`${alias}.value_number ${sqlOp} ?`);
          } else {
            // ISO date strings sort lexicographically in value_text
            whereClauses.push(`${alias}.value_text ${sqlOp} ?`);
          }
          whereParams.push(value);
        }
      }
    }
  }

  // Negation field filter (node must NOT have any of the specified field names)
  if (filter.without_fields && filter.without_fields.length > 0) {
    for (const fieldName of filter.without_fields) {
      whereClauses.push(`n.id NOT IN (SELECT node_id FROM node_fields WHERE field_name = ?)`);
      whereParams.push(fieldName);
    }
  }

  // Reference filter
  if (filter.references) {
    const ref = filter.references;
    const dir = ref.direction ?? 'outgoing';

    if (dir === 'outgoing' || dir === 'both') {
      const alias = `r${joinIdx++}`;
      let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.target = ?`;
      joinParams.push(ref.target);
      if (ref.rel_type) {
        joinCond += ` AND ${alias}.rel_type = ?`;
        joinParams.push(ref.rel_type);
      }
      joins.push(joinCond);
    }

    if (dir === 'incoming' || dir === 'both') {
      if (!db) {
        throw new Error('db is required for incoming reference filter (resolveTarget lookup)');
      }
      // With resolved_target_id pre-populated on every relationship row
      // (see src/resolver/refresh.ts + startup backfill in src/index.ts),
      // the incoming branch is a single-key join — no variant IN-list needed.
      const resolved = resolveTarget(db, ref.target);
      if (!resolved) {
        whereClauses.push('1 = 0');
      } else {
        const alias = `r${joinIdx++}`;
        let joinCond = `INNER JOIN relationships ${alias} ON ${alias}.source_id = n.id AND ${alias}.resolved_target_id = ?`;
        joinParams.push(resolved.id);
        if (ref.rel_type) {
          joinCond += ` AND ${alias}.rel_type = ?`;
          joinParams.push(ref.rel_type);
        }
        joins.push(joinCond);
      }
    }
  }

  // Title filters
  if (filter.title_eq !== undefined) {
    whereClauses.push('n.title = ? COLLATE NOCASE');
    whereParams.push(filter.title_eq);
  }
  if (filter.title_contains !== undefined) {
    whereClauses.push('n.title LIKE ? COLLATE NOCASE');
    whereParams.push(`%${filter.title_contains}%`);
  }

  // Path prefix filter
  if (filter.path_prefix) {
    whereClauses.push('n.file_path LIKE ?');
    whereParams.push(`${filter.path_prefix}%`);
  }

  // Negation path prefix filter
  if (filter.without_path_prefix) {
    whereClauses.push('n.file_path NOT LIKE ?');
    whereParams.push(`${filter.without_path_prefix}%`);
  }

  // Exact directory filter (matches files whose immediate parent is the given dir)
  if (filter.path_dir !== undefined) {
    if (filter.path_dir === '' || filter.path_dir === '.') {
      whereClauses.push("n.file_path NOT LIKE '%/%'");
    } else {
      whereClauses.push('n.file_path LIKE ? AND n.file_path NOT LIKE ?');
      whereParams.push(`${filter.path_dir}/%`);
      whereParams.push(`${filter.path_dir}/%/%`);
    }
  }

  // Modified since filter
  if (filter.modified_since) {
    whereClauses.push('n.file_mtime >= ?');
    const ts = Math.floor(new Date(filter.modified_since).getTime() / 1000);
    whereParams.push(ts);
  }

  const joinSql = joins.join('\n');
  const whereSql = whereClauses.length > 0
    ? 'WHERE ' + whereClauses.join(' AND ')
    : '';

  // Params must match SQL placeholder order: all JOIN params first, then all WHERE params
  const params = [...joinParams, ...whereParams];

  const baseFrom = `FROM nodes n`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();

  return { sql, countSql, params };
}
