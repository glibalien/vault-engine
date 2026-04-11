import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';

export function registerListTypes(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-types',
    'Returns all node types with their counts.',
    {},
    async () => {
      const types = db.prepare(
        'SELECT schema_type as type, COUNT(*) as count FROM node_types GROUP BY schema_type ORDER BY count DESC'
      ).all() as Array<{ type: string; count: number }>;

      return toolResult(types);
    },
  );
}
