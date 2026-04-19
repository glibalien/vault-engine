// src/mcp/tools/batch-mutate.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { ok, fail, adaptIssue } from './errors.js';
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
  path: z.string().optional(),
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
};

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
    'Execute multiple mutation operations atomically. All operations succeed or all roll back. Rename is not supported in batch.',
    paramsShape,
    async (params) => {
      const results: Array<{ op: string; node_id: string; file_path: string }> = [];
      const tmpDir = join(vaultPath, '.vault-engine', 'tmp');

      // Track file state for rollback: files that existed before (backed up)
      // and files that were created new (to be deleted on rollback)
      const backups: Array<{ filePath: string; backupPath: string }> = [];
      const createdFiles: string[] = [];
      // Track node IDs deleted in this batch so we can clean up vec rows after commit.
      const deletedNodeIds: string[] = [];

      let batchError: { failed_at: number; op: string; message: string; details: Record<string, unknown> } | null = null as { failed_at: number; op: string; message: string; details: Record<string, unknown> } | null;

      const operation_id = createOperation(db, {
        source_tool: 'batch-mutate',
        description: `batch-mutate: ${params.operations.length} ops (${countKinds(params.operations)})`,
      });

      const txn = db.transaction(() => {
        for (let i = 0; i < params.operations.length; i++) {
          const { op, params: opParams } = params.operations[i];

          try {
            if (op === 'create') {
              const title = opParams.title;
              const types = opParams.types ?? [];
              const fields = opParams.fields ?? {};
              const body = opParams.body ?? '';
              const path = opParams.path;

              // Type-schema check
              const typeCheck = checkTypesHaveSchemas(db, types);
              if (!typeCheck.valid) {
                throw new PipelineError('UNKNOWN_TYPE',
                  `Cannot create node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
              }

              const filePath = path ? `${path}/${title}.md` : `${title}.md`;
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
              }, syncLogger, { operation_id });
              if (result.file_written) createdFiles.push(absPath);
              results.push({ op: 'create', node_id: result.node_id, file_path: result.file_path });

            } else if (op === 'update') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id,
                file_path: opParams.file_path,
                title: opParams.title,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const absPath = join(vaultPath, node.file_path);

              // Back up the existing file before mutation
              const bp = backupFile(absPath, tmpDir);
              if (bp) backups.push({ filePath: absPath, backupPath: bp });

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
              }, syncLogger, { operation_id });
              results.push({ op: 'update', node_id: result.node_id, file_path: result.file_path });

            } else if (op === 'delete') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id,
                file_path: opParams.file_path,
                title: opParams.title,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const absPath = join(vaultPath, node.file_path);

              // Back up the file before deleting
              const bp = backupFile(absPath, tmpDir);
              if (bp) backups.push({ filePath: absPath, backupPath: bp });

              executeDeletion(db, writeLock, vaultPath, {
                source: 'batch',
                node_id: node.node_id,
                file_path: node.file_path,
                unlink_file: true,
              }, { operation_id });
              deletedNodeIds.push(node.node_id);

              results.push({ op: 'delete', node_id: node.node_id, file_path: node.file_path });
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
          return ok({ applied: true, results: applied });
        } catch {
          // DB transaction rolled back. Now revert file writes.
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
            return fail('BATCH_FAILED', batchError.message, { details });
          }
          return fail('INTERNAL_ERROR', 'Batch operation failed');
        }
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}

function countKinds(ops: Array<{ op: string }>): string {
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}
