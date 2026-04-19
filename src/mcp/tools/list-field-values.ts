import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { listFieldValues } from '../../discovery/list-field-values.js';

export function registerListFieldValues(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-field-values',
    'Lists distinct values for a field across all nodes, with counts. Optionally filter by node types.',
    {
      field_name: z.string().describe('Field name to list values for'),
      types: z.array(z.string()).optional().describe('Filter to nodes with these types'),
      limit: z.number().optional().describe('Maximum number of distinct values to return (default 50)'),
    },
    async ({ field_name, types, limit }) => {
      try {
        const result = listFieldValues(db, field_name, { types, limit });
        return ok(result);
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
