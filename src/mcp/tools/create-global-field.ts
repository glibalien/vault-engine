import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { createGlobalField, definitionToWire } from '../../global-fields/crud.js';
import { renderFieldsFile } from '../../schema/render.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureGlobalFieldSnapshot } from '../../undo/global-field-snapshot.js';

const fieldTypeEnum = z.enum(['string', 'number', 'date', 'boolean', 'reference', 'enum', 'list']);

export function registerCreateGlobalField(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'create-global-field',
    'Creates a new global field definition in the field pool.',
    {
      name: z.string().describe('Unique field name'),
      field_type: fieldTypeEnum.describe('Field type'),
      enum_values: z.array(z.string()).optional().describe('Allowed values (required when field_type is enum)'),
      reference_target: z.string().optional().describe('Target schema type for reference fields'),
      description: z.string().optional().describe('Human-readable description'),
      default_value: z.unknown().optional().describe('Default value for this field'),
      required: z.boolean().optional().describe('Whether this field is required by default'),
      list_item_type: fieldTypeEnum.optional().describe('Item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      ui: z.object({
        widget: z.enum(['text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags']).optional(),
        label: z.string().max(80).optional(),
        help: z.string().max(280).optional(),
        order: z.number().int().optional(),
      }).nullable().optional().describe('UI rendering hints (widget/label/help/order). Pass null or {} to clear.'),
    },
    async (params) => {
      const operation_id = createOperation(db, {
        source_tool: 'create-global-field',
        description: `create-global-field: ${params.name}`,
      });
      try {
        let result: ReturnType<typeof createGlobalField> | undefined;
        const tx = db.transaction(() => {
          captureGlobalFieldSnapshot(db, operation_id, params.name, { was_new: true });
          result = createGlobalField(db, params);
        });
        tx();

        if (ctx?.vaultPath) renderFieldsFile(db, ctx.vaultPath);
        return ok({ ...definitionToWire(result!), operation_id });
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}
