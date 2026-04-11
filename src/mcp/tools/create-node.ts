// src/mcp/tools/create-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toolResult, toolErrorResult } from './errors.js';
import { executeMutation } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import type { WriteLockManager } from '../../sync/write-lock.js';

const paramsShape = {
  title: z.string(),
  types: z.array(z.string()).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
  body: z.string().default(''),
  path: z.string().optional(),
};

export function registerCreateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
): void {
  server.tool(
    'create-node',
    'Create a new node and write it to disk. Validates against schemas, coerces values, populates defaults.',
    paramsShape,
    async (params) => {
      const { title, types, fields, body, path: dirPath } = params;

      // Derive file path
      let filePath: string;
      if (dirPath) {
        filePath = `${dirPath}/${title}.md`;
      } else {
        // Check for filename template
        if (types.length === 1) {
          const schema = db.prepare('SELECT filename_template FROM schemas WHERE name = ?').get(types[0]) as { filename_template: string | null } | undefined;
          if (schema?.filename_template) {
            const derived = evaluateTemplate(schema.filename_template, title, fields);
            if (derived === null) {
              return toolErrorResult('INVALID_PARAMS', 'Filename template has unresolved variables');
            }
            filePath = derived;
          } else {
            filePath = `${title}.md`;
          }
        } else {
          filePath = `${title}.md`;
        }
      }

      // Conflict check
      const existing = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as { id: string; title: string } | undefined;
      if (existing) {
        return toolErrorResult('INVALID_PARAMS', `File path "${filePath}" already exists (node: ${existing.title})`);
      }
      if (existsSync(join(vaultPath, filePath))) {
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
        });

        return toolResult({
          node_id: result.node_id,
          file_path: result.file_path,
          title,
          types,
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
