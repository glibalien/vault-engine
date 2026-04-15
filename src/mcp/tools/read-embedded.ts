import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join, basename } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { toolResult } from './errors.js';
import type { ExtractionCache } from '../../extraction/cache.js';

/** Search vault recursively for a file by basename (binary files aren't in nodes table). */
async function findFileInVault(vaultPath: string, filename: string): Promise<string | null> {
  const target = basename(filename);
  async function search(dir: string): Promise<string | null> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && entry.name === target) return fullPath;
      if (entry.isDirectory()) {
        const found = await search(fullPath);
        if (found) return found;
      }
    }
    return null;
  }
  return search(vaultPath);
}

export function registerReadEmbedded(
  server: McpServer,
  db: Database.Database,
  extractionCache: ExtractionCache,
  vaultPath: string,
): void {
  server.tool(
    'read-embedded',
    'Extract and return the content of a single embedded file. Supports audio (transcription), images (OCR), PDFs, office docs, and markdown. Specify file_path (vault-relative) or filename (basename to resolve).',
    {
      file_path: z.string().optional().describe('Vault-relative path to the file'),
      filename: z.string().optional().describe('Filename to resolve (basename match)'),
    },
    async (params) => {
      const { file_path, filename } = params;

      if (!file_path && !filename) {
        return toolResult({ error: 'Exactly one of file_path or filename is required', code: 'INVALID_PARAMS' });
      }
      if (file_path && filename) {
        return toolResult({ error: 'Provide only one of file_path or filename', code: 'INVALID_PARAMS' });
      }

      let resolvedPath: string;

      if (file_path) {
        resolvedPath = safeVaultPath(vaultPath, file_path);
      } else {
        // Resolve filename: find all nodes whose basename matches
        const allNodes = db.prepare('SELECT file_path FROM nodes').all() as { file_path: string }[];
        const matches = allNodes.filter(n => basename(n.file_path) === filename);

        if (matches.length === 0) {
          // Binary files (audio, images) aren't in nodes table — search vault
          const directPath = safeVaultPath(vaultPath, filename!);
          try {
            await stat(directPath);
            resolvedPath = directPath;
          } catch {
            const found = await findFileInVault(vaultPath, filename!);
            if (found) {
              resolvedPath = found;
            } else {
              return toolResult({ error: `File not found in vault: ${filename}`, code: 'NOT_FOUND' });
            }
          }
        } else if (matches.length === 1) {
          resolvedPath = join(vaultPath, matches[0].file_path);
        } else {
          return toolResult({
            error: `Multiple files match "${filename}"`,
            code: 'AMBIGUOUS_FILENAME',
            matches: matches.map(m => m.file_path),
          });
        }
      }

      try {
        const result = await extractionCache.getExtraction(resolvedPath);
        return toolResult({
          text: result.text,
          media_type: result.mediaType,
          extractor_id: result.extractorId,
          content_hash: result.contentHash,
          metadata: result.metadata,
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.startsWith('EXTRACTOR_UNAVAILABLE')) {
          return toolResult({ error: message, code: 'EXTRACTOR_UNAVAILABLE' });
        }
        if (message.startsWith('No extractor')) {
          return toolResult({ error: message, code: 'INVALID_PARAMS' });
        }
        return toolResult({ error: message, code: 'INTERNAL_ERROR' });
      }
    },
  );
}
