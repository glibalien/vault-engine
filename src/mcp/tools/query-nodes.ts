import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { ok, type Issue } from './errors.js';
import { buildNodeQuery } from '../query-builder.js';
import type { FieldFilter, NodeQueryFilter } from '../query-builder.js';
import { resolveFieldValue, type FieldRow } from '../field-value.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { Embedder } from '../../search/embedder.js';
import { hybridSearch } from '../../search/search.js';
import { QUERY_NODES_UI_RESOURCE_URI } from '../ui/query-nodes/register.js';

const fieldFilterSchema = z.object({
  eq: z.unknown().optional(),
  ne: z.unknown().optional(),
  gt: z.unknown().optional(),
  lt: z.unknown().optional(),
  gte: z.unknown().optional(),
  lte: z.unknown().optional(),
  contains: z.string().optional(),
  includes: z.unknown().optional(),
  one_of: z.array(z.unknown()).min(1).optional(),
  exists: z.boolean().optional(),
}).strict();

const referenceSchema = z.object({
  target: z.string(),
  rel_type: z.string().optional(),
  direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
});

const targetFilterSchema = z.object({
  node_ids: z.array(z.string()).optional(),
  without_node_ids: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), fieldFilterSchema).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  without_titles: z.array(z.string()).optional(),
  references: referenceSchema.optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  // NOT included: join_filters, without_joins (nested joins deferred)
}).strict();

const joinFilterSchema = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  rel_type: z.union([z.string(), z.array(z.string())]).optional(),
  target: targetFilterSchema.optional(),
}).strict().refine(
  (f) => f.rel_type !== undefined || f.target !== undefined,
  { message: 'INVALID_PARAMS: JoinFilter requires at least one of rel_type or target' },
);

const paramsShape = {
  node_ids: z.array(z.string()).optional(),
  without_node_ids: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), fieldFilterSchema).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  without_titles: z.array(z.string()).optional(),
  query: z.string().optional(),
  references: referenceSchema.optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  join_filters: z.array(joinFilterSchema).optional(),
  without_joins: z.array(joinFilterSchema).optional(),
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

type JoinFilterParam = {
  direction?: 'outgoing' | 'incoming';
  rel_type?: string | string[];
  target?: unknown;
};

function computeJoinWarning(
  db: Database.Database,
  joinFilters: JoinFilterParam[] | undefined,
  withoutJoins: JoinFilterParam[] | undefined,
): Issue | undefined {
  const needsCheck =
    (joinFilters?.some(f => f.target !== undefined) ?? false) ||
    (withoutJoins?.some(f => f.target !== undefined) ?? false);

  if (!needsCheck) return undefined;

  // Collect rel_types that appeared in filters-with-target; missing rel_type means "any".
  const relTypes = new Set<string>();
  let anyRelType = false;
  for (const f of [...(joinFilters ?? []), ...(withoutJoins ?? [])]) {
    if (f.target === undefined) continue;
    if (f.rel_type === undefined) { anyRelType = true; break; }
    const types = Array.isArray(f.rel_type) ? f.rel_type : [f.rel_type];
    for (const t of types) relTypes.add(t);
  }

  let sql = 'SELECT COUNT(*) AS n FROM relationships WHERE resolved_target_id IS NULL';
  const p: unknown[] = [];
  if (!anyRelType && relTypes.size > 0) {
    const placeholders = Array.from(relTypes, () => '?').join(', ');
    sql += ` AND rel_type IN (${placeholders})`;
    p.push(...relTypes);
  }
  const { n } = db.prepare(sql).get(...p) as { n: number };
  if (n > 0) {
    const edges = anyRelType ? ['(any rel_type)'] : Array.from(relTypes);
    return {
      code: 'CROSS_NODE_FILTER_UNRESOLVED',
      severity: 'warning',
      message: `Could not resolve cross-node filter edges: ${edges.join(', ')}`,
      details: { edges },
    };
  }
  return undefined;
}

/**
 * Validates that each field filter uses operators compatible with the field's
 * declared global type. Emits non-fatal warnings for common silent-mismatch
 * traps (e.g. `includes` on a scalar, `eq` on a list). Unknown fields are
 * skipped silently — they may be newly added ones not yet in global_fields.
 */
export function checkFieldOperators(
  db: Database.Database,
  fields: Record<string, FieldFilter> | undefined,
): Issue[] {
  if (!fields) return [];
  const names = Object.keys(fields);
  if (names.length === 0) return [];

  const placeholders = names.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT name, field_type FROM global_fields WHERE name IN (${placeholders})`)
    .all(...names) as Array<{ name: string; field_type: string }>;
  const typeMap = new Map(rows.map(r => [r.name, r.field_type]));

  const warnings: Issue[] = [];
  for (const [fieldName, ops] of Object.entries(fields)) {
    const fieldType = typeMap.get(fieldName);
    if (!fieldType) continue;
    for (const op of Object.keys(ops)) {
      const advice = opIncompatibility(op, fieldType);
      if (!advice) continue;
      warnings.push({
        code: 'FIELD_OPERATOR_MISMATCH',
        severity: 'warning',
        message: `Field '${fieldName}' has type '${fieldType}'. ${advice}`,
        field: fieldName,
        details: { field: fieldName, field_type: fieldType, operator: op },
      });
    }
  }
  return warnings;
}

function opIncompatibility(op: string, fieldType: string): string | undefined {
  const isList = fieldType === 'list';
  const isNumericOrDate = fieldType === 'number' || fieldType === 'date';
  if (op === 'includes' && !isList) {
    return `'includes' matches list elements; use 'eq' or 'one_of' on scalar fields.`;
  }
  if ((op === 'eq' || op === 'ne' || op === 'one_of') && isList) {
    return `'${op}' compares scalar values; use 'includes' to match list elements.`;
  }
  if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && !isNumericOrDate) {
    return `Comparison operators ('gt', 'gte', 'lt', 'lte') apply to number/date fields only.`;
  }
  return undefined;
}

export function registerQueryNodes(
  server: McpServer,
  db: Database.Database,
  _embeddingIndexer?: EmbeddingIndexer,
  embedder?: Embedder,
): void {
  registerAppTool(
    server,
    'query-nodes',
    {
      description:
    'Search and query nodes across the vault: semantic (vector) search, full-text search, and structured filters on identity, type, fields, references, path, date, and cross-node joins. Use the query param for hybrid ranked results combining FTS and semantic retrieval. Scores use Reciprocal Rank Fusion (RRF) — absolute values are not meaningful, only relative ordering matters. match_sources indicates retrieval method: "fts" (full-text match), "semantic" (vector/embedding match), or both. Returns paginated results. Use include_fields to return field values inline (e.g. ["project","status"] or ["*"] for all). When you know the exact title, prefer get-node with title param. For partial title matching, use title_contains. For exact title filtering combined with other constraints, use title_eq. Use without_node_ids or without_titles to exclude known keepers from broader filters. Cross-node filtering: join_filters narrows results to nodes linked to a target matching a nested filter; without_joins excludes them. Each filter has optional direction ("outgoing" default, or "incoming"), optional rel_type (string or array for OR), and optional target (nested NodeQueryFilter without its own join_filters). Example — open tasks whose linked project is done: {"types":["task"],"fields":{"status":{"eq":"open"}},"join_filters":[{"rel_type":"project","target":{"types":["project"],"fields":{"status":{"eq":"done"}}}}]}. Differs from references: references matches by identity (a specific target), join_filters matches by pattern (any node matching the target filter). When a join filter has a target, unresolved edges are invisible to it; a CROSS_NODE_FILTER_UNRESOLVED warning surfaces in the envelope warnings array if such edges existed and could have affected the answer.\n\nField operator cheatsheet (use describe-global-field if unsure of a field type):\n- scalar string / enum: eq, ne, one_of, exists\n- number / date: eq, ne, gt, gte, lt, lte, exists (dates are ISO 8601 strings)\n- list of strings / list of refs: includes (element match), exists\n- any field: contains (substring, searches both text and JSON values)\nNote: includes is for list fields only; on scalars it silently returns no rows. eq/ne on list fields likewise won\'t match. For reference fields, prefer the top-level `references:{target,rel_type}` filter over `includes` — it resolves title/path/id variants correctly.\n\nCommon query recipes:\n- Open tasks: {"types":["task"],"fields":{"status":{"eq":"open"}}}\n- Tasks with multiple statuses: {"types":["task"],"fields":{"status":{"one_of":["open","pending"]}}}\n- Tasks in project X: {"types":["task"],"references":{"target":"X","rel_type":"project"}}\n- Overdue tasks: {"types":["task"],"fields":{"due":{"lt":"2026-04-20"},"status":{"ne":"done"}}}\n- Tasks with no project: {"types":["task"],"without_fields":["project"]}\n- Recently modified notes: {"types":["note"],"modified_since":"2026-04-13"}',
      inputSchema: paramsShape,
      _meta: { ui: { resourceUri: QUERY_NODES_UI_RESOURCE_URI } },
    },
    async (params) => {
      const sortBy = params.sort_by ?? 'title';
      const sortOrder = params.sort_order ?? 'asc';
      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;
      const query = params.query;
      const includeFields = params.include_fields;

      const hasStructuredFilters = Boolean(
        params.types?.length ||
        params.node_ids?.length ||
        params.without_node_ids?.length ||
        params.without_types?.length ||
        params.fields ||
        params.without_fields?.length ||
        params.references ||
        params.title_eq ||
        params.title_contains ||
        params.without_titles?.length ||
        params.path_prefix ||
        params.without_path_prefix ||
        params.path_dir !== undefined ||
        params.modified_since ||
        params.join_filters?.length ||
        params.without_joins?.length,
      );

      // Hybrid search path: query present AND embedder available
      if (query && embedder) {
        let candidateIds: string[] | undefined;

        if (hasStructuredFilters) {
          const filter: NodeQueryFilter = {
            node_ids: params.node_ids,
            without_node_ids: params.without_node_ids,
            types: params.types,
            without_types: params.without_types,
            fields: params.fields as NodeQueryFilter['fields'],
            without_fields: params.without_fields,
            references: params.references,
            title_eq: params.title_eq,
            title_contains: params.title_contains,
            without_titles: params.without_titles,
            path_prefix: params.path_prefix,
            without_path_prefix: params.without_path_prefix,
            path_dir: params.path_dir,
            modified_since: params.modified_since,
            join_filters: params.join_filters as NodeQueryFilter['join_filters'],
            without_joins: params.without_joins as NodeQueryFilter['without_joins'],
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

        const warnings: Issue[] = [];
        warnings.push(...checkFieldOperators(db, params.fields as Record<string, FieldFilter> | undefined));
        const joinWarning = computeJoinWarning(db, params.join_filters, params.without_joins);
        if (joinWarning) warnings.push(joinWarning);
        return ok({ nodes, total }, warnings);
      }

      // Standard structured query path (no query param, or no embedder)
      const filter: NodeQueryFilter = {
        node_ids: params.node_ids,
        without_node_ids: params.without_node_ids,
        types: params.types,
        without_types: params.without_types,
        fields: params.fields as NodeQueryFilter['fields'],
        without_fields: params.without_fields,
        references: params.references,
        title_eq: params.title_eq,
        title_contains: params.title_contains,
        without_titles: params.without_titles,
        path_prefix: params.path_prefix,
        without_path_prefix: params.without_path_prefix,
        path_dir: params.path_dir,
        modified_since: params.modified_since,
        join_filters: params.join_filters as NodeQueryFilter['join_filters'],
        without_joins: params.without_joins as NodeQueryFilter['without_joins'],
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

      const warnings: Issue[] = [];
      warnings.push(...checkFieldOperators(db, params.fields as Record<string, FieldFilter> | undefined));
      const joinWarning = computeJoinWarning(db, params.join_filters, params.without_joins);
      if (joinWarning) warnings.push(joinWarning);
      return ok({ nodes, total }, warnings);
    },
  );
}
