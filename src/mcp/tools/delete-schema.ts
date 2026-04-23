import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { deleteSchemaDefinition } from '../../schema/crud.js';
import { deleteSchemaFile } from '../../schema/render.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';

export function registerDeleteSchema(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'delete-schema',
    'Deletes a schema definition and its field claims. Node types referencing this schema are not removed.',
    {
      name: z.string().describe('Schema name to delete'),
    },
    async ({ name }) => {
      const operation_id = createOperation(db, {
        source_tool: 'delete-schema',
        description: `delete-schema: ${name}`,
      });

      try {
        let result: ReturnType<typeof deleteSchemaDefinition> | undefined;
        const tx = db.transaction(() => {
          captureSchemaSnapshot(db, operation_id, name, { was_deleted: true });
          result = deleteSchemaDefinition(db, name);
        });
        tx();

        db.prepare('UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?').run(operation_id);

        if (ctx?.vaultPath) deleteSchemaFile(db, ctx.vaultPath, name);
        return ok({ ...result!, operation_id });
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}
