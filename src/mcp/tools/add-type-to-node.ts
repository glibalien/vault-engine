// src/mcp/tools/add-type-to-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail, adaptIssue } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { populateDefaults } from '../../pipeline/populate-defaults.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { writeEditsLogEntries } from '../../pipeline/edits-log.js';
import type { EditsLogEntry } from '../../pipeline/edits-log.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { buildFixable } from '../../validation/fixable.js';

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
  syncLogger?: SyncLogger,
): void {
  server.tool(
    'add-type-to-node',
    'Add a type to a node, automatically populating claimed fields with defaults. The type must have a defined schema. Use list-schemas to see available types.',
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

      // Type-schema check
      const typeCheck = checkTypesHaveSchemas(db, [params.type]);
      if (!typeCheck.valid) {
        return fail(
          'UNKNOWN_TYPE',
          `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
          {
            details: {
              unknown_types: typeCheck.unknown,
              available_schemas: typeCheck.available,
              suggestion: `Cannot add type '${params.type}' — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first. For general-purpose notes and reference material, use type 'note'.`,
            },
          },
        );
      }

      // Load current state
      const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      if (currentTypes.includes(params.type)) {
        return ok({
          node_id: node.node_id,
          file_path: node.file_path,
          types: currentTypes,
          added_fields: [],
          readopted_fields: [],
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
        }, syncLogger);

        // Log field-defaulted entries for defaults populated by add-type-to-node.
        // The pipeline sees these as 'provided' since they're pre-merged, so we
        // log them here with the correct source information.
        if (populated.length > 0) {
          const entries: EditsLogEntry[] = populated.map(p => ({
            node_id: result.node_id,
            event_type: 'field-defaulted',
            details: {
              source: 'tool' as const,
              field: p.field,
              default_value: p.default_value,
              default_source: p.default_source,
              node_types: newTypes,
            },
          }));
          writeEditsLogEntries(db, entries);
        }

        return ok(
          {
            node_id: result.node_id,
            file_path: result.file_path,
            types: newTypes,
            added_fields: populated.map(p => p.field),
            readopted_fields: readoptedFields,
            already_present: false,
          },
          result.validation.issues.map(adaptIssue),
        );
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          const errorCount = err.validation.issues.filter(i => i.severity === 'error').length;
          return fail(
            'VALIDATION_FAILED',
            `Validation failed with ${errorCount} error(s)`,
            {
              details: {
                issues: err.validation.issues.map(adaptIssue),
                fixable: buildFixable(err.validation.issues, err.validation.effective_fields),
              },
            },
          );
        }
        if (err instanceof PipelineError) {
          return fail('VALIDATION_FAILED', err.message);
        }
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
