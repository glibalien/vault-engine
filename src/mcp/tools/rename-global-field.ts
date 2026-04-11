import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { renameGlobalField } from '../../global-fields/crud.js';

export function registerRenameGlobalField(server: McpServer, db: Database.Database): void {
  server.tool(
    'rename-global-field',
    'Renames a global field, updating all schema claims and node field values.',
    {
      old_name: z.string().describe('Current field name'),
      new_name: z.string().describe('New field name'),
    },
    async ({ old_name, new_name }) => {
      try {
        const result = renameGlobalField(db, old_name, new_name);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
