import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join, basename } from 'node:path';
import { toolResult } from './errors.js';
import type { ExtractionCache } from '../../extraction/cache.js';

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
        resolvedPath = join(vaultPath, file_path);
      } else {
        // Resolve filename: find all nodes whose basename matches
        const allNodes = db.prepare('SELECT file_path FROM nodes').all() as { file_path: string }[];
        const matches = allNodes.filter(n => basename(n.file_path) === filename);

        if (matches.length === 0) {
          resolvedPath = join(vaultPath, filename!);
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
