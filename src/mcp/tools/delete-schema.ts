import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { deleteSchemaDefinition } from '../../schema/crud.js';
import { deleteSchemaFile } from '../../schema/render.js';

export function registerDeleteSchema(server: McpServer, db: Database.Database, ctx?: { vaultPath?: string }): void {
  server.tool(
    'delete-schema',
    'Deletes a schema definition and its field claims. Node types referencing this schema are not removed.',
    {
      name: z.string().describe('Schema name to delete'),
    },
    async ({ name }) => {
      try {
        const result = deleteSchemaDefinition(db, name);
        if (ctx?.vaultPath) deleteSchemaFile(db, ctx.vaultPath, name);
        return ok(result);
      } catch (err) {
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
