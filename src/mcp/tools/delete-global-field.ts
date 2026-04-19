import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { deleteGlobalField } from '../../global-fields/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../schema/render.js';

export function registerDeleteGlobalField(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'delete-global-field',
    'Deletes a global field definition. Removes schema claims but preserves node field values as orphans.',
    {
      name: z.string().describe('Field name to delete'),
    },
    async ({ name }) => {
      try {
        // Snapshot claiming schemas before deletion (for re-rendering)
        const claimingSchemas = ctx?.vaultPath
          ? (db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
              .all(name) as Array<{ schema_name: string }>).map(r => r.schema_name)
          : [];

        const result = deleteGlobalField(db, name);

        if (ctx?.vaultPath) {
          renderFieldsFile(db, ctx.vaultPath);
          for (const schema of claimingSchemas) {
            renderSchemaFile(db, ctx.vaultPath, schema);
          }
        }

        return ok(result);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
