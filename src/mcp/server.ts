// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getAllSchemas, getSchema } from '../schema/loader.js';
import { mergeSchemaFields } from '../schema/merger.js';
import { validateNode } from '../schema/validator.js';
import type { FieldEntry, FieldValueType } from '../parser/types.js';

export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });

  // Shared helper: hydrate node rows with types and fields
  function hydrateNodes(
    nodeRows: Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>,
    opts?: { includeContentMd?: boolean },
  ) {
    if (nodeRows.length === 0) return [];

    const nodeIds = nodeRows.map(r => r.id);
    const placeholders = nodeIds.map(() => '?').join(',');

    const typeRows = db.prepare(
      `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;

    const fieldRows = db.prepare(
      `SELECT node_id, key, value_text FROM fields WHERE node_id IN (${placeholders})`
    ).all(...nodeIds) as Array<{ node_id: string; key: string; value_text: string }>;

    const typesMap = new Map<string, string[]>();
    for (const row of typeRows) {
      const arr = typesMap.get(row.node_id) ?? [];
      arr.push(row.schema_type);
      typesMap.set(row.node_id, arr);
    }

    const fieldsMap = new Map<string, Record<string, string>>();
    for (const row of fieldRows) {
      const rec = fieldsMap.get(row.node_id) ?? {};
      rec[row.key] = row.value_text;
      fieldsMap.set(row.node_id, rec);
    }

    return nodeRows.map(row => {
      const node: Record<string, unknown> = {
        id: row.id,
        file_path: row.file_path,
        node_type: row.node_type,
        types: typesMap.get(row.id) ?? [],
        fields: fieldsMap.get(row.id) ?? {},
        content_text: row.content_text,
        updated_at: row.updated_at,
      };
      if (opts?.includeContentMd) {
        node.content_md = row.content_md;
      }
      return node;
    });
  }

  function loadNodeForValidation(nodeId: string): { types: string[]; fields: FieldEntry[] } | null {
    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as { id: string } | undefined;
    if (!node) return null;

    const typeRows = db.prepare(
      'SELECT schema_type FROM node_types WHERE node_id = ?'
    ).all(nodeId) as Array<{ schema_type: string }>;
    const types = typeRows.map(r => r.schema_type);

    const fieldRows = db.prepare(
      'SELECT key, value_text, value_type, value_number, value_date FROM fields WHERE node_id = ?'
    ).all(nodeId) as Array<{ key: string; value_text: string; value_type: string; value_number: number | null; value_date: string | null }>;

    const fields: FieldEntry[] = fieldRows.map(r => {
      let value: unknown = r.value_text;
      const valueType = r.value_type as FieldValueType;
      if (valueType === 'number' && r.value_number !== null) value = r.value_number;
      else if (valueType === 'date' && r.value_date) value = new Date(r.value_date);
      else if (valueType === 'list' && r.value_text) {
        try { value = JSON.parse(r.value_text); } catch { /* keep as string */ }
      }
      return { key: r.key, value, valueType };
    });

    return { types, fields };
  }

  function inferFieldType(value: unknown): FieldValueType {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (value instanceof Date) return 'date';
    if (Array.isArray(value)) return 'list';
    if (typeof value === 'string' && /^\[\[.+\]\]$/.test(value)) return 'reference';
    return 'string';
  }

  server.tool(
    'list-types',
    'List all node types found in the vault with their counts',
    {},
    async () => {
      const rows = db.prepare(`
        SELECT schema_type AS name, COUNT(*) AS count
        FROM node_types
        GROUP BY schema_type
        ORDER BY schema_type
      `).all() as Array<{ name: string; count: number }>;

      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    },
  );

  server.tool(
    'get-node',
    'Get full details of a specific node by its ID (vault-relative file path)',
    {
      node_id: z.string().describe('Vault-relative file path, e.g. "tasks/review.md"'),
      include_relationships: z.boolean().optional().default(false)
        .describe('Include incoming and outgoing relationships'),
    },
    async ({ node_id, include_relationships }) => {
      const row = db.prepare(`
        SELECT id, file_path, node_type, content_text, content_md, updated_at
        FROM nodes WHERE id = ?
      `).get(node_id) as { id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string } | undefined;

      if (!row) {
        return {
          content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
          isError: true,
        };
      }

      const [node] = hydrateNodes([row], { includeContentMd: true });

      if (include_relationships) {
        const rels = db.prepare(`
          SELECT source_id, target_id, rel_type, context
          FROM relationships
          WHERE source_id = ? OR target_id = ?
        `).all(node_id, node_id) as Array<{ source_id: string; target_id: string; rel_type: string; context: string | null }>;

        (node as Record<string, unknown>).relationships = rels;
      }

      return { content: [{ type: 'text', text: JSON.stringify(node) }] };
    },
  );

  server.tool(
    'get-recent',
    'Get recently created or modified nodes',
    {
      schema_type: z.string().optional()
        .describe('Filter by schema type, e.g. "task", "meeting"'),
      since: z.string().optional()
        .describe('ISO date — only return nodes updated after this time'),
      limit: z.number().optional().default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({ schema_type, since, limit }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let joinType = '';

      if (schema_type) {
        joinType = 'JOIN node_types nt ON nt.node_id = n.id';
        conditions.push('nt.schema_type = ?');
        params.push(schema_type);
      }

      if (since) {
        conditions.push('n.updated_at > ?');
        params.push(since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const rows = db.prepare(`
        SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at
        FROM nodes n
        ${joinType}
        ${where}
        ORDER BY n.updated_at DESC
        LIMIT ?
      `).all(...params) as Array<{ id: string; file_path: string; node_type: string; content_text: string; content_md: string | null; updated_at: string }>;

      const nodes = hydrateNodes(rows);
      return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
    },
  );

  server.tool(
    'query-nodes',
    'Search for nodes by type, field values, and/or full text. At least one of schema_type, full_text, or filters is required.',
    {
      schema_type: z.string().optional()
        .describe('Schema type to filter by, e.g. "task", "project", "meeting"'),
      full_text: z.string().optional()
        .describe('Full-text search query (FTS5 syntax: supports "quoted phrases", prefix*, AND/OR)'),
      filters: z.array(z.object({
        field: z.string().describe('Field name, e.g. "status", "assignee"'),
        operator: z.enum(['eq']).describe('Comparison operator: eq (equals)'),
        value: z.string().describe('Value to compare against'),
      })).optional()
        .describe('Field equality filters'),
      limit: z.number().optional().default(20)
        .describe('Maximum number of results (default 20)'),
      order_by: z.string().optional()
        .describe('Sort field + direction, e.g. "updated_at DESC", "due_date ASC". Default: updated_at DESC (or FTS rank when full_text is used)'),
    },
    async ({ schema_type, full_text, filters, limit, order_by }) => {
      if (!schema_type && !full_text && (!filters || filters.length === 0)) {
        return {
          content: [{ type: 'text', text: 'Error: At least one of schema_type, full_text, or filters is required' }],
          isError: true,
        };
      }

      try {
        const joins: string[] = [];
        const conditions: string[] = [];
        const params: unknown[] = [];

        // FTS path
        let selectFrom: string;
        let defaultOrder: string;
        if (full_text) {
          selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at, fts.rank
            FROM nodes_fts fts
            JOIN nodes n ON n.rowid = fts.rowid`;
          conditions.push('nodes_fts MATCH ?');
          params.push(full_text);
          defaultOrder = 'fts.rank';
        } else {
          selectFrom = `
            SELECT n.id, n.file_path, n.node_type, n.content_text, n.content_md, n.updated_at
            FROM nodes n`;
          defaultOrder = 'n.updated_at DESC';
        }

        // Type filter
        if (schema_type) {
          joins.push('JOIN node_types nt ON nt.node_id = n.id');
          conditions.push('nt.schema_type = ?');
          params.push(schema_type);
        }

        // Field equality filters
        if (filters) {
          for (let i = 0; i < filters.length; i++) {
            const alias = `f${i}`;
            joins.push(`JOIN fields ${alias} ON ${alias}.node_id = n.id`);
            conditions.push(`${alias}.key = ? AND ${alias}.value_text = ?`);
            params.push(filters[i].field, filters[i].value);
          }
        }

        // Order by
        let orderClause: string;
        if (order_by && !full_text) {
          // Parse "field_name ASC" or "field_name DESC" or just "field_name"
          const parts = order_by.trim().split(/\s+/);
          const fieldName = parts[0];
          const direction = parts[1]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

          if (fieldName === 'updated_at') {
            orderClause = `n.updated_at ${direction}`;
          } else {
            // Order by a field value — join fields table
            joins.push('LEFT JOIN fields f_order ON f_order.node_id = n.id AND f_order.key = ?');
            params.push(fieldName);
            orderClause = `f_order.value_text ${direction}`;
          }
        } else {
          orderClause = defaultOrder;
        }

        params.push(limit);

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `${selectFrom}\n${joins.join('\n')}\n${where}\nORDER BY ${orderClause}\nLIMIT ?`;

        const rows = db.prepare(sql).all(...params) as Array<{
          id: string; file_path: string; node_type: string;
          content_text: string; content_md: string | null; updated_at: string;
        }>;

        const nodes = hydrateNodes(rows);
        return { content: [{ type: 'text', text: JSON.stringify(nodes) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list-schemas',
    'List all schema definitions loaded from YAML. Shows what structure is defined, as opposed to list-types which shows what types nodes actually have.',
    {},
    async () => {
      const schemas = getAllSchemas(db);
      const summaries = schemas.map(s => ({
        name: s.name,
        display_name: s.display_name ?? null,
        icon: s.icon ?? null,
        extends: s.extends ?? null,
        ancestors: s.ancestors,
        field_count: Object.keys(s.fields).length,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summaries) }] };
    },
  );

  server.tool(
    'describe-schema',
    'Get the full definition of a schema including inherited fields, field types, and constraints',
    {
      schema_name: z.string().describe('Schema name, e.g. "task", "work-task"'),
    },
    async ({ schema_name }) => {
      const schema = getSchema(db, schema_name);
      if (!schema) {
        return {
          content: [{ type: 'text', text: `Error: Schema not found: ${schema_name}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(schema) }] };
    },
  );

  server.tool(
    'validate-node',
    'Validate a node against its schemas. Provide node_id for an existing node, or types + fields for hypothetical validation.',
    {
      node_id: z.string().optional()
        .describe('Validate an existing node by its ID (vault-relative path)'),
      types: z.array(z.string()).optional()
        .describe('Schema types for hypothetical validation, e.g. ["task", "meeting"]'),
      fields: z.record(z.unknown()).optional()
        .describe('Field values for hypothetical validation, e.g. { "status": "todo" }'),
    },
    async ({ node_id, types, fields: hypotheticalFields }) => {
      if (!node_id && !types) {
        return {
          content: [{ type: 'text', text: 'Error: Provide node_id or types (with optional fields)' }],
          isError: true,
        };
      }

      let nodeTypes: string[];
      let fieldEntries: FieldEntry[];

      if (node_id) {
        const loaded = loadNodeForValidation(node_id);
        if (!loaded) {
          return {
            content: [{ type: 'text', text: `Error: Node not found: ${node_id}` }],
            isError: true,
          };
        }
        nodeTypes = loaded.types;
        fieldEntries = loaded.fields;
      } else {
        nodeTypes = types!;
        fieldEntries = Object.entries(hypotheticalFields ?? {}).map(([key, value]) => ({
          key,
          value,
          valueType: inferFieldType(value),
        }));
      }

      // If no types have schemas, nothing to validate
      const hasKnownSchema = nodeTypes.some(t =>
        db.prepare('SELECT 1 FROM schemas WHERE name = ?').get(t) !== undefined
      );
      if (!hasKnownSchema) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ valid: true, warnings: [] }) }],
        };
      }

      const merge = mergeSchemaFields(db, nodeTypes);
      const parsed = {
        filePath: node_id ?? 'hypothetical',
        frontmatter: {},
        types: nodeTypes,
        fields: fieldEntries,
        wikiLinks: [],
        mdast: { type: 'root' as const, children: [] },
        contentText: '',
        contentMd: '',
      };
      const result = validateNode(parsed, merge);

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}
