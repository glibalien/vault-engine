import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { deleteGlobalField } from '../../global-fields/crud.js';

export function registerDeleteGlobalField(server: McpServer, db: Database.Database): void {
  server.tool(
    'delete-global-field',
    'Deletes a global field definition. Removes schema claims but preserves node field values as orphans.',
    {
      name: z.string().describe('Field name to delete'),
    },
    async ({ name }) => {
      try {
        const result = deleteGlobalField(db, name);
        return toolResult(result);
      } catch (err) {
        return toolErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
