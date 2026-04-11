import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';

export function registerDescribeSchema(server: McpServer, db: Database.Database): void {
  server.tool(
    'describe-schema',
    'Returns full details for a named schema.',
    { name: z.string().describe('Schema name') },
    async ({ name }) => {
      const row = db.prepare('SELECT * FROM schemas WHERE name = ?').get(name) as
        | { name: string; display_name: string | null; icon: string | null; filename_template: string | null; field_claims: string; metadata: string | null }
        | undefined;

      if (!row) {
        return toolErrorResult('NOT_FOUND', `Schema '${name}' not found`);
      }

      return toolResult({
        ...row,
        field_claims: JSON.parse(row.field_claims),
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      });
    },
  );
}
