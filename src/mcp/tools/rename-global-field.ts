import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join } from 'node:path';
import { ok, fail } from './errors.js';
import { renameGlobalField } from '../../global-fields/crud.js';
import { rerenderNodesWithField } from '../../schema/propagate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

export function registerRenameGlobalField(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger }): void {
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

        // Re-render affected nodes
        let nodes_rerendered = 0;
        if (ctx?.writeLock && ctx?.vaultPath) {
          nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, new_name, undefined, ctx.syncLogger);
        }

        return ok({ ...result, nodes_rerendered });
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
