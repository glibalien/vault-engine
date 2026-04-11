import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { createGlobalField } from '../../global-fields/crud.js';
import { renderFieldsFile } from '../../schema/render.js';

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
      per_type_overrides_allowed: z.boolean().optional().describe('Whether schemas can override required/default_value'),
    },
    async (params) => {
      try {
        const result = createGlobalField(db, params);
        if (ctx?.vaultPath) renderFieldsFile(db, ctx.vaultPath);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
