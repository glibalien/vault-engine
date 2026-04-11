import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';

export function registerDescribeGlobalField(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-global-field',
    'Returns full details for a named global field.',
    { name: z.string().describe('Global field name') },
    async ({ name }) => {
      const row = db.prepare('SELECT * FROM global_fields WHERE name = ?').get(name) as
        | { name: string; field_type: string; enum_values: string | null; reference_target: string | null; description: string | null; default_value: string | null }
        | undefined;

      if (!row) {
        return toolErrorResult('NOT_FOUND', `Global field '${name}' not found`);
      }

      return toolResult({
        ...row,
        enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
        default_value: row.default_value ? JSON.parse(row.default_value) : null,
      });
    },
  );
}
