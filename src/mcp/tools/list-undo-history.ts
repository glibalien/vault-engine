// src/mcp/tools/list-undo-history.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok } from './errors.js';
import { listOperations } from '../../undo/operation.js';

const paramsShape = {
  since: z.string().optional(),
  until: z.string().optional(),
  source_tool: z.string().optional(),
  status: z.enum(['active', 'undone', 'expired', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export function registerListUndoHistory(
  server: McpServer,
  db: Database.Database,
): void {
  server.tool(
    'list-undo-history',
    'List recent undo operations. Each operation corresponds to one user-intent tool call (create-node, update-node, rename-node, delete-node, batch-mutate, etc.) and can be reversed via undo-operations. Filters by time window, source tool, and status. Pure read — no side effects.',
    paramsShape,
    async (params) => {
      const result = listOperations(db, {
        since: params.since,
        until: params.until,
        source_tool: params.source_tool,
        status: params.status,
        limit: params.limit,
      });
      return ok({
        operations: result.operations.map(o => ({
          operation_id: o.operation_id,
          timestamp: new Date(o.timestamp).toISOString(),
          source_tool: o.source_tool,
          description: o.description,
          node_count: o.node_count,
          schema_count: o.schema_count,
          global_field_count: o.global_field_count,
          status: o.status,
        })),
        truncated: result.truncated,
      });
    },
  );
}
