// src/extraction/resolve.ts
//
// Shared embed-reference resolver. Given a vault-relative embed ref (what you
// see inside `![[...]]`), returns the resolved absolute file path plus the
// classification (markdown/non-markdown) and, when applicable, the node id.
//
// Unifies the resolution path used by the assembler (content extraction at
// read time) and the embedding indexer (extraction embedding at write time).

import type Database from 'better-sqlite3';
import { extname, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { findFileInVault } from './find-file.js';
import { resolveTarget } from '../resolver/resolve.js';

export interface ResolvedRef {
  filePath: string;
  isMarkdown: boolean;
  nodeId: string | null;
}

export async function resolveEmbedRef(
  db: Database.Database,
  vaultPath: string,
  ref: string
): Promise<ResolvedRef | null> {
  const ext = extname(ref).toLowerCase();

  if (ext !== '' && ext !== '.md') {
    const direct = safeVaultPath(vaultPath, ref);
    try {
      await stat(direct);
      return { filePath: direct, isMarkdown: false, nodeId: null };
    } catch {
      const found = await findFileInVault(vaultPath, ref);
      if (!found) return null;
      return { filePath: found, isMarkdown: false, nodeId: null };
    }
  }

  const direct = resolveTarget(db, ref);
  const stripped = ref.endsWith('.md') ? ref.slice(0, -3) : `${ref}.md`;
  const resolved = direct ?? resolveTarget(db, stripped);
  if (!resolved) return null;

  const row = db
    .prepare('SELECT file_path FROM nodes WHERE id = ?')
    .get(resolved.id) as { file_path: string } | undefined;
  const filePath = row ? join(vaultPath, row.file_path) : join(vaultPath, ref);
  return { filePath, isMarkdown: true, nodeId: resolved.id };
}
