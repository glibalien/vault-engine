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
import { resolveDirectory } from '../../schema/paths.js';
import { resolveNodeIdentity } from './resolve-identity.js';
import { checkTitleSafety, sanitizeFilename, type ToolIssue } from './title-warnings.js';
import { executeMutation, StaleNodeError } from '../../pipeline/execute.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { resolveTarget } from '../../resolver/resolve.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';

/**
 * A pending filesystem mutation that should be reversed if the surrounding
 * DB transaction throws.
 */
export interface FsRollback {
  push(undo: () => void): void;
}

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
  fsRollback?: FsRollback,
  expectedVersion?: number,
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

  if (expectedVersion !== undefined) {
    const row = db.prepare('SELECT version FROM nodes WHERE id = ?')
      .get(node.node_id) as { version: number } | undefined;
    if (row !== undefined && row.version !== expectedVersion) {
      throw new StaleNodeError(node.node_id, expectedVersion, row.version);
    }
  }

  // 1. Rename file on disk (tracked for filesystem rollback).
  if (newFilePath !== oldFilePath) {
    const oldAbs = join(vaultPath, oldFilePath);
    const newAbs = safeVaultPath(vaultPath, newFilePath);
    if (existsSync(oldAbs)) {
      const newDirPath = dirname(newAbs);
      if (!existsSync(newDirPath)) mkdirSync(newDirPath, { recursive: true });
      renameSync(oldAbs, newAbs);
      fsRollback?.push(() => {
        // Best-effort: only restore if the file is still where we left it
        // and the original slot is free. The aim is to recover the common
        // case where executeMutation never reached its file-write stage.
        if (existsSync(newAbs) && !existsSync(oldAbs)) {
          renameSync(newAbs, oldAbs);
        }
      });
    }
  }

  // 2. Update the renamed node's DB state
  db.prepare('UPDATE nodes SET file_path = ?, title = ?, version = version + 1 WHERE id = ?').run(
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
  }, syncLogger, undoContext, fsRollback);

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
      }, syncLogger, undoContext, fsRollback);
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
  expected_version: z.number().int().min(1).optional(),
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

      // Read ordered types so we honor the same "first type wins" rule as create-node
      const orderedTypes = (db.prepare(
        'SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type'
      ).all(node.node_id) as Array<{ schema_type: string }>).map(r => r.schema_type);

      // Resolve directory via shared helper (covers .md guard + first-type lookup).
      // override_default_directory: true preserves rename-node's existing API contract —
      // an explicit directory param unconditionally wins. create-node gates this behind
      // the flag for new-node creation; rename is an explicit move, so no gate.
      const dirResult = resolveDirectory(db, {
        types: orderedTypes,
        directory: params.directory,
        override_default_directory: true,
      });
      if (!dirResult.ok) return fail(dirResult.code, dirResult.message);

      // When no type has a schema default, preserve the current directory
      // instead of moving the file to the vault root.
      const newDir = dirResult.source === 'root' ? dirname(oldFilePath) : dirResult.directory;

      const sanitized = sanitizeFilename(`${params.new_title}.md`);
      const newFilePath = newDir === '.' || newDir === ''
        ? sanitized.filename
        : `${newDir}/${sanitized.filename}`;

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

      // Execute in a single transaction. Track filesystem mutations so we can
      // reverse the on-disk rename if the txn throws (DB rolls back, but the
      // file is already at the new path otherwise).
      const fsUndos: Array<() => void> = [];
      const fsRollback: FsRollback = { push: (u) => fsUndos.push(u) };
      const txn = db.transaction(() => {
        return executeRename(db, writeLock, vaultPath, {
          node_id: node.node_id,
          file_path: oldFilePath,
          title: oldTitle,
        }, params.new_title, newFilePath, syncLogger, { operation_id }, fsRollback, params.expected_version);
      });

      try {
        const { refsUpdated } = txn();
        const version = getNodeVersion(db, node.node_id);
        // Patch description now that refsUpdated is known.
        db.prepare('UPDATE undo_operations SET description = ? WHERE operation_id = ?')
          .run(
            `rename-node: '${oldTitle}' -> '${params.new_title}' (${refsUpdated} references rewritten)`,
            operation_id,
          );
        const issues: ToolIssue[] = checkTitleSafety(params.new_title);
        if (sanitized.sanitized) {
          issues.push({
            code: 'TITLE_FILENAME_SANITIZED',
            message: `Title contains path-separator characters; replaced with '-' in filename: ${sanitized.characters.join(' ')}`,
            characters: sanitized.characters,
          });
        }
        return ok(
          {
            node_id: node.node_id,
            old_file_path: oldFilePath,
            new_file_path: newFilePath,
            old_title: oldTitle,
            new_title: params.new_title,
            references_updated: refsUpdated,
            version,
          },
          issues.map(adaptIssue),
        );
      } catch (err) {
        // DB rolled back; reverse any filesystem mutations performed during
        // the txn so disk state matches the rolled-back DB. Reverse order so
        // multi-step mutations unwind correctly.
        for (let i = fsUndos.length - 1; i >= 0; i--) {
          try {
            fsUndos[i]();
          } catch (undoErr) {
            const msg = undoErr instanceof Error ? undoErr.message : String(undoErr);
            console.error(`[rename-node] fs rollback failed: ${msg}`);
          }
        }
        if (err instanceof StaleNodeError) {
          return buildStaleNodeEnvelope(db, err);
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
