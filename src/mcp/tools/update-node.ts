// src/mcp/tools/update-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const paramsShape = {
  // identity (exactly one required)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  // updates
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),
  set_fields: z.record(z.string(), z.unknown()).optional(),
  set_body: z.string().optional(),
  append_body: z.string().optional(),
};

export function registerUpdateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): void {
  server.tool(
    'update-node',
    'Update an existing node. Patch semantics for fields (null removes a field). set_body and append_body are mutually exclusive.',
    paramsShape,
    async (params) => {
      const { set_title, set_types, set_fields, set_body, append_body } = params;

      if (set_body !== undefined && append_body !== undefined) {
        return toolErrorResult('INVALID_PARAMS', 'set_body and append_body are mutually exclusive');
      }

      const resolved = resolveNodeIdentity(db, {
        node_id: params.node_id,
        file_path: params.file_path,
        title: params.title,
      });
      if (!resolved.ok) {
        return toolErrorResult(resolved.code, resolved.message);
      }
      const { node } = resolved;

      // Load current state
      const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }

      const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

      // Merge updates
      const finalTitle = set_title ?? node.title;
      const finalTypes = set_types ?? currentTypes;

      // Field patch semantics
      const finalFields = { ...currentFields };
      if (set_fields) {
        for (const [key, value] of Object.entries(set_fields)) {
          if (value === null) {
            delete finalFields[key];
          } else {
            finalFields[key] = value;
          }
        }
      }

      // Body
      let finalBody = currentBody;
      if (set_body !== undefined) {
        finalBody = set_body;
      } else if (append_body !== undefined) {
        finalBody = currentBody ? `${currentBody}\n\n${append_body}` : append_body;
      }

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
          title: finalTitle,
          types: finalTypes,
          fields: finalFields,
          body: finalBody,
        });

        return toolResult({
          node_id: result.node_id,
          file_path: result.file_path,
          title: finalTitle,
          types: finalTypes,
          coerced_state: result.validation.coerced_state,
          issues: result.validation.issues,
          orphan_fields: result.validation.orphan_fields,
        });
      } catch (err) {
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
