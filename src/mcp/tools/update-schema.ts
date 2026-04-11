import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { updateSchemaDefinition } from '../../schema/crud.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
});

export function registerUpdateSchema(server: McpServer, db: Database.Database): void {
  server.tool(
    'update-schema',
    'Updates an existing schema definition. If field_claims is provided, it replaces all existing claims.',
    {
      name: z.string().describe('Schema name to update'),
      display_name: z.string().optional().describe('New display name'),
      icon: z.string().optional().describe('New icon identifier'),
      filename_template: z.string().optional().describe('New filename template'),
      field_claims: z.array(fieldClaimSchema).optional().describe('New field claims (replaces existing)'),
      metadata: z.unknown().optional().describe('New metadata'),
    },
    async ({ name, ...rest }) => {
      try {
        const result = updateSchemaDefinition(db, name, rest);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
