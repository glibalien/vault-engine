// src/mcp/tools/update-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dirname, join } from 'node:path';
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { ok, fail, adaptIssue, type Issue } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeRename } from './rename-node.js';
import { checkTitleSafety, type ToolIssue } from './title-warnings.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { hasBlockingErrors } from '../../pipeline/errors.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
import { buildFixable } from '../../validation/fixable.js';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';

const _targetFilterSchema = z.object({
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  references: z.object({
    target: z.string(),
    rel_type: z.string().optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  }).optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  // NOT included: join_filters, without_joins (nested joins deferred)
});

const _joinFilterSchema = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  rel_type: z.union([z.string(), z.array(z.string())]).optional(),
  target: _targetFilterSchema.optional(),
}).refine(
  (f) => f.rel_type !== undefined || f.target !== undefined,
  { message: 'INVALID_PARAMS: JoinFilter requires at least one of rel_type or target' },
);

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
    without_types: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    without_fields: z.array(z.string()).optional(),
    full_text: z.string().optional(),
    references: z.object({
      target: z.string(),
      rel_type: z.string().optional(),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
    }).optional(),
    path_prefix: z.string().optional(),
    without_path_prefix: z.string().optional(),
    path_dir: z.string().optional(),
    modified_since: z.string().optional(),
    join_filters: z.array(_joinFilterSchema).optional(),
    without_joins: z.array(_joinFilterSchema).optional(),
  }).optional(),
  // Type operations (query mode)
  add_types: z.array(z.string()).optional(),
  remove_types: z.array(z.string()).optional(),
  // Batch controls
  confirm_large_batch: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  // Path operation (query mode only)
  set_directory: z.string().optional(),
};

export function registerUpdateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
): void {
  server.tool(
    'update-node',
    'Update an existing node (single or query-mode bulk). Patch semantics for fields (null removes a field). set_body and append_body are mutually exclusive. Types can be changed with set_types (replace all), add_types (append), or remove_types (remove). All type changes require defined schemas — use list-schemas to see available types. set_title renames the file and rewrites wiki-link references vault-wide. For query mode, provide query instead of node identity. Query mode supports set_directory to move files to a target directory (title unchanged, no reference rewriting). Query mode accepts join_filters and without_joins (same shape as query-nodes) for cross-node filtering — e.g. bump priority on all tasks whose project is done: {"query":{"types":["task"],"join_filters":[{"rel_type":"project","target":{"fields":{"status":{"eq":"done"}}}}]},"set_fields":{"priority":"high"},"dry_run":true}. When join filters have targets but unresolved edges exist, a `CROSS_NODE_FILTER_UNRESOLVED` warning surfaces in the envelope `warnings` array. Dry-run defaults to true in query mode.',
    paramsShape,
    async (params) => {
      const hasIdentity = params.node_id !== undefined || params.file_path !== undefined || params.title !== undefined;
      const hasQuery = params.query !== undefined;

      if (hasIdentity && hasQuery) {
        return fail('INVALID_PARAMS', 'Cannot provide both node identity and query parameters');
      }
      if (!hasIdentity && !hasQuery) {
        return fail('INVALID_PARAMS', 'Must provide either node identity (node_id/file_path/title) or query');
      }

      if (hasIdentity && params.set_directory !== undefined) {
        return fail('INVALID_PARAMS', 'set_directory is not supported in single-node mode. Use rename-node to move individual files.');
      }

      // ── Query mode ──────────────────────────────────────────────────
      if (hasQuery) {
        if (params.set_types !== undefined) {
          return fail(
            'INVALID_PARAMS',
            'set_types is not supported in query mode. Use add_types/remove_types for bulk type changes across filtered nodes.',
          );
        }
        const hasOp = params.set_fields !== undefined || params.add_types !== undefined || params.remove_types !== undefined || params.set_directory !== undefined;
        if (!hasOp) {
          return fail('INVALID_PARAMS', 'Query mode requires at least one operation: set_fields, add_types, remove_types, or set_directory');
        }

        if (params.set_directory !== undefined && params.set_directory.endsWith('.md')) {
          return fail(
            'INVALID_PARAMS',
            '"set_directory" must be a folder path, not a filename. The filename is always derived from the node title.',
          );
        }
        const dryRun = params.dry_run ?? true; // default true in query mode
        return handleQueryMode(db, writeLock, vaultPath, params.query!, {
          set_fields: params.set_fields,
          add_types: params.add_types,
          remove_types: params.remove_types,
          set_directory: params.set_directory,
        }, dryRun, params.confirm_large_batch, syncLogger);
      }

      // ── Single-node mode ────────────────────────────────────────────
      const dryRun = params.dry_run ?? false; // default false in single-node mode
      const { set_title, set_types, set_fields, set_body, append_body } = params;

      if (set_body !== undefined && append_body !== undefined) {
        return fail('INVALID_PARAMS', 'set_body and append_body are mutually exclusive');
      }

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

      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }

      const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

      const finalTitle = set_title ?? node.title;
      const titleChanged = set_title !== undefined && set_title !== node.title;

      // If title changed, derive new file path and check for conflicts
      let effectiveFilePath = node.file_path;
      if (titleChanged) {
        const currentDir = dirname(node.file_path);
        const newDir = currentDir === '.' ? '' : currentDir;
        effectiveFilePath = newDir ? `${newDir}/${finalTitle}.md` : `${finalTitle}.md`;

        // Conflict check
        if (effectiveFilePath !== node.file_path) {
          const conflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(effectiveFilePath) as { id: string; title: string } | undefined;
          if (conflict) {
            return fail('CONFLICT', `Cannot rename — file "${effectiveFilePath}" already exists (node: ${conflict.title}). Use rename-node with a different directory to resolve.`);
          }
          safeVaultPath(vaultPath, effectiveFilePath); // throws on path traversal
          if (existsSync(join(vaultPath, effectiveFilePath))) {
            return fail('CONFLICT', `Cannot rename — file "${effectiveFilePath}" already exists on disk.`);
          }
        }
      }

      // Compute final types: set_types wins outright, otherwise apply add/remove
      let finalTypes: string[];
      const hasTypeOp = set_types !== undefined || params.add_types !== undefined || params.remove_types !== undefined;
      const ignored: string[] = [];
      if (params.add_types !== undefined) ignored.push('add_types');
      if (params.remove_types !== undefined) ignored.push('remove_types');
      const typeOpConflict: ToolIssue[] =
        set_types !== undefined && ignored.length > 0
          ? [{
              code: 'TYPE_OP_CONFLICT',
              message: `set_types was provided — ${ignored.join(' and ')} ${ignored.length === 1 ? 'was' : 'were'} ignored. Send only set_types for a full replacement, or only add_types/remove_types for incremental changes.`,
            }]
          : [];
      if (set_types !== undefined) {
        finalTypes = set_types;
      } else {
        finalTypes = computeNewTypes(currentTypes, {
          add_types: params.add_types,
          remove_types: params.remove_types,
        });
      }

      // Type-schema check (only when types are being changed)
      if (hasTypeOp) {
        const typeCheck = checkTypesHaveSchemas(db, finalTypes);
        if (!typeCheck.valid) {
          return fail(
            'UNKNOWN_TYPE',
            `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
            {
              details: {
                unknown_types: typeCheck.unknown,
                available_schemas: typeCheck.available,
                suggestion: `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first. For general-purpose notes and reference material, use type 'note'.`,
              },
            },
          );
        }
      }

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

      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        const { claimsByType, globalFields } = loadSchemaContext(db, finalTypes);
        const validation = validateProposedState(finalFields, finalTypes, claimsByType, globalFields);
        const titleIssues: ToolIssue[] = titleChanged ? checkTitleSafety(finalTitle) : [];
        const allIssues = [...validation.issues, ...titleIssues, ...typeOpConflict];
        return ok(
          {
            dry_run: true,
            preview: {
              node_id: node.node_id,
              file_path: effectiveFilePath,
              title: finalTitle,
              types: finalTypes,
              coerced_state: validation.coerced_state,
              fixable: buildFixable(validation.issues, validation.effective_fields),
              orphan_fields: validation.orphan_fields,
            },
          },
          allIssues.map(adaptIssue),
        );
      }

      // ── Undo operation setup (skipped for dry_run) ──────────────────
      const operation_id = dryRun ? undefined : createOperation(db, {
        source_tool: 'update-node',
        description: buildSingleNodeDescription(node.title, {
          set_title,
          set_types,
          add_types: params.add_types,
          remove_types: params.remove_types,
          set_fields,
          set_body,
          append_body,
        }),
      });

      try {
        if (titleChanged) {
          // Apply field/type/body changes first (with old file_path and title)
          const mutResult = executeMutation(db, writeLock, vaultPath, {
            source: 'tool',
            node_id: node.node_id,
            file_path: node.file_path,
            title: node.title,
            types: finalTypes,
            fields: finalFields,
            body: finalBody,
          }, syncLogger, operation_id ? { operation_id } : undefined);

          // Then rename (file + DB + references)
          const { refsUpdated } = db.transaction(() => {
            return executeRename(db, writeLock, vaultPath, {
              node_id: node.node_id,
              file_path: node.file_path,
              title: node.title,
            }, finalTitle, effectiveFilePath, syncLogger, operation_id ? { operation_id } : undefined);
          })();

          const titleIssues: ToolIssue[] = checkTitleSafety(finalTitle);
          return ok(
            {
              node_id: node.node_id,
              file_path: effectiveFilePath,
              title: finalTitle,
              types: finalTypes,
              references_updated: refsUpdated,
              coerced_state: mutResult.validation.coerced_state,
              orphan_fields: mutResult.validation.orphan_fields,
            },
            [...mutResult.validation.issues, ...titleIssues, ...typeOpConflict].map(adaptIssue),
          );
        }

        // No title change — standard mutation
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
          title: finalTitle,
          types: finalTypes,
          fields: finalFields,
          body: finalBody,
        }, syncLogger, operation_id ? { operation_id } : undefined);

        return ok(
          {
            node_id: result.node_id,
            file_path: result.file_path,
            title: finalTitle,
            types: finalTypes,
            coerced_state: result.validation.coerced_state,
            orphan_fields: result.validation.orphan_fields,
          },
          [...result.validation.issues, ...typeOpConflict].map(adaptIssue),
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
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
    },
  );
}

interface QueryModeOps {
  set_fields?: Record<string, unknown>;
  add_types?: string[];
  remove_types?: string[];
  set_directory?: string;
}

function buildSingleNodeDescription(
  title: string,
  params: {
    set_title?: string;
    set_types?: string[];
    add_types?: string[];
    remove_types?: string[];
    set_fields?: Record<string, unknown>;
    set_body?: string;
    append_body?: string;
  },
): string {
  const parts: string[] = [];
  if (params.set_title !== undefined) parts.push('title');
  if (params.set_types !== undefined) parts.push('types');
  if (params.add_types !== undefined) parts.push('add_types');
  if (params.remove_types !== undefined) parts.push('remove_types');
  if (params.set_fields !== undefined) {
    const n = Object.keys(params.set_fields).length;
    parts.push(`${n} field${n === 1 ? '' : 's'}`);
  }
  if (params.set_body !== undefined) parts.push('body');
  if (params.append_body !== undefined) parts.push('append_body');
  const changes = parts.length > 0 ? parts.join(', ') : 'no-op';
  return `update-node: ${changes} on '${title}'`;
}

function handleQueryMode(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  query: NodeQueryFilter,
  ops: QueryModeOps,
  dryRun: boolean,
  confirmLargeBatch?: boolean,
  syncLogger?: SyncLogger,
) {
  // Build query to find matching nodes
  const { sql, params } = buildNodeQuery(query, db);
  const matchedNodes = db.prepare(sql).all(...params) as Array<{
    id: string; file_path: string; title: string; body: string;
  }>;

  // Batch size guard
  if (matchedNodes.length > 1000 && !confirmLargeBatch) {
    return fail('INVALID_PARAMS', `Query matched ${matchedNodes.length} nodes (>1000). Set confirm_large_batch: true to proceed.`);
  }

  // Type-schema check on add_types
  if (ops.add_types && ops.add_types.length > 0) {
    const typeCheck = checkTypesHaveSchemas(db, ops.add_types);
    if (!typeCheck.valid) {
      return fail(
        'UNKNOWN_TYPE',
        `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
        {
          details: {
            unknown_types: typeCheck.unknown,
            available_schemas: typeCheck.available,
            suggestion: `Cannot add types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first. For general-purpose notes and reference material, use type 'note'.`,
          },
        },
      );
    }
  }

  const batchId = nanoid();

  const joinWarning = computeJoinWarning(db, query.join_filters, query.without_joins);

  if (dryRun) {
    return handleDryRun(db, vaultPath, matchedNodes, ops, batchId, joinWarning);
  }

  // ── Undo operation setup (query mode) ──────────────────────────────
  // One operation covers all matched-node mutations; finalize once in a
  // finally so orphan snapshots still get tagged for cleanup on throw.
  const operation_id = createOperation(db, {
    source_tool: 'update-node',
    description: `update-node query: updating ${matchedNodes.length} node(s)`,
  });

  try {
    return handleExecution(db, writeLock, vaultPath, matchedNodes, ops, batchId, syncLogger, operation_id);
  } finally {
    finalizeOperation(db, operation_id);
  }
}

function computeJoinWarning(
  db: Database.Database,
  joinFilters: NodeQueryFilter['join_filters'] | undefined,
  withoutJoins: NodeQueryFilter['without_joins'] | undefined,
): Issue | undefined {
  const needsCheck =
    (joinFilters?.some(f => f.target !== undefined) ?? false) ||
    (withoutJoins?.some(f => f.target !== undefined) ?? false);

  if (!needsCheck) return undefined;

  // Collect rel_types that appeared in filters-with-target; missing rel_type means "any".
  const relTypes = new Set<string>();
  let anyRelType = false;
  for (const f of [...(joinFilters ?? []), ...(withoutJoins ?? [])]) {
    if (f.target === undefined) continue;
    if (f.rel_type === undefined) { anyRelType = true; break; }
    const types = Array.isArray(f.rel_type) ? f.rel_type : [f.rel_type];
    for (const t of types) relTypes.add(t);
  }

  let sql = 'SELECT COUNT(*) AS n FROM relationships WHERE resolved_target_id IS NULL';
  const p: unknown[] = [];
  if (!anyRelType && relTypes.size > 0) {
    const placeholders = Array.from(relTypes, () => '?').join(', ');
    sql += ` AND rel_type IN (${placeholders})`;
    p.push(...relTypes);
  }
  const { n } = db.prepare(sql).get(...p) as { n: number };
  if (n > 0) {
    const edges = anyRelType ? ['(any rel_type)'] : Array.from(relTypes);
    return {
      code: 'CROSS_NODE_FILTER_UNRESOLVED',
      severity: 'warning',
      message: `Could not resolve cross-node filter edges: ${edges.join(', ')}`,
      details: { edges },
    };
  }
  return undefined;
}

function loadNodeState(db: Database.Database, nodeId: string) {
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

  const currentFields: Record<string, unknown> = {};
  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  for (const row of fieldRows) {
    currentFields[row.field_name] = reconstructValue(row);
  }

  return { types, fields: currentFields };
}

function computeNewTypes(currentTypes: string[], ops: QueryModeOps): string[] {
  let types = [...currentTypes];
  if (ops.add_types) {
    for (const t of ops.add_types) {
      if (!types.includes(t)) types.push(t);
    }
  }
  if (ops.remove_types) {
    types = types.filter(t => !ops.remove_types!.includes(t));
  }
  return types;
}

function computeNewFields(currentFields: Record<string, unknown>, ops: QueryModeOps): Record<string, unknown> {
  const finalFields = { ...currentFields };
  if (ops.set_fields) {
    for (const [key, value] of Object.entries(ops.set_fields)) {
      finalFields[key] = value;
    }
  }
  return finalFields;
}

function computeNewPath(currentFilePath: string, title: string, ops: QueryModeOps): { newFilePath: string; newDir: string; moved: boolean } | null {
  if (ops.set_directory === undefined) return null;

  const targetDir = ops.set_directory === '.' ? '' : ops.set_directory;
  const newFilePath = targetDir === '' ? `${title}.md` : `${targetDir}/${title}.md`;

  if (newFilePath === currentFilePath) return null; // already at target

  return { newFilePath, newDir: targetDir, moved: true };
}

function checkMoveConflict(db: Database.Database, vaultPath: string, newFilePath: string, currentNodeId: string): string | null {
  safeVaultPath(vaultPath, newFilePath); // throws on path traversal
  const dbConflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(newFilePath) as { id: string; title: string } | undefined;
  if (dbConflict && dbConflict.id !== currentNodeId) {
    return `File path "${newFilePath}" already exists (node: ${dbConflict.title})`;
  }
  if (existsSync(join(vaultPath, newFilePath))) {
    const currentNode = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(currentNodeId) as { file_path: string } | undefined;
    if (currentNode?.file_path !== newFilePath) {
      return `File "${newFilePath}" already exists on disk`;
    }
  }
  return null;
}

function hasChanges(
  currentTypes: string[],
  newTypes: string[],
  currentFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
  moved?: boolean,
): boolean {
  if (moved) return true;
  // Check types changed
  if (currentTypes.length !== newTypes.length || !currentTypes.every(t => newTypes.includes(t))) {
    return true;
  }
  // Check fields changed
  const allKeys = new Set([...Object.keys(currentFields), ...Object.keys(newFields)]);
  for (const key of allKeys) {
    const oldVal = currentFields[key];
    const newVal = newFields[key];
    if (oldVal !== newVal) {
      // Handle null removal: if new is null and old doesn't exist, no change
      if (newVal === null && oldVal === undefined) continue;
      return true;
    }
  }
  return false;
}

const PREVIEW_LIMIT = 20;

function handleDryRun(
  db: Database.Database,
  vaultPath: string,
  matchedNodes: Array<{ id: string; file_path: string; title: string; body: string }>,
  ops: QueryModeOps,
  batchId: string,
  joinWarning?: Issue,
) {
  const preview: Array<{
    node_id: string;
    file_path: string;
    title: string;
    changes: {
      path_changed?: { from: string; to: string };
      types_added: string[];
      types_removed: string[];
      fields_set: Record<string, { from: unknown; to: unknown }>;
      would_fail: boolean;
    };
  }> = [];
  let wouldUpdate = 0;
  let wouldSkip = 0;
  let wouldFail = 0;

  for (let i = 0; i < matchedNodes.length; i++) {
    const node = matchedNodes[i];
    const { types: currentTypes, fields: currentFields } = loadNodeState(db, node.id);
    const newTypes = computeNewTypes(currentTypes, ops);
    const newFields = computeNewFields(currentFields, ops);

    const moveResult = computeNewPath(node.file_path, node.title, ops);
    const moved = moveResult !== null;
    let moveConflict: string | null = null;
    if (moved) {
      moveConflict = checkMoveConflict(db, vaultPath, moveResult!.newFilePath, node.id);
    }

    if (!hasChanges(currentTypes, newTypes, currentFields, newFields, moved)) {
      wouldSkip++;
      continue;
    }

    // Validate proposed state
    const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
    const validation = validateProposedState(newFields, newTypes, claimsByType, globalFields);
    const fails = hasBlockingErrors(validation.issues) || moveConflict !== null;

    if (fails) {
      wouldFail++;
    } else {
      wouldUpdate++;
    }

    // Build preview for first N nodes that have changes
    if (i < PREVIEW_LIMIT) {
      const typesAdded = newTypes.filter(t => !currentTypes.includes(t));
      const typesRemoved = currentTypes.filter(t => !newTypes.includes(t));
      const fieldsSet: Record<string, { from: unknown; to: unknown }> = {};
      if (ops.set_fields) {
        for (const [key, value] of Object.entries(ops.set_fields)) {
          if (currentFields[key] !== value) {
            fieldsSet[key] = { from: currentFields[key] ?? null, to: value };
          }
        }
      }

      const pathChanged = moved
        ? { from: dirname(node.file_path) === '.' ? '' : dirname(node.file_path), to: moveResult!.newDir }
        : undefined;

      preview.push({
        node_id: node.id,
        file_path: node.file_path,
        title: node.title,
        changes: {
          ...(pathChanged && { path_changed: pathChanged }),
          types_added: typesAdded,
          types_removed: typesRemoved,
          fields_set: fieldsSet,
          would_fail: fails,
        },
      });
    }
  }

  const warnings: Issue[] = [];
  if (joinWarning) warnings.push(joinWarning);
  return ok(
    {
      dry_run: true,
      batch_id: batchId,
      matched: matchedNodes.length,
      would_update: wouldUpdate,
      would_skip: wouldSkip,
      would_fail: wouldFail,
      preview,
    },
    warnings,
  );
}

function handleExecution(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  matchedNodes: Array<{ id: string; file_path: string; title: string; body: string }>,
  ops: QueryModeOps,
  batchId: string,
  syncLogger?: SyncLogger,
  operation_id?: string,
) {
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ node_id: string; file_path: string; error: string }> = [];

  for (const node of matchedNodes) {
    const { types: currentTypes, fields: currentFields } = loadNodeState(db, node.id);
    const newTypes = computeNewTypes(currentTypes, ops);
    const newFields = computeNewFields(currentFields, ops);

    // ── Move (set_directory) ───────────────────────────────────────────
    const moveResult = computeNewPath(node.file_path, node.title, ops);
    const moved = moveResult !== null;
    let effectiveFilePath = node.file_path;

    if (moved) {
      const conflict = checkMoveConflict(db, vaultPath, moveResult!.newFilePath, node.id);
      if (conflict) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: conflict });
        continue;
      }

      if (node.title.includes('/') || node.title.includes('\\')) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: 'Title contains path separators, cannot move' });
        continue;
      }

      const oldAbs = join(vaultPath, node.file_path);
      const newAbs = safeVaultPath(vaultPath, moveResult!.newFilePath);

      if (!existsSync(oldAbs)) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: 'Source file missing from disk' });
        continue;
      }

      const targetDir = dirname(newAbs);
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Move under write lock for both paths
      writeLock.withLockSync(oldAbs, () => {
        writeLock.withLockSync(newAbs, () => {
          renameSync(oldAbs, newAbs);
          // Clear content_hash so executeMutation's no-op check doesn't skip re-rendering at the new path
          db.prepare('UPDATE nodes SET file_path = ?, content_hash = NULL WHERE id = ?').run(moveResult!.newFilePath, node.id);
        });
      });

      effectiveFilePath = moveResult!.newFilePath;
    }

    if (!hasChanges(currentTypes, newTypes, currentFields, newFields, moved)) {
      skipped++;
      continue;
    }

    try {
      const result = executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: node.id,
        file_path: effectiveFilePath,
        title: node.title,
        types: newTypes,
        fields: newFields,
        body: node.body,
      }, syncLogger, operation_id ? { operation_id } : undefined);

      if (result.file_written) {
        updated++;
      } else {
        skipped++;
      }

      // Write bulk-mutate edits_log entry
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        node.id,
        Date.now(),
        'bulk-mutate',
        JSON.stringify({ batch_id: batchId, ops }),
      );
    } catch (err) {
      if (err instanceof PipelineError) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: err.message });
      } else {
        errors.push({ node_id: node.id, file_path: node.file_path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return ok({
    dry_run: false,
    batch_id: batchId,
    matched: matchedNodes.length,
    updated,
    skipped,
    errors,
  });
}
