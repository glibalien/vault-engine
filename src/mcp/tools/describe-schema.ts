import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';

interface SchemaRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
}

interface ClaimRow {
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number | null;
  required: number | null;
  default_value: string | null;
}

interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  per_type_overrides_allowed: number;
  list_item_type: string | null;
}

interface CoverageRow {
  count: number;
}

interface OrphanRow {
  field_name: string;
  count: number;
}

export function registerDescribeSchema(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-schema',
    'Returns full details for a named schema.',
    { name: z.string().describe('Schema name') },
    async ({ name }) => {
      const row = db.prepare('SELECT name, display_name, icon, filename_template, default_directory, metadata FROM schemas WHERE name = ?')
        .get(name) as SchemaRow | undefined;

      if (!row) {
        return toolErrorResult('NOT_FOUND', `Schema '${name}' not found`);
      }

      // Read claims from schema_field_claims table
      const claims = db.prepare(
        'SELECT field, label, description, sort_order, required, default_value FROM schema_field_claims WHERE schema_name = ? ORDER BY sort_order ASC, field ASC'
      ).all(name) as ClaimRow[];

      // For each claim, inline the global field definition
      const globalFieldStmt = db.prepare('SELECT * FROM global_fields WHERE name = ?');
      const field_claims = claims.map(claim => {
        const gf = globalFieldStmt.get(claim.field) as GlobalFieldRow | undefined;
        return {
          field: claim.field,
          label: claim.label,
          description: claim.description,
          sort_order: claim.sort_order,
          required: claim.required === null ? null : Boolean(claim.required),
          default_value: claim.default_value ? JSON.parse(claim.default_value) : null,
          global_field: gf ? {
            field_type: gf.field_type,
            enum_values: gf.enum_values ? JSON.parse(gf.enum_values) : null,
            reference_target: gf.reference_target,
            description: gf.description,
            default_value: gf.default_value ? JSON.parse(gf.default_value) : null,
            required: Boolean(gf.required),
            per_type_overrides_allowed: Boolean(gf.per_type_overrides_allowed),
            list_item_type: gf.list_item_type,
          } : null,
        };
      });

      // Compute node_count
      const nodeCountRow = db.prepare(
        'SELECT COUNT(*) as count FROM node_types WHERE schema_type = ?'
      ).get(name) as { count: number };
      const node_count = nodeCountRow.count;

      // Compute field_coverage
      const coverageStmt = db.prepare(
        `SELECT COUNT(*) as count FROM node_fields nf
         JOIN node_types nt ON nt.node_id = nf.node_id AND nt.schema_type = ?
         WHERE nf.field_name = ?`
      );
      const field_coverage: Record<string, { have_value: number; total: number }> = {};
      for (const claim of claims) {
        const coverageRow = coverageStmt.get(name, claim.field) as CoverageRow;
        field_coverage[claim.field] = { have_value: coverageRow.count, total: node_count };
      }

      // Compute orphan_field_names
      const orphan_field_names = db.prepare(
        `SELECT nf.field_name, COUNT(*) as count
         FROM node_fields nf
         JOIN node_types nt ON nt.node_id = nf.node_id AND nt.schema_type = ?
         WHERE nf.field_name NOT IN (SELECT field FROM schema_field_claims WHERE schema_name = ?)
         GROUP BY nf.field_name
         ORDER BY count DESC`
      ).all(name, name) as OrphanRow[];

      return toolResult({
        name: row.name,
        display_name: row.display_name,
        icon: row.icon,
        filename_template: row.filename_template,
        default_directory: row.default_directory,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        field_claims,
        node_count,
        field_coverage,
        orphan_field_names: orphan_field_names.map(r => ({ field: r.field_name, count: r.count })),
      });
    },
  );
}
