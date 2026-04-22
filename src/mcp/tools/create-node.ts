// src/mcp/tools/create-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { ok, fail, adaptIssue } from './errors.js';
import { checkTitleSafety, checkBodyFrontmatter } from './title-warnings.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { resolveDirectory } from '../../schema/paths.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
import { buildFixable } from '../../validation/fixable.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';

const paramsShape = {
  title: z.string(),
  types: z.array(z.string()).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
  body: z.string().default(''),
  directory: z.string().optional(),
  override_default_directory: z.boolean().default(false),
  dry_run: z.boolean().default(false),
};

export function registerCreateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
): void {
  server.tool(
    'create-node',
    'Create a new node and write it to disk. Every type in types must have a defined schema — call list-schemas to see available types. For general-purpose notes and reference material, use type note. File location is derived from the type\'s schema (default_directory + filename_template). To override the schema directory, pass directory with override_default_directory: true. Use dry_run: true to validate types and fields before generating long body content — this catches errors without wasting work.',
    paramsShape,
    async (params) => {
      const { title, types = [], fields = {}, body = '', directory, override_default_directory = false, dry_run: dryRun = false } = params;

      // ── Type-schema check (Stage 1 gate) ──────────────────────────
      const typeCheck = checkTypesHaveSchemas(db, types);
      if (!typeCheck.valid) {
        return fail(
          'UNKNOWN_TYPE',
          `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
          {
            details: {
              unknown_types: typeCheck.unknown,
              available_schemas: typeCheck.available,
              suggestion: `Cannot write node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first. For general-purpose notes and reference material, use type 'note'.`,
            },
          },
        );
      }

      // ── Resolve directory via shared helper ───────────────────────
      const dirResult = resolveDirectory(db, {
        types,
        directory,
        override_default_directory,
      });
      if (!dirResult.ok) return fail(dirResult.code, dirResult.message);

      // Filename template lookup — still inline (separate concern)
      let fileName = `${title}.md`;
      if (types.length >= 1) {
        const schema = db.prepare('SELECT filename_template FROM schemas WHERE name = ?')
          .get(types[0]) as { filename_template: string | null } | undefined;
        if (schema?.filename_template) {
          const derived = evaluateTemplate(schema.filename_template, title, fields);
          if (derived === null) {
            return fail('INVALID_PARAMS', 'Filename template has unresolved variables');
          }
          fileName = derived;
        }
      }
      const filePath = dirResult.directory
        ? `${dirResult.directory}/${fileName}`
        : fileName;

      // ── Compute warnings ────────────────────────────────────────
      const titleIssues = checkTitleSafety(title);
      const bodyIssues = checkBodyFrontmatter(body);
      const extraIssues = [...titleIssues, ...bodyIssues];

      // Conflict check
      const existing = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as { id: string; title: string } | undefined;
      safeVaultPath(vaultPath, filePath); // throws on path traversal
      const diskConflict = existsSync(join(vaultPath, filePath));

      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        const { claimsByType, globalFields } = loadSchemaContext(db, types);
        const validation = validateProposedState(fields, types, claimsByType, globalFields);
        const conflict = existing
          ? `File path "${filePath}" already exists (node: ${existing.title})`
          : diskConflict ? `File "${filePath}" already exists on disk` : undefined;
        const allIssues = [...validation.issues, ...extraIssues];
        return ok(
          {
            dry_run: true,
            would_create: {
              file_path: filePath,
              title,
              types,
              coerced_state: validation.coerced_state,
              fixable: buildFixable(validation.issues, validation.effective_fields),
              orphan_fields: validation.orphan_fields,
              ...(conflict ? { conflict } : {}),
            },
          },
          allIssues.map(adaptIssue),
        );
      }

      // Non-dry-run: reject conflicts
      if (existing) {
        return fail('INVALID_PARAMS', `File path "${filePath}" already exists (node: ${existing.title})`);
      }
      if (diskConflict) {
        return fail('INVALID_PARAMS', `File "${filePath}" already exists on disk`);
      }

      // ── Undo operation setup ────────────────────────────────────────
      // Dry-run path returned above, so we're always on the live-write path
      // here and must always create an operation.
      const operation_id = createOperation(db, {
        source_tool: 'create-node',
        description: `create-node: '${title}'`,
      });

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: null,
          file_path: filePath,
          title,
          types,
          fields,
          body,
        }, syncLogger, { operation_id });

        return ok(
          {
            node_id: result.node_id,
            file_path: result.file_path,
            title,
            types,
            coerced_state: result.validation.coerced_state,
            orphan_fields: result.validation.orphan_fields,
          },
          [...result.validation.issues, ...extraIssues].map(adaptIssue),
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
        finalizeOperation(db, operation_id);
      }
    },
  );
}

function evaluateTemplate(template: string, title: string, fields: Record<string, unknown>): string | null {
  const today = new Date().toISOString().split('T')[0];
  const vars: Record<string, string> = { title, date: today };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') vars[k] = v;
  }

  let result = template;
  const missing = template.match(/\{(\w+)\}/g);
  if (missing) {
    for (const m of missing) {
      const varName = m.slice(1, -1);
      if (!(varName in vars)) return null;
      result = result.replace(m, vars[varName]);
    }
  }
  return result;
}
