// src/mcp/tools/update-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { toolResult, toolErrorResult } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { hasBlockingErrors } from '../../pipeline/errors.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const paramsShape = {
  // Single-node identity (exactly one required, mutually exclusive with query)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  // Single-node updates
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),
  set_fields: z.record(z.string(), z.unknown()).optional(),
  set_body: z.string().optional(),
  append_body: z.string().optional(),
  // Query-mode bulk update (mutually exclusive with node identity)
  query: z.object({
    types: z.array(z.string()).optional(),
    where: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  dry_run: z.boolean().default(false),
};

export function registerUpdateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): void {
  server.tool(
    'update-node',
    'Update an existing node (single or query-mode bulk). Patch semantics for fields (null removes a field). set_body and append_body are mutually exclusive. For query mode, provide query instead of node identity.',
    paramsShape,
    async (params) => {
      const hasIdentity = params.node_id !== undefined || params.file_path !== undefined || params.title !== undefined;
      const hasQuery = params.query !== undefined;

      if (hasIdentity && hasQuery) {
        return toolErrorResult('INVALID_PARAMS', 'Cannot provide both node identity and query parameters');
      }
      if (!hasIdentity && !hasQuery) {
        return toolErrorResult('INVALID_PARAMS', 'Must provide either node identity (node_id/file_path/title) or query');
      }

      // ── Query mode ──────────────────────────────────────────────────
      if (hasQuery) {
        if (!params.set_fields) {
          return toolErrorResult('INVALID_PARAMS', 'Query mode requires set_fields');
        }
        return handleQueryMode(db, writeLock, vaultPath, params.query!, params.set_fields, params.dry_run);
      }

      // ── Single-node mode ────────────────────────────────────────────
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

      const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }

      const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

      const finalTitle = set_title ?? node.title;
      const finalTypes = set_types ?? currentTypes;

      const finalFields = { ...currentFields };
      if (set_fields) {
        for (const [key, value] of Object.entries(set_fields)) {
          finalFields[key] = value;
        }
      }

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

function handleQueryMode(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  query: { types?: string[]; where?: Record<string, unknown> },
  setFields: Record<string, unknown>,
  dryRun: boolean,
) {
  // Build query to find matching nodes
  const joins: string[] = [];
  const whereClauses: string[] = [];
  const sqlParams: unknown[] = [];
  let joinIdx = 0;

  if (query.types && query.types.length > 0) {
    for (const t of query.types) {
      const alias = `t${joinIdx++}`;
      joins.push(`INNER JOIN node_types ${alias} ON ${alias}.node_id = n.id AND ${alias}.schema_type = ?`);
      sqlParams.push(t);
    }
  }

  if (query.where) {
    for (const [fieldName, value] of Object.entries(query.where)) {
      const alias = `f${joinIdx++}`;
      joins.push(`INNER JOIN node_fields ${alias} ON ${alias}.node_id = n.id AND ${alias}.field_name = ?`);
      sqlParams.push(fieldName);
      if (typeof value === 'string') {
        whereClauses.push(`${alias}.value_text = ?`);
        sqlParams.push(value);
      } else if (typeof value === 'number') {
        whereClauses.push(`${alias}.value_number = ?`);
        sqlParams.push(value);
      }
    }
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const sql = `SELECT DISTINCT n.id, n.file_path, n.title, n.body FROM nodes n ${joins.join(' ')} ${whereStr}`;
  const matchedNodes = db.prepare(sql).all(...sqlParams) as Array<{
    id: string; file_path: string; title: string; body: string;
  }>;

  if (dryRun) {
    const details: Array<{ node_id: string; title: string; coerced_state: unknown; issues: unknown }> = [];
    let wouldUpdate = 0;
    let wouldSkip = 0;
    let wouldFail = 0;

    for (const node of matchedNodes.slice(0, 50)) {
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);
      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) currentFields[row.field_name] = reconstructValue(row);

      const finalFields = { ...currentFields };
      for (const [key, value] of Object.entries(setFields)) {
        finalFields[key] = value;
      }

      const { claimsByType, globalFields } = loadSchemaContext(db, types);
      const validation = validateProposedState(finalFields, types, claimsByType, globalFields);

      if (hasBlockingErrors(validation.issues)) {
        wouldFail++;
      } else {
        wouldUpdate++;
      }

      details.push({
        node_id: node.id,
        title: node.title,
        coerced_state: validation.coerced_state,
        issues: validation.issues,
      });
    }

    return toolResult({
      dry_run: true,
      matched: matchedNodes.length,
      would_update: wouldUpdate,
      would_skip: wouldSkip,
      would_fail: wouldFail,
      details,
    });
  }

  // Non-dry-run: apply updates in a single transaction
  const errors: Array<{ node_id: string; issues: unknown }> = [];
  let updated = 0;
  let skipped = 0;

  const txn = db.transaction(() => {
    for (const node of matchedNodes) {
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);
      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) currentFields[row.field_name] = reconstructValue(row);

      const finalFields = { ...currentFields };
      for (const [key, value] of Object.entries(setFields)) {
        finalFields[key] = value;
      }

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.id,
          file_path: node.file_path,
          title: node.title,
          types,
          fields: finalFields,
          body: node.body,
        });

        if (result.file_written) {
          updated++;
        } else {
          skipped++;
        }
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          errors.push({ node_id: node.id, issues: err.validation.issues });
          // Spec: if any node fails, entire batch rolls back
          throw err;
        }
        throw err;
      }
    }
  });

  try {
    txn();
    return toolResult({
      dry_run: false,
      matched: matchedNodes.length,
      updated,
      skipped,
      errors,
    });
  } catch (err) {
    if (err instanceof PipelineError) {
      return toolResult({
        dry_run: false,
        matched: matchedNodes.length,
        updated: 0,
        skipped: 0,
        errors,
      });
    }
    return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  }
}
