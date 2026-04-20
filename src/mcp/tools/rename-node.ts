// src/mcp/tools/rename-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join, dirname } from 'node:path';
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { Node, Parent } from 'unist';
import type { Text } from 'mdast';
import { ok, fail, adaptIssue } from './errors.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { checkTitleSafety, type ToolIssue } from './title-warnings.js';
import { executeMutation } from '../../pipeline/execute.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { resolveTarget } from '../../resolver/resolve.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';

const SKIP_TYPES = new Set(['code', 'inlineCode', 'yaml']);

/**
 * Capture a pre-mutation undo snapshot for a node whose identity is about to
 * be changed out-of-band (file_path or title) before executeMutation runs.
 *
 * Mirrors the capture shape in `src/pipeline/execute.ts` exactly. Uses
 * INSERT OR IGNORE so a later executeMutation snapshot under the same
 * operation_id silently skips — keeping the pre-state authoritative.
 *
 * Safe to call only when the node already exists in `nodes`.
 */
export function captureRenameSnapshot(
  db: Database.Database,
  operation_id: string,
  nodeId: string,
): void {
  const nodeRow = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?')
    .get(nodeId) as { file_path: string; title: string | null; body: string | null } | undefined;
  if (!nodeRow) return;

  const typesArr = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(r => r.schema_type);
  const fieldsRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ?'
  ).all(nodeId);
  const relRows = db.prepare(
    'SELECT target, rel_type, context FROM relationships WHERE source_id = ?'
  ).all(nodeId);

  db.prepare(`
    INSERT OR IGNORE INTO undo_snapshots (
      operation_id, node_id, file_path, title, body, types, fields, relationships,
      was_deleted, post_mutation_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `).run(
    operation_id,
    nodeId,
    nodeRow.file_path,
    nodeRow.title,
    nodeRow.body,
    JSON.stringify(typesArr),
    JSON.stringify(fieldsRows),
    JSON.stringify(relRows),
  );
}

/**
 * Core rename logic: renames file on disk, updates DB, re-renders, and rewrites references.
 * Must be called inside a db.transaction().
 */
export function executeRename(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  node: { node_id: string; file_path: string; title: string },
  newTitle: string,
  newFilePath: string,
  syncLogger?: SyncLogger,
  undoContext?: { operation_id: string },
): { refsUpdated: number } {
  const oldTitle = node.title;
  const oldFilePath = node.file_path;

  // Find all referencing nodes using full five-tier resolution
  const distinctTargets = db.prepare('SELECT DISTINCT target FROM relationships').all() as { target: string }[];
  const targetsPointingToNode: string[] = [];
  for (const { target } of distinctTargets) {
    const resolved = resolveTarget(db, target);
    if (resolved && resolved.id === node.node_id) {
      targetsPointingToNode.push(target);
    }
  }

  const referencingNodeIds = new Set<string>();
  if (targetsPointingToNode.length > 0) {
    const placeholders = targetsPointingToNode.map(() => '?').join(',');
    const refs = db.prepare(
      `SELECT DISTINCT source_id FROM relationships WHERE target IN (${placeholders}) AND source_id != ?`
    ).all(...targetsPointingToNode, node.node_id) as { source_id: string }[];
    for (const r of refs) referencingNodeIds.add(r.source_id);
  }

  // 0. Capture undo snapshot BEFORE mutating nodes row.
  //    executeMutation can't capture the correct pre-state later because
  //    the UPDATE below mutates file_path/title first. OR IGNORE by the
  //    composite PK means the subsequent executeMutation snapshot insert
  //    is a no-op when it fires under the same operation_id.
  if (undoContext) {
    captureRenameSnapshot(db, undoContext.operation_id, node.node_id);
  }

  // 1. Rename file on disk
  if (newFilePath !== oldFilePath) {
    const oldAbs = join(vaultPath, oldFilePath);
    const newAbs = safeVaultPath(vaultPath, newFilePath);
    if (existsSync(oldAbs)) {
      const newDirPath = dirname(newAbs);
      if (!existsSync(newDirPath)) mkdirSync(newDirPath, { recursive: true });
      renameSync(oldAbs, newAbs);
    }
  }

  // 2. Update the renamed node's DB state
  db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run(
    newFilePath, newTitle, node.node_id,
  );

  // 3. Re-render the renamed node at new path
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
  const fields: Record<string, unknown> = {};
  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
  }
  const body = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

  executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: node.node_id,
    file_path: newFilePath,
    title: newTitle,
    types,
    fields,
    body,
  }, syncLogger, undoContext);

  // 4. Update references in referencing nodes
  let refsUpdated = 0;
  for (const refNodeId of referencingNodeIds) {
    const refNode = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(refNodeId) as { file_path: string; title: string; body: string };
    const refTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(refNodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);
    const refFields: Record<string, unknown> = {};
    const refFieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
      .all(refNodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
    for (const row of refFieldRows) {
      refFields[row.field_name] = reconstructValue(row);
    }

    let changed = false;
    for (const [fieldName, value] of Object.entries(refFields)) {
      if (typeof value === 'string' && value === oldTitle) {
        refFields[fieldName] = newTitle;
        changed = true;
      } else if (Array.isArray(value)) {
        const newArr = value.map(v => (typeof v === 'string' && v === oldTitle) ? newTitle : v);
        if (JSON.stringify(newArr) !== JSON.stringify(value)) {
          refFields[fieldName] = newArr;
          changed = true;
        }
      }
    }

    const newBody = rewriteBodyWikiLinks(refNode.body, targetsPointingToNode, newTitle);
    if (newBody !== refNode.body) changed = true;

    if (changed) {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: refNodeId,
        file_path: refNode.file_path,
        title: refNode.title,
        types: refTypes,
        fields: refFields,
        body: newBody,
      }, syncLogger, undoContext);
      refsUpdated++;
    }
  }

  return { refsUpdated };
}

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  new_title: z.string(),
  directory: z.string().optional(),
};

export function registerRenameNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
): void {
  server.tool(
    'rename-node',
    'Rename a node: updates title, file path, and all wiki-link references vault-wide. The filename is always derived from new_title. Pass directory to move the file; omit it to use the schema default_directory or keep the current directory.',
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
      const oldTitle = node.title;
      const oldFilePath = node.file_path;

      // ── Validate directory param ──────────────────────────────────
      if (params.directory !== undefined && params.directory.endsWith('.md')) {
        return fail('INVALID_PARAMS',
          '"directory" must be a folder path, not a filename. The filename is always derived from the node title.');
      }

      // Derive new directory: explicit param > schema default > current directory
      let newDir: string;
      if (params.directory !== undefined) {
        newDir = params.directory;
      } else {
        const nodeType = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? LIMIT 1')
          .get(node.node_id) as { schema_type: string } | undefined;
        let schemaDefault: string | null = null;
        if (nodeType) {
          const schema = db.prepare('SELECT default_directory FROM schemas WHERE name = ?')
            .get(nodeType.schema_type) as { default_directory: string | null } | undefined;
          schemaDefault = schema?.default_directory ?? null;
        }
        newDir = schemaDefault ?? dirname(oldFilePath);
      }

      const newFilePath = newDir === '.' || newDir === ''
        ? `${params.new_title}.md`
        : `${newDir}/${params.new_title}.md`;

      // Conflict check
      if (newFilePath !== oldFilePath) {
        const conflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(newFilePath) as { id: string; title: string } | undefined;
        if (conflict) {
          return fail('INVALID_PARAMS', `File path "${newFilePath}" already exists (node: ${conflict.title})`);
        }
        if (existsSync(join(vaultPath, newFilePath))) {
          return fail('INVALID_PARAMS', `File "${newFilePath}" already exists on disk`);
        }
      }

      // ── Undo operation setup — shared id across rename + N ref updates ──
      const operation_id = createOperation(db, {
        source_tool: 'rename-node',
        description: `rename-node: '${oldTitle}' -> '${params.new_title}' (references pending)`,
      });

      // Execute in a single transaction
      const txn = db.transaction(() => {
        return executeRename(db, writeLock, vaultPath, {
          node_id: node.node_id,
          file_path: oldFilePath,
          title: oldTitle,
        }, params.new_title, newFilePath, syncLogger, { operation_id });
      });

      try {
        const { refsUpdated } = txn();
        // Patch description now that refsUpdated is known.
        db.prepare('UPDATE undo_operations SET description = ? WHERE operation_id = ?')
          .run(
            `rename-node: '${oldTitle}' -> '${params.new_title}' (${refsUpdated} references rewritten)`,
            operation_id,
          );
        const issues: ToolIssue[] = checkTitleSafety(params.new_title);
        return ok(
          {
            node_id: node.node_id,
            old_file_path: oldFilePath,
            new_file_path: newFilePath,
            old_title: oldTitle,
            new_title: params.new_title,
            references_updated: refsUpdated,
          },
          issues.map(adaptIssue),
        );
      } catch (err) {
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      } finally {
        finalizeOperation(db, operation_id);
      }
    },
  );
}

/**
 * Rewrite wiki-links in body text using AST-aware traversal.
 * Only modifies wiki-links in text nodes — skips code blocks, inline code, and YAML.
 * Preserves aliases: [[old|alias]] → [[new|alias]].
 */
export function rewriteBodyWikiLinks(body: string, targets: string[], newTitle: string): string {
  if (targets.length === 0) return body;

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm);

  const tree = processor.parse(body);
  const targetSet = new Set(targets);

  // Collect replacement ranges: [startOffset, endOffset, replacementText]
  const replacements: Array<[number, number, string]> = [];

  function walk(node: Node): void {
    if (SKIP_TYPES.has(node.type)) return;

    if (node.type === 'text' && node.position) {
      const text = (node as Text).value;
      const nodeStart = node.position.start.offset!;

      const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {  // RegExp.exec, not child_process
        if (targetSet.has(m[1])) {
          const alias = m[2];
          const absStart = nodeStart + m.index;
          const absEnd = absStart + m[0].length;
          const rep = alias ? `[[${newTitle}|${alias}]]` : `[[${newTitle}]]`;
          replacements.push([absStart, absEnd, rep]);
        }
      }
    }

    if ('children' in node) {
      for (const child of (node as Parent).children) {
        walk(child);
      }
    }
  }

  walk(tree);

  if (replacements.length === 0) return body;

  // Apply in reverse order to preserve offsets
  let result = body;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [start, end, rep] = replacements[i];
    result = result.slice(0, start) + rep + result.slice(end);
  }

  return result;
}
