import { stat, readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type Database from 'better-sqlite3';
import type { ExtractionCache } from './cache.js';
import type { AssembledNode, EmbedEntry, EmbedError } from './types.js';
import { resolveTarget } from '../resolver/resolve.js';

/**
 * Search the vault recursively for a file by basename.
 * Obsidian resolves ![[filename]] by searching the entire vault, not just
 * the vault root. Binary files (audio, images, etc.) aren't in the nodes
 * table, so we need a filesystem search.
 */
async function findFileInVault(vaultPath: string, filename: string): Promise<string | null> {
  const target = basename(filename);
  async function search(dir: string): Promise<string | null> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden dirs like .vault-engine
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name === target) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = await search(fullPath);
        if (found) return found;
      }
    }
    return null;
  }
  return search(vaultPath);
}

export interface AssembleOptions {
  maxEmbeds?: number;
  maxFileSizeBytes?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_EMBEDS = 20;
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_MAX_DEPTH = 5;

const EMBED_REGEX = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function parseEmbedReferences(body: string): string[] {
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex in case regex is reused
  EMBED_REGEX.lastIndex = 0;
  while ((match = EMBED_REGEX.exec(body)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
}

interface NodeTypeRow {
  schema_type: string;
}

interface NodeFieldRow {
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

export async function assemble(
  db: Database.Database,
  nodeId: string,
  cache: ExtractionCache,
  vaultPath: string,
  options?: AssembleOptions,
): Promise<AssembledNode> {
  const maxEmbeds = options?.maxEmbeds ?? DEFAULT_MAX_EMBEDS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Load node
  const node = db
    .prepare('SELECT id, file_path, title, body FROM nodes WHERE id = ?')
    .get(nodeId) as NodeRow | undefined;

  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  // Load types
  const types = (
    db
      .prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(nodeId) as NodeTypeRow[]
  ).map((r) => r.schema_type);

  // Load fields
  const fieldRows = db
    .prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(nodeId) as NodeFieldRow[];

  const fields: Record<string, unknown> = {};
  for (const row of fieldRows) {
    if (row.value_json !== null) {
      fields[row.field_name] = JSON.parse(row.value_json);
    } else if (row.value_number !== null) {
      fields[row.field_name] = row.value_number;
    } else if (row.value_date !== null) {
      fields[row.field_name] = row.value_date;
    } else {
      fields[row.field_name] = row.value_text;
    }
  }

  const embeds: EmbedEntry[] = [];
  const errors: EmbedError[] = [];
  const visited = new Set<string>([nodeId]);

  // Process embeds from the node's body
  if (node.body) {
    const refs = parseEmbedReferences(node.body);
    await processEmbeds(
      db, cache, vaultPath, refs, null, embeds, errors, visited,
      maxEmbeds, maxFileSizeBytes, maxDepth, 0,
    );
  }

  return {
    node: { title: node.title, types, fields },
    body: node.body,
    embeds,
    errors,
  };
}

async function processEmbeds(
  db: Database.Database,
  cache: ExtractionCache,
  vaultPath: string,
  refs: string[],
  parentRef: string | null,
  embeds: EmbedEntry[],
  errors: EmbedError[],
  visited: Set<string>,
  maxEmbeds: number,
  maxFileSizeBytes: number,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const ref of refs) {
    // Check embed limit
    if (embeds.length >= maxEmbeds) {
      errors.push({ reference: ref, error: 'TRUNCATED' });
      return;
    }

    // Resolve to file path
    const ext = extname(ref).toLowerCase();
    let filePath: string;
    let resolvedNodeId: string | null = null;

    if (ext !== '' && ext !== '.md') {
      // Non-markdown with extension: try relative path first, then search vault
      const directPath = join(vaultPath, ref);
      try {
        await stat(directPath);
        filePath = directPath;
      } catch {
        // File not at vault root — search vault by basename (Obsidian behavior)
        const found = await findFileInVault(vaultPath, ref);
        if (found) {
          filePath = found;
        } else {
          errors.push({ reference: ref, error: `File not found in vault: ${ref}` });
          continue;
        }
      }
    } else {
      // Markdown or no extension: use resolver
      const resolved = resolveTarget(db, ref);
      if (!resolved) {
        // Try with .md stripped if it has .md
        const stripped = ref.endsWith('.md') ? ref.slice(0, -3) : ref + '.md';
        const resolved2 = resolveTarget(db, stripped);
        if (!resolved2) {
          errors.push({ reference: ref, error: `Could not resolve reference: ${ref}` });
          continue;
        }
        resolvedNodeId = resolved2.id;
        const nodeRow = db
          .prepare('SELECT file_path FROM nodes WHERE id = ?')
          .get(resolved2.id) as { file_path: string } | undefined;
        filePath = nodeRow ? join(vaultPath, nodeRow.file_path) : join(vaultPath, ref);
      } else {
        resolvedNodeId = resolved.id;
        const nodeRow = db
          .prepare('SELECT file_path FROM nodes WHERE id = ?')
          .get(resolved.id) as { file_path: string } | undefined;
        filePath = nodeRow ? join(vaultPath, nodeRow.file_path) : join(vaultPath, ref);
      }
    }

    // Check file size
    try {
      const stats = await stat(filePath);
      if (stats.size > maxFileSizeBytes) {
        errors.push({ reference: ref, error: 'FILE_TOO_LARGE' });
        continue;
      }
    } catch {
      // File doesn't exist on disk
      errors.push({ reference: ref, error: `File not found: ${filePath}` });
      continue;
    }

    // Try extraction
    try {
      const extraction = await cache.getExtraction(filePath);
      const entry: EmbedEntry = {
        reference: ref,
        mediaType: extraction.mediaType,
        text: extraction.text,
      };
      if (parentRef) {
        entry.source = parentRef;
      }
      embeds.push(entry);

      // Recursive markdown embeds
      if (extraction.mediaType === 'markdown' && depth < maxDepth && resolvedNodeId !== null) {
        if (!visited.has(resolvedNodeId)) {
          visited.add(resolvedNodeId);
          const subNode = db
            .prepare('SELECT body FROM nodes WHERE id = ?')
            .get(resolvedNodeId) as { body: string | null } | undefined;
          if (subNode?.body) {
            const subRefs = parseEmbedReferences(subNode.body);
            if (subRefs.length > 0) {
              await processEmbeds(
                db, cache, vaultPath, subRefs, ref, embeds, errors, visited,
                maxEmbeds, maxFileSizeBytes, maxDepth, depth + 1,
              );
            }
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ reference: ref, error: message });
    }
  }
}
