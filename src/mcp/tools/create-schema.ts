import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { createSchemaDefinition } from '../../schema/crud.js';
import { renderSchemaFile } from '../../schema/render.js';

const fieldClaimSchema = z.object({
  field: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  sort_order: z.number().optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
  default_value_overridden: z.boolean().optional().describe('Set true when default_value key is present, even if null'),
  enum_values_override: z.array(z.string()).optional().describe('Per-type enum values (replaces global for this type)'),
});

export function registerCreateSchema(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'create-schema',
    'Creates a new schema definition with field claims. Referenced global fields must already exist.',
    {
      name: z.string().describe('Unique schema name (e.g. "project", "person")'),
      display_name: z.string().optional().describe('Human-friendly display name'),
      icon: z.string().optional().describe('Icon identifier for the schema'),
      filename_template: z.string().optional().describe('Template for generating filenames (name only, e.g. "{date} - {title}.md")'),
      default_directory: z.string().optional().describe('Default directory for new files of this type (e.g. "Persons")'),
      field_claims: z.array(fieldClaimSchema).describe('Fields this schema claims from the global pool'),
      metadata: z.unknown().optional().describe('Arbitrary metadata'),
    },
    async (params) => {
      // Reserved prefix check
      if (params.name.startsWith('_')) {
        return toolErrorResult('INVALID_PARAMS', "Schema names starting with '_' are reserved for engine-managed files.");
      }

      try {
        const result = createSchemaDefinition(db, params);
        if (ctx?.vaultPath) renderSchemaFile(db, ctx.vaultPath, params.name);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
