import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';

export function registerListSchemas(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-schemas',
    'Returns all registered schemas, including filename_template and default_directory so callers can route nodes to each type\'s conventional folder.',
    {},
    async () => {
      const schemas = db.prepare(
        'SELECT name, display_name, icon, filename_template, default_directory FROM schemas ORDER BY name'
      ).all();

      return ok(schemas);
    },
  );
}
