import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { inferFieldType } from '../../discovery/infer-field-type.js';

export function registerInferFieldType(server: McpServer, db: Database.Database): void {
  server.tool(
    'infer-field-type',
    'Analyzes existing node field values to propose a field type. Works whether or not a global field definition exists.',
    {
      field_name: z.string().describe('Field name to analyze'),
    },
    async ({ field_name }) => {
      try {
        const result = inferFieldType(db, field_name);
        return ok(result);
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
