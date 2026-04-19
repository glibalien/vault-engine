import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';
import type { ExtractorRegistry } from '../../extraction/registry.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';

export function registerVaultStats(server: McpServer, db: Database.Database, extractorRegistry?: ExtractorRegistry, embeddingIndexer?: EmbeddingIndexer): void {
  server.tool(
    'vault-stats',
    'Returns vault statistics: node counts, type counts, field count, relationship count, orphan count, schema count, and search index status.',
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
        `SELECT COUNT(*) as count FROM node_fields nf
         WHERE NOT EXISTS (
           SELECT 1 FROM node_types nt
           JOIN schema_field_claims sfc ON sfc.schema_name = nt.schema_type AND sfc.field = nf.field_name
           WHERE nt.node_id = nf.node_id
         )`
      ).get() as { count: number }).count;

      const schemaCount = (db.prepare(
        'SELECT COUNT(*) as count FROM schemas'
      ).get() as { count: number }).count;

      const undoActive = (db.prepare("SELECT COUNT(*) AS c FROM undo_operations WHERE status = 'active'").get() as { c: number }).c;
      // Approx byte size: sum of LENGTH on body + JSON columns.
      const undoBytes = (db.prepare(`
        SELECT COALESCE(SUM(
          IFNULL(LENGTH(body), 0) +
          IFNULL(LENGTH(types), 0) +
          IFNULL(LENGTH(fields), 0) +
          IFNULL(LENGTH(relationships), 0)
        ), 0) AS b FROM undo_snapshots
      `).get() as { b: number }).b;

      const resultObj: Record<string, unknown> = {
        node_count: nodeCount,
        type_counts: typeCounts,
        field_count: fieldCount,
        relationship_count: relationshipCount,
        orphan_count: orphanCount,
        schema_count: schemaCount,
        undo: {
          active_operations: undoActive,
          total_snapshot_bytes: undoBytes,
        },
      };

      if (extractorRegistry) {
        resultObj.extractors = extractorRegistry.getStatus();
      }

      if (embeddingIndexer) {
        resultObj.search_index = embeddingIndexer.getStatus();
      }

      return ok(resultObj);
    },
  );
}
