import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { updateGlobalField } from '../../global-fields/crud.js';

const fieldTypeEnum = z.enum(['string', 'number', 'date', 'boolean', 'reference', 'enum', 'list']);

export function registerUpdateGlobalField(server: McpServer, db: Database.Database): void {
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
      per_type_overrides_allowed: z.boolean().optional().describe('Whether schemas can override required/default_value'),
      confirm: z.boolean().optional().describe('Set true to apply a type change (otherwise previews impact)'),
    },
    async ({ name, ...rest }) => {
      try {
        const result = updateGlobalField(db, name, rest);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
