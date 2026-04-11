import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { createSchemaDefinition } from '../../schema/crud.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
});

export function registerCreateSchema(server: McpServer, db: Database.Database): void {
  server.tool(
    'create-schema',
    'Creates a new schema definition with field claims. Referenced global fields must already exist.',
    {
      name: z.string().describe('Unique schema name (e.g. "project", "person")'),
      display_name: z.string().optional().describe('Human-friendly display name'),
      icon: z.string().optional().describe('Icon identifier for the schema'),
      filename_template: z.string().optional().describe('Template for generating filenames'),
      field_claims: z.array(fieldClaimSchema).describe('Fields this schema claims from the global pool'),
      metadata: z.unknown().optional().describe('Arbitrary metadata'),
    },
    async (params) => {
      try {
        const result = createSchemaDefinition(db, params);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
