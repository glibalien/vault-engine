import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';

export function registerListGlobalFields(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-global-fields',
    'Returns all global field definitions.',
    {},
    async () => {
      const fields = db.prepare(
        'SELECT name, field_type, description FROM global_fields ORDER BY name'
      ).all();

      return ok(fields);
    },
  );
}
