// src/mcp/tools/add-type-to-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail, adaptIssue } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation, StaleNodeError } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { buildFixable } from '../../validation/fixable.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState, defaultedFieldsFrom } from '../../validation/validate.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  dry_run: z.boolean().default(false),
  expected_version: z.number().int().min(1).optional(),
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
    'Add a type to a node, automatically populating claimed fields with defaults. The type must have a defined schema. Use list-schemas to see available types. Use dry_run: true to preview the type addition and field defaults without applying.',
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
        if (params.dry_run) {
          return ok({ dry_run: true, would_be_no_op: true, types: currentTypes });
        }
        return ok({
          node_id: node.node_id,
          file_path: node.file_path,
          types: currentTypes,
          added_fields: [],
          readopted_fields: [],
          already_present: true,
          version: getNodeVersion(db, node.node_id),
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

      // Run validation once. validate.ts populates missing required-with-default
      // fields into coerced_state with source='defaulted'.
      const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
      const validation = validateProposedState(currentFields, newTypes, claimsByType, globalFields);
      const populated = defaultedFieldsFrom(validation);

      // Detect re-adopted fields (orphan fields now claimed by the new type)
      const populatedSet = new Set(populated.map(p => p.field));
      const readoptedFields: string[] = [];
      const newClaims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?')
        .all(params.type) as Array<{ field: string }>;
      for (const claim of newClaims) {
        if (claim.field in currentFields && !populatedSet.has(claim.field)) {
          readoptedFields.push(claim.field);
        }
      }

      if (params.dry_run) {
        const wouldAddFields = populated.reduce<Record<string, unknown>>((acc, p) => {
          acc[p.field] = p.default_value;
          return acc;
        }, {});
        return ok(
          {
            dry_run: true,
            would_be_no_op: false,
            types: newTypes,
            would_add_fields: wouldAddFields,
            would_readopt_fields: readoptedFields,
          },
          validation.issues.map(adaptIssue),
        );
      }

      const operation_id = createOperation(db, {
        source_tool: 'add-type-to-node',
        description: `add-type-to-node: added '${params.type}' to '${node.title}'`,
      });

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
          title: node.title,
          types: newTypes,
          fields: currentFields,
          body: currentBody,
          expectedVersion: params.expected_version,
        }, syncLogger, { operation_id });

        // The pipeline emits field-defaulted edits-log entries automatically
        // because validate.ts produces source='defaulted' entries in coerced_state
        // when required-with-default fields are missing.
        const addedFields = defaultedFieldsFrom(result.validation).map(p => p.field);
        const version = getNodeVersion(db, result.node_id);

        return ok(
          {
            node_id: result.node_id,
            file_path: result.file_path,
            types: newTypes,
            added_fields: addedFields,
            readopted_fields: readoptedFields,
            already_present: false,
            version,
          },
          result.validation.issues.map(adaptIssue),
        );
      } catch (err) {
        if (err instanceof StaleNodeError) {
          return buildStaleNodeEnvelope(db, err);
        }
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
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}

function getNodeVersion(db: Database.Database, nodeId: string): number | undefined {
  return (db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined)?.version;
}
