import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';

interface TypeRow {
  type: string;
  count: number;
  has_schema: number;
  claim_count: number | null;
}

export function registerListTypes(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-types',
    'Returns all node types with their counts.',
    {},
    async () => {
      const types = db.prepare(
        `SELECT nt.schema_type as type,
                COUNT(*) as count,
                s.name IS NOT NULL as has_schema,
                CASE WHEN s.name IS NOT NULL
                  THEN (SELECT COUNT(*) FROM schema_field_claims WHERE schema_name = nt.schema_type)
                  ELSE NULL
                END as claim_count
         FROM node_types nt
         LEFT JOIN schemas s ON s.name = nt.schema_type
         GROUP BY nt.schema_type
         ORDER BY count DESC`
      ).all() as TypeRow[];

      return ok(types.map(t => ({
        type: t.type,
        count: t.count,
        has_schema: Boolean(t.has_schema),
        claim_count: t.claim_count,
      })));
    },
  );
}
