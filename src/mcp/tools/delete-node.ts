// src/mcp/tools/delete-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { toolResult, toolErrorResult } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { refreshOnDelete } from '../../resolver/refresh.js';

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  confirm: z.boolean().default(false),
  referencing_nodes_limit: z.number().default(20),
};

export function registerDeleteNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'delete-node',
    'Delete a node and its file. Without confirm: true, returns a preview showing referencing nodes.',
    paramsShape,
    async (params) => {
      const resolved = resolveNodeIdentity(db, {
        node_id: params.node_id,
        file_path: params.file_path,
        title: params.title,
      });
      if (!resolved.ok) {
        return toolErrorResult(resolved.code, resolved.message);
      }
      const { node } = resolved;

      // Count relationships and find referencing nodes
      const outRels = (db.prepare('SELECT COUNT(*) as c FROM relationships WHERE source_id = ?').get(node.node_id) as { c: number }).c;

      const incomingRels = db.prepare(`
        SELECT r.source_id, n.title, r.rel_type
        FROM relationships r
        JOIN nodes n ON n.id = r.source_id
        WHERE r.target = ? OR r.target = ?
        LIMIT ?
      `).all(node.title, node.file_path, params.referencing_nodes_limit + 1) as Array<{
        source_id: string;
        title: string;
        rel_type: string;
      }>;

      const incomingCount = db.prepare(`
        SELECT COUNT(*) as c FROM relationships WHERE target = ? OR target = ?
      `).get(node.title, node.file_path) as { c: number };

      const fieldCount = (db.prepare('SELECT COUNT(*) as c FROM node_fields WHERE node_id = ?').get(node.node_id) as { c: number }).c;
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      if (!params.confirm) {
        return toolResult({
          preview: true,
          node_id: node.node_id,
          file_path: node.file_path,
          title: node.title,
          types,
          field_count: fieldCount,
          relationship_count: outRels,
          incoming_reference_count: incomingCount.c,
          referencing_nodes: incomingRels.slice(0, params.referencing_nodes_limit).map(r => ({
            node_id: r.source_id,
            title: r.title,
            field: r.rel_type,
          })),
          warning: incomingCount.c > 0 ? `${incomingCount.c} other node(s) reference this node. Deleting will create dangling references.` : null,
        });
      }

      // Confirmed deletion
      const absPath = safeVaultPath(vaultPath, node.file_path);

      writeLock.withLockSync(absPath, () => {
        const txn = db.transaction(() => {
          // Delete FTS
          const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(node.node_id) as { rowid: number } | undefined;
          if (rowInfo) {
            db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowInfo.rowid);
          }
          // Log
          db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
            node.node_id, Date.now(), 'file-deleted', node.file_path,
          );
          // Delete node (CASCADE handles node_fields, node_types, relationships)
          db.prepare('DELETE FROM nodes WHERE id = ?').run(node.node_id);
        });
        txn();

        refreshOnDelete(db, node.node_id);

        // Clean up embedding rows after node is confirmed deleted.
        // embedding_vec is a vec0 virtual table with no FK cascade.
        embeddingIndexer?.removeNode(node.node_id);

        // Delete file from disk
        try {
          unlinkSync(absPath);
        } catch {
          // File may already be gone
        }
      });

      return toolResult({
        deleted: true,
        node_id: node.node_id,
        file_path: node.file_path,
        dangling_references: incomingCount.c,
      });
    },
  );
}
