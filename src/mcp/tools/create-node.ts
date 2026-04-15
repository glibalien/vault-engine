// src/mcp/tools/create-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { toolResult, toolErrorResult, toolValidationErrorResult } from './errors.js';
import { checkTitleSafety, checkBodyFrontmatter } from './title-warnings.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';

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
        return toolResult({
          error: 'UNKNOWN_TYPE',
          unknown_types: typeCheck.unknown,
          message: `Cannot write node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
          available_schemas: typeCheck.available,
          suggestion: 'For general-purpose notes and reference material, use type \'note\'.',
        });
      }

      // ── Validate directory param ──────────────────────────────────
      if (directory !== undefined && directory.endsWith('.md')) {
        return toolErrorResult('INVALID_PARAMS',
          '"directory" must be a folder path, not a filename. The filename is always derived from the node title.');
      }

      // Derive file path
      let filePath: string;
      let fileName = `${title}.md`;
      let schemaDefaultDir: string | null = null;

      if (types.length >= 1) {
        const schema = db.prepare('SELECT filename_template, default_directory FROM schemas WHERE name = ?')
          .get(types[0]) as { filename_template: string | null; default_directory: string | null } | undefined;
        schemaDefaultDir = schema?.default_directory ?? null;

        if (directory !== undefined && schemaDefaultDir && !override_default_directory) {
          return toolErrorResult('INVALID_PARAMS',
            `Type "${types[0]}" routes to "${schemaDefaultDir}/" via schema. Pass override_default_directory: true to place this node elsewhere.`);
        }

        if (schema?.filename_template) {
          const derived = evaluateTemplate(schema.filename_template, title, fields);
          if (derived === null) {
            return toolErrorResult('INVALID_PARAMS', 'Filename template has unresolved variables');
          }
          fileName = derived;
        }
      }

      const dir = directory ?? schemaDefaultDir ?? '';
      filePath = dir ? `${dir}/${fileName}` : fileName;

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
        return toolResult({
          dry_run: true,
          would_create: {
            file_path: filePath,
            title,
            types,
            coerced_state: validation.coerced_state,
            issues: [...validation.issues, ...extraIssues],
            orphan_fields: validation.orphan_fields,
            ...(conflict ? { conflict } : {}),
          },
        });
      }

      // Non-dry-run: reject conflicts
      if (existing) {
        return toolErrorResult('INVALID_PARAMS', `File path "${filePath}" already exists (node: ${existing.title})`);
      }
      if (diskConflict) {
        return toolErrorResult('INVALID_PARAMS', `File "${filePath}" already exists on disk`);
      }

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: null,
          file_path: filePath,
          title,
          types,
          fields,
          body,
        }, syncLogger);

        return toolResult({
          node_id: result.node_id,
          file_path: result.file_path,
          title,
          types,
          coerced_state: result.validation.coerced_state,
          issues: [...result.validation.issues, ...extraIssues],
          orphan_fields: result.validation.orphan_fields,
        });
      } catch (err) {
        if (err instanceof PipelineError && err.validation) {
          return toolValidationErrorResult(err.validation);
        }
        if (err instanceof PipelineError) {
          return toolErrorResult('VALIDATION_FAILED', err.message);
        }
        return toolErrorResult('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
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
