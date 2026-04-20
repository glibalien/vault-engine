import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { basename } from 'node:path';
import { ok, fail } from './errors.js';
import { resolveFieldValue, type FieldRow } from '../field-value.js';
import { resolveTarget } from '../../resolver/resolve.js';
import { getNodeConformance } from '../../validation/conformance.js';
import type { ExtractionCache } from '../../extraction/cache.js';
import { assemble } from '../../extraction/assembler.js';
import { performExpansion } from '../expand.js';

const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  include_embeds: z.boolean().optional().default(true),
  max_embeds: z.number().optional().default(20),
  expand: z.object({
    types: z.array(z.string()).min(1, 'types must be non-empty'),
    direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('outgoing'),
    max_nodes: z.number().int().min(1).max(25).optional().default(10),
  }).optional(),
};

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  content_hash: string | null;
  file_mtime: number | null;
  indexed_at: number | null;
}

interface RelRow {
  id: number;
  source_id: string;
  target: string;
  rel_type: string;
  context: string | null;
}

export function registerGetNode(
  server: McpServer,
  db: Database.Database,
  extractionCache?: ExtractionCache,
  vaultPath?: string,
): void {
  server.tool(
    'get-node',
    'Returns full details for a single node. Specify exactly one of: node_id, file_path, or title.',
    paramsShape,
    async (params) => {
      const { node_id, file_path, title } = params;

      // Validate exactly one param provided
      const provided = [node_id, file_path, title].filter(v => v !== undefined);
      if (provided.length === 0) {
        return fail('INVALID_PARAMS', 'Exactly one of node_id, file_path, or title is required');
      }
      if (provided.length > 1) {
        return fail('INVALID_PARAMS', 'Exactly one of node_id, file_path, or title is required');
      }

      let node: NodeRow | undefined;

      if (node_id) {
        node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node_id) as NodeRow | undefined;
      } else if (file_path) {
        node = db.prepare('SELECT * FROM nodes WHERE file_path = ?').get(file_path) as NodeRow | undefined;
      } else if (title) {
        // First try exact title match
        node = db.prepare('SELECT * FROM nodes WHERE title = ?').get(title) as NodeRow | undefined;
        if (!node) {
          // Fall back to four-tier path/basename resolution
          const resolved = resolveTarget(db, title);
          if (resolved) {
            node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(resolved.id) as NodeRow | undefined;
          }
        }
      }

      if (!node) {
        return fail('NOT_FOUND', 'Node not found');
      }

      // Get types
      const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY rowid')
        .all(node.id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      // Get fields
      const fieldRows = db.prepare('SELECT * FROM node_fields WHERE node_id = ?')
        .all(node.id) as FieldRow[];
      const fields: Record<string, { value: unknown; type: string; source: string }> = {};
      for (const f of fieldRows) {
        const value = resolveFieldValue(f);
        const type = f.value_json !== null ? 'json'
          : f.value_number !== null ? 'number'
          : f.value_date !== null ? 'date'
          : 'text';
        fields[f.field_name] = { value, type, source: f.source };
      }

      // Get outgoing relationships
      const outgoing = db.prepare('SELECT * FROM relationships WHERE source_id = ?')
        .all(node.id) as RelRow[];

      // Get incoming relationships
      // Match relationships where target matches this node's file_path, basename, or title
      const nodeBasename = basename(node.file_path, '.md');
      const incoming = db.prepare(
        'SELECT r.*, n.title as source_title FROM relationships r JOIN nodes n ON n.id = r.source_id WHERE (r.target = ? OR r.target = ? OR r.target = ?) AND r.source_id != ?'
      ).all(node.file_path, nodeBasename, node.title ?? '', node.id) as Array<RelRow & { source_title: string | null }>;

      // Deduplicate incoming by (source_id, rel_type)
      const incomingSeen = new Set<string>();
      const incomingDeduped = incoming.filter(r => {
        const key = `${r.source_id}:${r.rel_type}`;
        if (incomingSeen.has(key)) return false;
        incomingSeen.add(key);
        return true;
      });

      // Group outgoing
      const outgoingGrouped: Record<string, Array<{ target_id: string | null; target_title: string; context?: string }>> = {};
      for (const r of outgoing) {
        if (!outgoingGrouped[r.rel_type]) outgoingGrouped[r.rel_type] = [];
        // Try to resolve target to get target_id: first by title, then by path/basename
        let targetId: string | null = null;
        const byTitle = db.prepare('SELECT id FROM nodes WHERE title = ?').get(r.target) as { id: string } | undefined;
        if (byTitle) {
          targetId = byTitle.id;
        } else {
          const resolved = resolveTarget(db, r.target);
          targetId = resolved?.id ?? null;
        }
        const entry: { target_id: string | null; target_title: string; context?: string } = {
          target_id: targetId,
          target_title: r.target,
        };
        if (r.context) entry.context = r.context;
        outgoingGrouped[r.rel_type].push(entry);
      }

      // Group incoming
      const incomingGrouped: Record<string, Array<{ source_id: string; source_title: string | null; context?: string }>> = {};
      for (const r of incomingDeduped) {
        if (!incomingGrouped[r.rel_type]) incomingGrouped[r.rel_type] = [];
        const entry: { source_id: string; source_title: string | null; context?: string } = {
          source_id: r.source_id,
          source_title: r.source_title,
        };
        if (r.context) entry.context = r.context;
        incomingGrouped[r.rel_type].push(entry);
      }

      const resultObj: Record<string, unknown> = {
        id: node.id,
        file_path: node.file_path,
        title: node.title,
        types,
        fields,
        relationships: { outgoing: outgoingGrouped, incoming: incomingGrouped },
        body: node.body,
        metadata: {
          content_hash: node.content_hash,
          file_mtime: node.file_mtime,
          indexed_at: node.indexed_at,
        },
        conformance: getNodeConformance(db, node.id, types),
      };

      if (params.expand) {
        const { expanded, stats } = performExpansion(db, node.id, {
          types: params.expand.types,
          direction: params.expand.direction,
          max_nodes: params.expand.max_nodes,
        });
        resultObj.expanded = expanded;
        resultObj.expand_stats = stats;
      }

      const includeEmbeds = params.include_embeds ?? true;
      const maxEmbeds = params.max_embeds ?? 20;

      if (includeEmbeds && extractionCache && vaultPath) {
        const assembled = await assemble(db, node.id, extractionCache, vaultPath, {
          maxEmbeds,
        });
        resultObj.embeds = assembled.embeds;
        resultObj.embed_errors = assembled.errors;
      } else if (includeEmbeds) {
        // No cache configured — return empty embeds
        resultObj.embeds = [];
        resultObj.embed_errors = [];
      }

      return ok(resultObj);
    },
  );
}
