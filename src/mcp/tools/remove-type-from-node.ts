// src/mcp/tools/remove-type-from-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail, type Issue } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  confirm: z.boolean().default(false),
};

export function registerRemoveTypeFromNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
): void {
  server.tool(
    'remove-type-from-node',
    'Remove a type from a node, orphaning its exclusively-claimed fields. Requires confirm: true when removing the last type.',
    paramsShape,
    async (params) => {
      const resolved = resolveNodeIdentity(db, {
        node_id: params.node_id,
        file_path: params.file_path,
        title: params.title,
      });
      if (!resolved.ok) {
        return fail(resolved.code, resolved.message);
      }
      const { node } = resolved;

      const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      if (!currentTypes.includes(params.type)) {
        return fail('NOT_FOUND', `Node does not have type "${params.type}"`);
      }

      const resultingTypes = currentTypes.filter(t => t !== params.type);

      // Determine which fields become orphans — only fields the node actually has
      const removedClaims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
        .all(params.type) as Array<{ field: string }>;
      const remainingClaims = new Set<string>();
      for (const rt of resultingTypes) {
        const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
          .all(rt) as Array<{ field: string }>;
        for (const c of claims) remainingClaims.add(c.field);
      }
      const nodeFieldNames = new Set(
        (db.prepare('SELECT field_name FROM node_fields WHERE node_id = ?')
          .all(node.node_id) as Array<{ field_name: string }>).map(r => r.field_name)
      );
      const wouldOrphanFields = removedClaims
        .map(c => c.field)
        .filter(f => !remainingClaims.has(f) && nodeFieldNames.has(f));

      // Confirmation gate for typeless result
      if (resultingTypes.length === 0 && !params.confirm) {
        const warnings: Issue[] = [
          {
            code: 'LAST_TYPE_REMOVAL',
            severity: 'warning',
            message: 'Removing this type leaves the node with no types. All fields will become orphans.',
            details: { would_orphan_fields: wouldOrphanFields },
          },
        ];
        return ok(
          {
            preview: true,
            node_id: node.node_id,
            file_path: node.file_path,
            current_types: currentTypes,
            removing_type: params.type,
            resulting_types: [],
            would_orphan_fields: wouldOrphanFields,
          },
          warnings,
        );
      }

      // Load current fields and body
      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }
      const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
          title: node.title,
          types: resultingTypes,
          fields: currentFields,
          body: currentBody,
        }, syncLogger);

        // Write fields-orphaned log entry if any fields became orphans
        if (wouldOrphanFields.length > 0) {
          db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
            node.node_id,
            Date.now(),
            'fields-orphaned',
            JSON.stringify({
              source: 'tool',
              trigger: `remove-type-from-node: ${params.type}`,
              orphaned_fields: wouldOrphanFields,
              node_types: resultingTypes,
            }),
          );
        }

        return ok({
          node_id: result.node_id,
          file_path: result.file_path,
          types: resultingTypes,
          orphaned_fields: wouldOrphanFields,
          edits_logged: result.edits_logged + (wouldOrphanFields.length > 0 ? 1 : 0),
        });
      } catch (err) {
        if (err instanceof PipelineError) {
          return fail('VALIDATION_FAILED', err.message);
        }
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
