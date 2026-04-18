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

export interface JoinFilter {
  direction?: 'outgoing' | 'incoming';
  rel_type?: string | string[];
  target?: NodeQueryFilter;
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
  join_filters?: JoinFilter[];
  without_joins?: JoinFilter[];
}

export interface NodeQueryResult {
  sql: string;
  countSql: string;
  params: unknown[];
}

export interface FilterClauses {
  joins: string[];
  joinParams: unknown[];
  whereClauses: string[];
  whereParams: unknown[];
}

/**
 * Compiles a NodeQueryFilter into JOINs and WHEREs at a given alias.
 * Used by buildNodeQuery for the outer `n`, and recursively by
 * buildJoinExistsClauses for target nodes (aliased `tN`).
 *
 * The `idx` counter is passed by reference (via object wrapper) so nested
 * invocations don't collide on alias names. Generated aliases get a
 * `_${alias}` suffix so outer `t0_n` and inner `t0_t0_n` don't collide.
 *
 * NOTE: This helper does NOT handle `filter.join_filters` or
 * `filter.without_joins` — those are composed by the caller
 * (`buildNodeQuery`) at the outer level only.
 */
export function buildFilterClauses(
  filter: NodeQueryFilter,
  alias: string,
  idx: { n: number },
  db?: Database.Database,
): FilterClauses {
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  // Type filter (intersection: node must have ALL specified types)
  if (filter.types && filter.types.length > 0) {
    for (const t of filter.types) {
      const a = `t${idx.n++}_${alias}`;
      joins.push(`INNER JOIN node_types ${a} ON ${a}.node_id = ${alias}.id AND ${a}.schema_type = ?`);
      joinParams.push(t);
    }
  }

  // Negation type filter (node must NOT have any of the specified types)
  if (filter.without_types && filter.without_types.length > 0) {
    for (const t of filter.without_types) {
      whereClauses.push(`${alias}.id NOT IN (SELECT node_id FROM node_types WHERE schema_type = ?)`);
      whereParams.push(t);
    }
  }

  // Field filters
  if (filter.fields) {
    for (const [fieldName, ops] of Object.entries(filter.fields)) {
      const a = `f${idx.n++}_${alias}`;

      // Check for exists: false (LEFT JOIN + IS NULL pattern)
      if ('exists' in ops && ops.exists === false) {
        joins.push(`LEFT JOIN node_fields ${a} ON ${a}.node_id = ${alias}.id AND ${a}.field_name = ?`);
        joinParams.push(fieldName);
        whereClauses.push(`${a}.node_id IS NULL`);
        continue;
      }

      // Normal: INNER JOIN
      joins.push(`INNER JOIN node_fields ${a} ON ${a}.node_id = ${alias}.id AND ${a}.field_name = ?`);
      joinParams.push(fieldName);

      for (const [op, value] of Object.entries(ops)) {
        if (op === 'exists') {
          // exists: true is handled by the INNER JOIN itself
          continue;
        }
        if (op === 'contains') {
          // Search both value_text (scalar strings) and value_json (arrays/objects)
          whereClauses.push(`(${a}.value_text LIKE ? OR ${a}.value_json LIKE ?)`);
          whereParams.push(`%${value}%`, `%${value}%`);
        } else if (op === 'includes') {
          // Array membership: check if value_json (a JSON array) contains the given element
          whereClauses.push(
            `EXISTS (SELECT 1 FROM json_each(${a}.value_json) WHERE json_each.value = ?)`
          );
          whereParams.push(value);
        } else if (op === 'eq') {
          if (typeof value === 'number') {
            whereClauses.push(`${a}.value_number = ?`);
          } else {
            whereClauses.push(`${a}.value_text = ?`);
          }
          whereParams.push(value);
        } else if (op === 'ne') {
          if (typeof value === 'number') {
            whereClauses.push(`${a}.value_number != ?`);
          } else {
            whereClauses.push(`${a}.value_text != ?`);
          }
          whereParams.push(value);
        } else if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
          const sqlOp = op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
          if (typeof value === 'number') {
            whereClauses.push(`${a}.value_number ${sqlOp} ?`);
          } else {
            // ISO date strings sort lexicographically in value_text
            whereClauses.push(`${a}.value_text ${sqlOp} ?`);
          }
          whereParams.push(value);
        }
      }
    }
  }

  // Negation field filter (node must NOT have any of the specified field names)
  if (filter.without_fields && filter.without_fields.length > 0) {
    for (const fieldName of filter.without_fields) {
      whereClauses.push(`${alias}.id NOT IN (SELECT node_id FROM node_fields WHERE field_name = ?)`);
      whereParams.push(fieldName);
    }
  }

  // Reference filter
  if (filter.references) {
    const ref = filter.references;
    const dir = ref.direction ?? 'outgoing';

    if (dir === 'outgoing' || dir === 'both') {
      const a = `r${idx.n++}_${alias}`;
      let joinCond = `INNER JOIN relationships ${a} ON ${a}.source_id = ${alias}.id AND ${a}.target = ?`;
      joinParams.push(ref.target);
      if (ref.rel_type) {
        joinCond += ` AND ${a}.rel_type = ?`;
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
        const a = `r${idx.n++}_${alias}`;
        let joinCond = `INNER JOIN relationships ${a} ON ${a}.source_id = ${alias}.id AND ${a}.resolved_target_id = ?`;
        joinParams.push(resolved.id);
        if (ref.rel_type) {
          joinCond += ` AND ${a}.rel_type = ?`;
          joinParams.push(ref.rel_type);
        }
        joins.push(joinCond);
      }
    }
  }

  // Title filters
  if (filter.title_eq !== undefined) {
    whereClauses.push(`${alias}.title = ? COLLATE NOCASE`);
    whereParams.push(filter.title_eq);
  }
  if (filter.title_contains !== undefined) {
    whereClauses.push(`${alias}.title LIKE ? COLLATE NOCASE`);
    whereParams.push(`%${filter.title_contains}%`);
  }

  // Path prefix filter
  if (filter.path_prefix) {
    whereClauses.push(`${alias}.file_path LIKE ?`);
    whereParams.push(`${filter.path_prefix}%`);
  }

  // Negation path prefix filter
  if (filter.without_path_prefix) {
    whereClauses.push(`${alias}.file_path NOT LIKE ?`);
    whereParams.push(`${filter.without_path_prefix}%`);
  }

  // Exact directory filter (matches files whose immediate parent is the given dir)
  if (filter.path_dir !== undefined) {
    if (filter.path_dir === '' || filter.path_dir === '.') {
      whereClauses.push(`${alias}.file_path NOT LIKE '%/%'`);
    } else {
      whereClauses.push(`${alias}.file_path LIKE ? AND ${alias}.file_path NOT LIKE ?`);
      whereParams.push(`${filter.path_dir}/%`);
      whereParams.push(`${filter.path_dir}/%/%`);
    }
  }

  // Modified since filter
  if (filter.modified_since) {
    whereClauses.push(`${alias}.file_mtime >= ?`);
    const ts = Math.floor(new Date(filter.modified_since).getTime() / 1000);
    whereParams.push(ts);
  }

  return { joins, joinParams, whereClauses, whereParams };
}

/**
 * Compiles JoinFilter[] into EXISTS (or NOT EXISTS) subqueries on relationships.
 *
 * Each join filter becomes a correlated subquery against `relationships rN`
 * joined (optionally) to `nodes tN`, where tN is the target node. The target's
 * own NodeQueryFilter is compiled recursively via buildFilterClauses at the
 * tN alias, so arbitrarily nested cross-node predicates are supported.
 *
 * Semantics:
 *   - direction='outgoing' (default): rN.source_id = parent.id
 *   - direction='incoming':           rN.resolved_target_id = parent.id
 *   - Unresolved edges (resolved_target_id IS NULL) are invisible to join filters.
 *   - rel_type: string => `= ?`, string[] => `IN (?, ?, ...)`.
 *   - target is optional; if absent, we only check edge existence.
 *   - Rejects empty JoinFilter (neither rel_type nor target) with INVALID_PARAMS.
 */
function buildJoinExistsClauses(
  filters: JoinFilter[] | undefined,
  parentAlias: string,
  idx: { n: number },
  db: Database.Database | undefined,
  negated: boolean,
): { whereClauses: string[]; whereParams: unknown[] } {
  if (!filters || filters.length === 0) {
    return { whereClauses: [], whereParams: [] };
  }
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  for (const filter of filters) {
    if (!filter.rel_type && !filter.target) {
      throw new Error('INVALID_PARAMS: JoinFilter requires at least one of rel_type or target');
    }

    const direction = filter.direction ?? 'outgoing';
    const relAlias = `r${idx.n++}_${parentAlias}`;
    const targetAlias = `t${idx.n++}_${parentAlias}`;

    const outerCol = direction === 'outgoing' ? 'source_id' : 'resolved_target_id';
    const innerJoinCol = direction === 'outgoing' ? 'resolved_target_id' : 'source_id';

    const subJoins: string[] = [];
    const subJoinParams: unknown[] = [];
    const subWheres: string[] = [
      `${relAlias}.${outerCol} = ${parentAlias}.id`,
      `${relAlias}.resolved_target_id IS NOT NULL`,
    ];
    const subWhereParams: unknown[] = [];

    if (filter.rel_type) {
      const types = Array.isArray(filter.rel_type) ? filter.rel_type : [filter.rel_type];
      if (types.length === 1) {
        subWheres.push(`${relAlias}.rel_type = ?`);
        subWhereParams.push(types[0]);
      } else {
        subWheres.push(`${relAlias}.rel_type IN (${types.map(() => '?').join(', ')})`);
        subWhereParams.push(...types);
      }
    }

    // Build target's own clauses (recursive) at targetAlias.
    let innerJoin = '';
    if (filter.target) {
      innerJoin = `INNER JOIN nodes ${targetAlias} ON ${targetAlias}.id = ${relAlias}.${innerJoinCol}`;
      const targetClauses = buildFilterClauses(filter.target, targetAlias, idx, db);
      subJoins.push(...targetClauses.joins);
      subJoinParams.push(...targetClauses.joinParams);
      subWheres.push(...targetClauses.whereClauses);
      subWhereParams.push(...targetClauses.whereParams);
    }

    const existsSql =
      `SELECT 1 FROM relationships ${relAlias}` +
      (innerJoin ? ` ${innerJoin}` : '') +
      (subJoins.length ? ' ' + subJoins.join(' ') : '') +
      ' WHERE ' + subWheres.join(' AND ');

    whereClauses.push(`${negated ? 'NOT EXISTS' : 'EXISTS'} (${existsSql})`);
    // Within the EXISTS subquery, SQL placeholders appear in order:
    //   1. INNER JOIN nodes tN (no params)
    //   2. target's JOIN clauses (subJoinParams)
    //   3. WHERE clauses (subWhereParams)
    whereParams.push(...subJoinParams, ...subWhereParams);
  }

  return { whereClauses, whereParams };
}

export function buildNodeQuery(filter: NodeQueryFilter, db?: Database.Database): NodeQueryResult {
  const idx = { n: 0 };
  const base = buildFilterClauses(filter, 'n', idx, db);

  const joinsFilterClauses = buildJoinExistsClauses(filter.join_filters, 'n', idx, db, false);
  const withoutJoinsClauses = buildJoinExistsClauses(filter.without_joins, 'n', idx, db, true);

  const joins = base.joins;
  const joinParams = base.joinParams;
  const whereClauses = [
    ...base.whereClauses,
    ...joinsFilterClauses.whereClauses,
    ...withoutJoinsClauses.whereClauses,
  ];
  const whereParams = [
    ...base.whereParams,
    ...joinsFilterClauses.whereParams,
    ...withoutJoinsClauses.whereParams,
  ];

  const joinSql = joins.join('\n');
  const whereSql = whereClauses.length > 0
    ? 'WHERE ' + whereClauses.join(' AND ')
    : '';

  // Params must match SQL placeholder order: all outer JOIN params first, then all WHERE params
  // (EXISTS subquery params are included in whereParams since the EXISTS predicate is in WHERE).
  const params = [...joinParams, ...whereParams];

  const baseFrom = `FROM nodes n`;
  const countSql = `SELECT COUNT(DISTINCT n.id) as total ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body ${baseFrom} ${joinSql} ${whereSql}`.trimEnd();

  return { sql, countSql, params };
}
