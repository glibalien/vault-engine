import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';

interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
  ui_hints: string | null;
}

export function registerDescribeGlobalField(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-global-field',
    'Returns full details for a named global field.',
    { name: z.string().describe('Global field name') },
    async ({ name }) => {
      const row = db.prepare('SELECT * FROM global_fields WHERE name = ?').get(name) as
        GlobalFieldRow | undefined;

      if (!row) {
        return fail('NOT_FOUND', `Global field '${name}' not found`);
      }

      // Types that claim this field
      const claimed_by_types = (db.prepare(
        'SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?'
      ).all(name) as Array<{ schema_name: string }>).map(r => r.schema_name);

      // Total nodes with this field
      const nodeCountRow = db.prepare(
        'SELECT COUNT(DISTINCT node_id) as count FROM node_fields WHERE field_name = ?'
      ).get(name) as { count: number };

      // Orphan count: nodes with this field but no claiming type
      const orphanRow = db.prepare(
        `SELECT COUNT(DISTINCT nf.node_id) as count FROM node_fields nf
         WHERE nf.field_name = ?
         AND NOT EXISTS (
           SELECT 1 FROM node_types nt
           JOIN schema_field_claims sfc ON sfc.schema_name = nt.schema_type AND sfc.field = nf.field_name
           WHERE nt.node_id = nf.node_id
         )`
      ).get(name) as { count: number };

      return ok({
        name: row.name,
        field_type: row.field_type,
        enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
        reference_target: row.reference_target,
        description: row.description,
        default_value: row.default_value ? JSON.parse(row.default_value) : null,
        required: Boolean(row.required),
        overrides_allowed: {
          required: Boolean(row.overrides_allowed_required),
          default_value: Boolean(row.overrides_allowed_default_value),
          enum_values: Boolean(row.overrides_allowed_enum_values),
        },
        list_item_type: row.list_item_type,
        ui: row.ui_hints !== null ? JSON.parse(row.ui_hints) : null,
        claimed_by_types,
        node_count: nodeCountRow.count,
        orphan_count: orphanRow.count,
      });
    },
  );
}
