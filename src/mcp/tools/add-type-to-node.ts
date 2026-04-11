// src/mcp/tools/add-type-to-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { populateDefaults } from '../../pipeline/populate-defaults.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
};

export function registerAddTypeToNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): void {
  server.tool(
    'add-type-to-node',
    'Add a type to a node, automatically populating claimed fields with defaults.',
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

      // Load current state
      const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      if (currentTypes.includes(params.type)) {
        return toolResult({
          node_id: node.node_id,
          file_path: node.file_path,
          types: currentTypes,
          added_fields: [],
          readopted_fields: [],
          issues: [],
          already_present: true,
        });
      }

      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }

      const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

      // New type set
      const newTypes = [...currentTypes, params.type];

      // Populate defaults via merge algorithm
      const { defaults, populated } = populateDefaults(db, newTypes, currentFields);

      // Detect re-adopted fields (orphan fields that are now claimed by the new type)
      const readoptedFields: string[] = [];
      const newClaims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
        .all(params.type) as Array<{ field: string }>;
      for (const claim of newClaims) {
        if (claim.field in currentFields && !(claim.field in defaults)) {
          readoptedFields.push(claim.field);
        }
      }

      const mergedFields = { ...currentFields, ...defaults };

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
          title: node.title,
          types: newTypes,
          fields: mergedFields,
          body: currentBody,
        });

        return toolResult({
          node_id: result.node_id,
          file_path: result.file_path,
          types: newTypes,
          added_fields: populated.map(p => p.field),
          readopted_fields: readoptedFields,
          issues: result.validation.issues,
          already_present: false,
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
