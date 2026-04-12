import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { updateSchemaDefinition } from '../../schema/crud.js';
import { diffClaims, propagateSchemaChange } from '../../schema/propagate.js';
import { renderSchemaFile } from '../../schema/render.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
});

export function registerUpdateSchema(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string }): void {
  server.tool(
    'update-schema',
    'Updates an existing schema definition. If field_claims is provided, it replaces all existing claims.',
    {
      name: z.string().describe('Schema name to update'),
      display_name: z.string().optional().describe('New display name'),
      icon: z.string().optional().describe('New icon identifier'),
      filename_template: z.string().optional().describe('New filename template (name only, e.g. "{date} - {title}.md")'),
      default_directory: z.string().optional().describe('New default directory for files of this type'),
      field_claims: z.array(fieldClaimSchema).optional().describe('New field claims (replaces existing)'),
      metadata: z.unknown().optional().describe('New metadata'),
    },
    async ({ name, ...rest }) => {
      try {
        // Snapshot old claims before update (for propagation diff)
        let oldClaims: Array<{ field: string; sort_order?: number; label?: string; description?: string; required?: boolean | null; default_value?: unknown }> = [];
        if (rest.field_claims && ctx?.writeLock && ctx?.vaultPath) {
          const rows = db.prepare('SELECT field, sort_order, label, description, required, default_value FROM schema_field_claims WHERE schema_name = ?')
            .all(name) as Array<{ field: string; sort_order: number; label: string | null; description: string | null; required: number | null; default_value: string | null }>;
          oldClaims = rows.map(r => ({
            field: r.field,
            sort_order: r.sort_order,
            label: r.label ?? undefined,
            description: r.description ?? undefined,
            required: r.required !== null ? r.required === 1 : null,
            default_value: r.default_value !== null ? JSON.parse(r.default_value) : null,
          }));
        }

        const result = updateSchemaDefinition(db, name, rest);

        // Propagate if claims changed and write context available
        let propagation;
        if (rest.field_claims && ctx?.writeLock && ctx?.vaultPath) {
          const newClaims = rest.field_claims.map(c => ({
            field: c.field,
            sort_order: c.sort_order,
            label: c.label,
            description: c.description,
            required: c.required ?? null,
            default_value: c.default_value ?? null,
          }));
          const diff = diffClaims(oldClaims, newClaims);
          propagation = propagateSchemaChange(db, ctx.writeLock, ctx.vaultPath, name, diff);
        }

        // Re-render schema YAML file
        if (ctx?.vaultPath) renderSchemaFile(db, ctx.vaultPath, name);

        return toolResult({ ...result, propagation });
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
