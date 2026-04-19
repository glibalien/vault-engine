// src/mcp/tools/undo-operations.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { getOperation } from '../../undo/operation.js';
import { restoreMany } from '../../undo/restore.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const paramsShape = {
  operation_ids: z.array(z.string()).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  dry_run: z.boolean().optional(),
  resolve_conflicts: z.array(z.object({
    node_id: z.string(),
    action: z.enum(['revert', 'skip']),
  })).optional(),
};

export function registerUndoOperations(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): void {
  server.tool(
    'undo-operations',
    'Undo one or more previously captured operations. Provide either operation_ids (explicit list, cherry-pickable) or since/until (time range). dry_run defaults to true — preview conflicts before committing. When conflicts arise (modified_after_operation, path_occupied, superseded_by_later_op) they are returned for user mediation; call back with resolve_conflicts to revert or skip per node.',
    paramsShape,
    async (params) => {
      const hasIds = Array.isArray(params.operation_ids) && params.operation_ids.length > 0;
      const hasRange = Boolean(params.since || params.until);

      if (!hasIds && !hasRange) {
        return fail('INVALID_PARAMS', 'Provide either operation_ids or since/until.');
      }
      if (hasIds && hasRange) {
        return fail('INVALID_PARAMS', 'Provide exactly one of operation_ids or since/until, not both.');
      }

      // Existence check for operation_ids
      if (hasIds) {
        for (const id of params.operation_ids!) {
          const op = getOperation(db, id);
          if (!op || op.status !== 'active') {
            return fail(
              'OPERATION_NOT_FOUND',
              `Operation '${id}' is not active or does not exist.`,
              { details: { operation_id: id } },
            );
          }
        }
      }

      const dry_run = params.dry_run ?? true;
      const result = restoreMany(db, writeLock, vaultPath, {
        operation_ids: params.operation_ids,
        since: params.since,
        until: params.until,
        dry_run,
        resolve_conflicts: params.resolve_conflicts,
      });

      return ok({
        dry_run,
        operations: result.operations,
        conflicts: result.conflicts,
        total_undone: result.total_undone,
        total_conflicts: result.total_conflicts,
        total_skipped: result.total_skipped,
      });
    },
  );
}
