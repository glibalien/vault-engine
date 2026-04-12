// src/mcp/tools/batch-mutate.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { toolResult, toolErrorResult } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { backupFile, restoreFile, cleanupBackups } from '../../pipeline/file-writer.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const operationSchema = z.object({
  op: z.enum(['create', 'update', 'delete']),
  params: z.record(z.string(), z.unknown()),
});

const paramsShape = {
  operations: z.array(operationSchema),
};

export function registerBatchMutate(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
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

      let batchError: { failed_at: number; error: { op: string; message: string } } | null = null as { failed_at: number; error: { op: string; message: string } } | null;

      const txn = db.transaction(() => {
        for (let i = 0; i < params.operations.length; i++) {
          const { op, params: opParams } = params.operations[i];

          try {
            if (op === 'create') {
              const title = opParams.title as string;
              const types = (opParams.types as string[]) ?? [];
              const fields = (opParams.fields as Record<string, unknown>) ?? {};
              const body = (opParams.body as string) ?? '';
              const path = opParams.path as string | undefined;

              // Type-schema check
              const typeCheck = checkTypesHaveSchemas(db, types);
              if (!typeCheck.valid) {
                throw new PipelineError('UNKNOWN_TYPE',
                  `Cannot create node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
              }

              const filePath = path ? `${path}/${title}.md` : `${title}.md`;
              const absPath = join(vaultPath, filePath);

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
              });
              if (result.file_written) createdFiles.push(absPath);
              results.push({ op: 'create', node_id: result.node_id, file_path: result.file_path });

            } else if (op === 'update') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id as string | undefined,
                file_path: opParams.file_path as string | undefined,
                title: opParams.title as string | undefined,
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

              const setFields = opParams.set_fields as Record<string, unknown> | undefined;
              const finalFields = { ...currentFields };
              if (setFields) {
                for (const [key, value] of Object.entries(setFields)) {
                  finalFields[key] = value; // null passes through as deletion intent
                }
              }

              const setTypes = opParams.set_types as string[] | undefined;
              if (setTypes) {
                const typeCheck = checkTypesHaveSchemas(db, setTypes);
                if (!typeCheck.valid) {
                  throw new PipelineError('UNKNOWN_TYPE',
                    `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
                }
              }

              const result = executeMutation(db, writeLock, vaultPath, {
                source: 'tool',
                node_id: node.node_id,
                file_path: node.file_path,
                title: (opParams.set_title as string) ?? node.title,
                types: setTypes ?? currentTypes,
                fields: finalFields,
                body: (opParams.set_body as string) ?? currentBody,
              });
              results.push({ op: 'update', node_id: result.node_id, file_path: result.file_path });

            } else if (op === 'delete') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id as string | undefined,
                file_path: opParams.file_path as string | undefined,
                title: opParams.title as string | undefined,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const absPath = join(vaultPath, node.file_path);

              // Back up the file before deleting
              const bp = backupFile(absPath, tmpDir);
              if (bp) backups.push({ filePath: absPath, backupPath: bp });

              const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(node.node_id) as { rowid: number } | undefined;
              if (rowInfo) db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowInfo.rowid);
              db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
                node.node_id, Date.now(), 'file-deleted', node.file_path,
              );
              db.prepare('DELETE FROM nodes WHERE id = ?').run(node.node_id);

              try { unlinkSync(absPath); } catch {}
              results.push({ op: 'delete', node_id: node.node_id, file_path: node.file_path });
            }
          } catch (err) {
            if (err instanceof PipelineError) {
              batchError = { failed_at: i, error: { op, message: err.message } };
            } else {
              batchError = { failed_at: i, error: { op, message: err instanceof Error ? err.message : String(err) } };
            }
            // Throw to trigger SQLite transaction rollback
            throw err;
          }
        }

        return results;
      });

      try {
        const applied = txn();
        // Success: clean up backups
        cleanupBackups(backups.map(b => b.backupPath));
        return toolResult({ applied: true, results: applied });
      } catch {
        // DB transaction rolled back. Now revert file writes.
        // 1. Restore backed-up files (updates and deletes)
        for (const { filePath, backupPath } of backups) {
          try {
            restoreFile(backupPath, filePath);
          } catch {
            // Best effort
          }
        }
        // 2. Delete newly created files
        for (const absPath of createdFiles) {
          try {
            unlinkSync(absPath);
          } catch {
            // Best effort
          }
        }

        if (batchError) {
          return toolResult({ applied: false, failed_at: batchError.failed_at, error: batchError.error });
        }
        return toolErrorResult('INTERNAL_ERROR', 'Batch operation failed');
      }
    },
  );
}
