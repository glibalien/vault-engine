import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { toolResult } from './errors.js';

export function registerVaultStats(server: McpServer, db: Database.Database): void {
  server.tool(
    'vault-stats',
    'Returns vault statistics: node counts, type counts, field count, relationship count, orphan count, schema count.',
    {},
    async () => {
      const nodeCount = (db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count;

      const typeCounts = db.prepare(
        'SELECT schema_type as type, COUNT(*) as count FROM node_types GROUP BY schema_type ORDER BY count DESC'
      ).all() as Array<{ type: string; count: number }>;

      const fieldCount = (db.prepare(
        'SELECT COUNT(DISTINCT field_name) as count FROM node_fields'
      ).get() as { count: number }).count;

      const relationshipCount = (db.prepare(
        'SELECT COUNT(*) as count FROM relationships'
      ).get() as { count: number }).count;

      const orphanCount = (db.prepare(
        "SELECT COUNT(*) as count FROM node_fields WHERE source = 'orphan'"
      ).get() as { count: number }).count;

      const schemaCount = (db.prepare(
        'SELECT COUNT(*) as count FROM schemas'
      ).get() as { count: number }).count;

      return toolResult({
        node_count: nodeCount,
        type_counts: typeCounts,
        field_count: fieldCount,
        relationship_count: relationshipCount,
        orphan_count: orphanCount,
        schema_count: schemaCount,
      });
    },
  );
}
