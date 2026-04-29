import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { renameGlobalField } from '../../global-fields/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../schema/render.js';
import { rerenderNodesWithField } from '../../schema/propagate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureGlobalFieldSnapshot } from '../../undo/global-field-snapshot.js';

export function registerRenameGlobalField(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger }): void {
  server.tool(
    'rename-global-field',
    'Renames a global field, updating all schema claims and node field values.',
    {
      old_name: z.string().describe('Current field name'),
      new_name: z.string().describe('New field name'),
    },
    async ({ old_name, new_name }) => {
      const operation_id = createOperation(db, {
        source_tool: 'rename-global-field',
        description: `rename-global-field: ${old_name} -> ${new_name}`,
      });
      try {
        let result: ReturnType<typeof renameGlobalField> | undefined;
        const tx = db.transaction(() => {
          captureGlobalFieldSnapshot(db, operation_id, new_name, { was_renamed_from: old_name });
          result = renameGlobalField(db, old_name, new_name);
        });
        tx();

        const claimingSchemas = ctx?.vaultPath
          ? (db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
            .all(new_name) as Array<{ schema_name: string }>).map(r => r.schema_name)
          : [];

        // Re-render affected nodes
        let nodes_rerendered = 0;
        if (ctx?.vaultPath) {
          renderFieldsFile(db, ctx.vaultPath);
          for (const schema of claimingSchemas) {
            renderSchemaFile(db, ctx.vaultPath, schema);
          }
        }
        if (ctx?.writeLock && ctx?.vaultPath) {
          nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, new_name, undefined, ctx.syncLogger);
        }

        return ok({ ...result!, operation_id, nodes_rerendered });
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}
