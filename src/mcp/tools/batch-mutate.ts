// src/mcp/tools/batch-mutate.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { resolveDirectory } from '../../schema/paths.js';
import { ok, fail, adaptIssue, type Issue } from './errors.js';
import { checkTitleSafety, checkBodyFrontmatter, sanitizeFilename } from './title-warnings.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { backupFile, restoreFile, cleanupBackups } from '../../pipeline/file-writer.js';
import { executeDeletion } from '../../pipeline/delete.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { buildFixable } from '../../validation/fixable.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';

const createParamsSchema = z.object({
  title: z.string(),
  types: z.array(z.string()).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  body: z.string().optional(),
  directory: z.string().optional(),
  override_default_directory: z.boolean().optional(),
  path: z.string().optional().describe('DEPRECATED — use `directory`. Will be removed in a future release.'),
}).strict();

const updateParamsSchema = z.object({
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),
  add_types: z.array(z.string()).optional(),
  remove_types: z.array(z.string()).optional(),
  set_fields: z.record(z.string(), z.unknown()).optional(),
  set_body: z.string().optional(),
  append_body: z.string().optional(),
}).strict();

const deleteParamsSchema = z.object({
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
}).strict();

const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), params: createParamsSchema }),
  z.object({ op: z.literal('update'), params: updateParamsSchema }),
  z.object({ op: z.literal('delete'), params: deleteParamsSchema }),
]);

const paramsShape = {
  operations: z.array(operationSchema),
  dry_run: z.boolean().default(false),
};

type WouldApplyEntry =
  | { op: 'create'; node_id: string; file_path: string; title: string }
  | {
      op: 'update';
      node_id: string;
      file_path: string;
      fields_changed: string[];
      types_after?: string[];
      body_changed: boolean;
      title_changed: boolean;
    }
  | {
      op: 'delete';
      node_id: string;
      file_path: string;
      incoming_reference_count: number;
      referencing_nodes: Array<{ node_id: string; title: string; file_path: string }>;
    };

class DryRunRollback extends Error {
  constructor() {
    super('DryRunRollback');
    this.name = 'DryRunRollback';
  }
}

export function registerBatchMutate(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'batch-mutate',
    'Execute multiple mutation operations atomically. All operations succeed or all roll back. Rename is not supported in batch. Create ops use schema default_directory when directory is omitted — pass override_default_directory: true to place elsewhere. The legacy path alias is deprecated; use directory. Use dry_run: true to preview the entire batch atomically (composed effects via SAVEPOINT-style rollback) without applying.',
    paramsShape,
    async (params) => {
      const results: Array<{ op: string; node_id: string; file_path: string }> = [];
      const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
      const warnings: Issue[] = [];

      // Track file state for rollback: files that existed before (backed up)
      // and files that were created new (to be deleted on rollback)
      const backups: Array<{ filePath: string; backupPath: string }> = [];
      const createdFiles: string[] = [];
      // Track node IDs deleted in this batch so we can clean up vec rows after commit.
      const deletedNodeIds: string[] = [];

      let batchError: { failed_at: number; op: string; message: string; details: Record<string, unknown> } | null = null as { failed_at: number; op: string; message: string; details: Record<string, unknown> } | null;

      const dryRun = params.dry_run;
      const operation_id: string | undefined = dryRun ? undefined : createOperation(db, {
        source_tool: 'batch-mutate',
        description: `batch-mutate: ${params.operations.length} ops (${countKinds(params.operations)})`,
      });

      const would_apply: WouldApplyEntry[] = [];

      const txn = db.transaction(() => {
        for (let i = 0; i < params.operations.length; i++) {
          const { op, params: opParams } = params.operations[i];

          try {
            if (op === 'create') {
              const title = opParams.title;
              const types = opParams.types ?? [];
              const fields = opParams.fields ?? {};
              const body = opParams.body ?? '';

              // Directory param reconciliation: `path` is a deprecated alias for `directory`.
              if (opParams.path !== undefined && opParams.directory !== undefined) {
                throw new PipelineError(
                  'INVALID_PARAMS',
                  "Do not supply both 'path' and 'directory' on a create op. 'path' is deprecated — use 'directory'.",
                );
              }
              let directoryParam = opParams.directory;
              if (opParams.path !== undefined && opParams.directory === undefined) {
                directoryParam = opParams.path;
                warnings.push({
                  severity: 'warning',
                  code: 'DEPRECATED_PARAM',
                  message: "Param 'path' is deprecated in batch-mutate create; use 'directory' instead.",
                });
              }
              const override_default_directory = opParams.override_default_directory ?? false;

              // Type-schema check
              const typeCheck = checkTypesHaveSchemas(db, types);
              if (!typeCheck.valid) {
                throw new PipelineError('UNKNOWN_TYPE',
                  `Cannot create node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
              }

              const dirResult = resolveDirectory(db, { types, directory: directoryParam, override_default_directory });
              if (!dirResult.ok) throw new PipelineError(dirResult.code, dirResult.message);

              const sanitize = sanitizeFilename(`${title}.md`);
              if (sanitize.sanitized) {
                warnings.push(adaptIssue({
                  code: 'TITLE_FILENAME_SANITIZED',
                  message: `Title contains path-separator characters; replaced with '-' in filename: ${sanitize.characters.join(' ')}`,
                  characters: sanitize.characters,
                }));
              }
              for (const issue of checkTitleSafety(title)) warnings.push(adaptIssue(issue));
              for (const issue of checkBodyFrontmatter(body)) warnings.push(adaptIssue(issue));

              const filePath = dirResult.directory ? `${dirResult.directory}/${sanitize.filename}` : sanitize.filename;
              const absPath = safeVaultPath(vaultPath, filePath);

              const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath);
              if (existing || existsSync(absPath)) {
                throw new PipelineError('INVALID_PARAMS', `File path "${filePath}" already exists`);
              }

              const result = executeMutation(db, writeLock, vaultPath, {
                source: 'tool',
                node_id: null,
                file_path: filePath,
                title,
                types,
                fields,
                body,
                ...(dryRun ? { db_only: true } : {}),
              }, syncLogger, operation_id ? { operation_id } : undefined);
              if (!dryRun && result.file_written) createdFiles.push(absPath);
              results.push({ op: 'create', node_id: result.node_id, file_path: result.file_path });
              if (dryRun) {
                would_apply.push({
                  op: 'create',
                  node_id: result.node_id,
                  file_path: result.file_path,
                  title,
                });
              }

            } else if (op === 'update') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id,
                file_path: opParams.file_path,
                title: opParams.title,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const absPath = join(vaultPath, node.file_path);

              // Back up the existing file before mutation (skip in dry-run — file is never written)
              if (!dryRun) {
                const bp = backupFile(absPath, tmpDir);
                if (bp) backups.push({ filePath: absPath, backupPath: bp });
              }

              const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
                .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
              const currentFields: Record<string, unknown> = {};
              const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
                .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
              for (const row of fieldRows) currentFields[row.field_name] = reconstructValue(row);
              const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

              // Fields
              const finalFields = { ...currentFields };
              if (opParams.set_fields) {
                for (const [key, value] of Object.entries(opParams.set_fields)) {
                  finalFields[key] = value; // null passes through as deletion intent
                }
              }

              // Types: set_types wins outright, otherwise apply add/remove
              let finalTypes: string[];
              if (opParams.set_types !== undefined) {
                finalTypes = opParams.set_types;
              } else {
                finalTypes = [...currentTypes];
                if (opParams.add_types) {
                  for (const t of opParams.add_types) {
                    if (!finalTypes.includes(t)) finalTypes.push(t);
                  }
                }
                if (opParams.remove_types) {
                  finalTypes = finalTypes.filter(t => !opParams.remove_types!.includes(t));
                }
              }

              const hasTypeOp = opParams.set_types !== undefined || opParams.add_types !== undefined || opParams.remove_types !== undefined;
              if (hasTypeOp) {
                const typeCheck = checkTypesHaveSchemas(db, finalTypes);
                if (!typeCheck.valid) {
                  throw new PipelineError('UNKNOWN_TYPE',
                    `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
                }
              }

              // Body: set_body and append_body are mutually exclusive
              if (opParams.set_body !== undefined && opParams.append_body !== undefined) {
                throw new PipelineError('INVALID_PARAMS', 'set_body and append_body are mutually exclusive');
              }
              let finalBody = currentBody;
              if (opParams.set_body !== undefined) {
                finalBody = opParams.set_body;
              } else if (opParams.append_body !== undefined) {
                finalBody = currentBody ? `${currentBody}\n\n${opParams.append_body}` : opParams.append_body;
              }

              const result = executeMutation(db, writeLock, vaultPath, {
                source: 'tool',
                node_id: node.node_id,
                file_path: node.file_path,
                title: opParams.set_title ?? node.title,
                types: finalTypes,
                fields: finalFields,
                body: finalBody,
                ...(dryRun ? { db_only: true } : {}),
              }, syncLogger, operation_id ? { operation_id } : undefined);
              results.push({ op: 'update', node_id: result.node_id, file_path: result.file_path });

              if (dryRun) {
                // Compute change-indicators by diffing against pre-update DB state we already loaded.
                const fields_changed: string[] = [];
                const allKeys = new Set([
                  ...Object.keys(currentFields),
                  ...Object.keys(finalFields),
                ]);
                for (const k of allKeys) {
                  const before = currentFields[k];
                  const after = finalFields[k];
                  if (JSON.stringify(before) !== JSON.stringify(after)) fields_changed.push(k);
                }
                const typesChanged = JSON.stringify([...currentTypes].sort()) !== JSON.stringify([...finalTypes].sort());
                const entry: WouldApplyEntry = {
                  op: 'update',
                  node_id: result.node_id,
                  file_path: result.file_path,
                  fields_changed,
                  body_changed: finalBody !== currentBody,
                  title_changed: (opParams.set_title ?? node.title) !== node.title,
                };
                if (typesChanged) entry.types_after = finalTypes;
                would_apply.push(entry);
              }

            } else if (op === 'delete') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id,
                file_path: opParams.file_path,
                title: opParams.title,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const absPath = join(vaultPath, node.file_path);

              // Back up the file before deleting (skip in dry-run — file is never unlinked)
              if (!dryRun) {
                const bp = backupFile(absPath, tmpDir);
                if (bp) backups.push({ filePath: absPath, backupPath: bp });
              }

              let preview_refs: { count: number; nodes: Array<{ node_id: string; title: string; file_path: string }> } | undefined;
              if (dryRun) {
                const incomingCount = (db.prepare(
                  'SELECT COUNT(*) as c FROM relationships WHERE target = ? OR target = ?'
                ).get(node.title, node.file_path) as { c: number }).c;
                const incomingRows = db.prepare(`
                  SELECT r.source_id as node_id, n.title, n.file_path
                  FROM relationships r JOIN nodes n ON n.id = r.source_id
                  WHERE r.target = ? OR r.target = ?
                  LIMIT 10
                `).all(node.title, node.file_path) as Array<{ node_id: string; title: string; file_path: string }>;
                preview_refs = { count: incomingCount, nodes: incomingRows };
              }

              executeDeletion(db, writeLock, vaultPath, {
                source: 'batch',
                node_id: node.node_id,
                file_path: node.file_path,
                unlink_file: !dryRun,
              }, operation_id ? { operation_id } : undefined);
              if (!dryRun) deletedNodeIds.push(node.node_id);

              results.push({ op: 'delete', node_id: node.node_id, file_path: node.file_path });
              if (dryRun && preview_refs) {
                would_apply.push({
                  op: 'delete',
                  node_id: node.node_id,
                  file_path: node.file_path,
                  incoming_reference_count: preview_refs.count,
                  referencing_nodes: preview_refs.nodes,
                });
              }
            }
          } catch (err) {
            if (err instanceof PipelineError) {
              const details: Record<string, unknown> = {};
              if (err.validation) {
                details.issues = err.validation.issues.map(adaptIssue);
                const fixable = buildFixable(err.validation.issues, err.validation.effective_fields);
                if (fixable.length > 0) details.fixable = fixable;
              }
              batchError = { failed_at: i, op, message: err.message, details };
            } else {
              batchError = { failed_at: i, op, message: err instanceof Error ? err.message : String(err), details: {} };
            }
            // Throw to trigger SQLite transaction rollback
            throw err;
          }
        }

        if (dryRun) throw new DryRunRollback();
        return results;
      });

      try {
        try {
          const applied = txn();
          // Success: clean up backups and orphaned vec rows for deleted nodes.
          cleanupBackups(backups.map(b => b.backupPath));
          for (const nodeId of deletedNodeIds) {
            embeddingIndexer?.removeNode(nodeId);
          }
          return ok({ applied: true, results: applied }, warnings);
        } catch (err) {
          // Dry-run paths: both successful preview (sentinel) and mid-batch failure.
          if (dryRun) {
            // No file restoration needed: backups[] and createdFiles[] are empty under dry_run gating.
            if (err instanceof DryRunRollback) {
              return ok({
                dry_run: true,
                op_count: params.operations.length,
                would_apply,
              }, warnings);
            }
            // Real op failure inside dry-run txn.
            if (batchError) {
              return ok({
                dry_run: true,
                failed_at: batchError.failed_at,
                op: batchError.op,
                message: batchError.message,
                would_apply,
              }, warnings);
            }
            return fail('INTERNAL_ERROR', err instanceof Error ? err.message : 'Batch dry-run failed', { warnings: warnings });
          }

          // Live-path rollback: DB transaction rolled back. Now revert file writes.
          const rollbackFailures: string[] = [];

          // 1. Restore backed-up files (updates and deletes)
          for (const { filePath, backupPath } of backups) {
            try {
              restoreFile(backupPath, filePath);
            } catch (err) {
              const msg = `Failed to restore ${filePath}: ${err instanceof Error ? err.message : err}`;
              console.error(`[batch-mutate] ${msg}`);
              rollbackFailures.push(msg);
            }
          }
          // 2. Delete newly created files
          for (const absPath of createdFiles) {
            try {
              unlinkSync(absPath);
            } catch (err) {
              const msg = `Failed to delete ${absPath}: ${err instanceof Error ? err.message : err}`;
              console.error(`[batch-mutate] ${msg}`);
              rollbackFailures.push(msg);
            }
          }

          if (batchError) {
            const details: Record<string, unknown> = {
              failed_at: batchError.failed_at,
              op: batchError.op,
              ...batchError.details,
            };
            if (rollbackFailures.length > 0) {
              details.rollback_failures = rollbackFailures;
            }
            // Surface DEPRECATED_PARAM warnings even on failure — a caller using a
            // deprecated param should see the warning regardless of whether the op succeeded.
            return fail('BATCH_FAILED', batchError.message, { details, warnings: warnings });
          }
          return fail('INTERNAL_ERROR', 'Batch operation failed', { warnings: warnings });
        }
      } finally {
        if (operation_id) finalizeOperation(db, operation_id);
      }
    },
  );
}

function countKinds(ops: Array<{ op: string }>): string {
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}
