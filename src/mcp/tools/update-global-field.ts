import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { updateGlobalField } from '../../global-fields/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../schema/render.js';
import { rerenderNodesWithField } from '../../schema/propagate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

const fieldTypeEnum = z.enum(['string', 'number', 'date', 'boolean', 'reference', 'enum', 'list']);

export function registerUpdateGlobalField(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger }): void {
  server.tool(
    'update-global-field',
    'Updates an existing global field definition. For type changes, omit confirm to preview impact; set confirm=true to apply.',
    {
      name: z.string().describe('Field name to update'),
      field_type: fieldTypeEnum.optional().describe('New field type (triggers type-change flow if different)'),
      enum_values: z.array(z.string()).optional().describe('New allowed values for enum fields'),
      reference_target: z.string().optional().describe('New target schema type for reference fields'),
      description: z.string().optional().describe('New description'),
      default_value: z.unknown().optional().describe('New default value'),
      required: z.boolean().optional().describe('New required flag'),
      list_item_type: fieldTypeEnum.optional().describe('New item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      confirm: z.boolean().optional().describe('Set true to apply a type change (otherwise previews impact)'),
    },
    async ({ name, ...rest }) => {
      try {
        const result = updateGlobalField(db, name, rest);

        if (ctx?.vaultPath) {
          renderFieldsFile(db, ctx.vaultPath);
          // Re-render schema files that have claims on this field
          const claimingSchemas = db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
            .all(name) as Array<{ schema_name: string }>;
          for (const { schema_name } of claimingSchemas) {
            renderSchemaFile(db, ctx.vaultPath, schema_name);
          }
          // If type change was confirmed, re-render affected nodes
          if (rest.confirm && rest.field_type && ctx.writeLock) {
            // Pass uncoercible node IDs so they get re-rendered even though
            // their node_fields rows for this field were deleted
            const uncoercibleIds = result.uncoercible?.map(u => u.node_id);
            const nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, name, uncoercibleIds, ctx.syncLogger);
            return ok({ ...result, nodes_rerendered });
          }
        }

        return ok(result);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
