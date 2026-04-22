// src/schema/paths.ts
//
// Shared directory-resolution helper used by create-node, batch-mutate,
// and rename-node. Single source of truth for "where does this node live
// given its types + optional caller override".

import type Database from 'better-sqlite3';

export interface ResolveDirectoryInput {
  types: string[];
  directory: string | undefined;
  override_default_directory: boolean;
}

export type ResolveDirectoryResult =
  | { ok: true; directory: string; source: 'explicit' | 'schema_default' | 'root' }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

export function resolveDirectory(
  db: Database.Database,
  input: ResolveDirectoryInput,
): ResolveDirectoryResult {
  if (input.directory !== undefined && input.directory.endsWith('.md')) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: '"directory" must be a folder path, not a filename. The filename is always derived from the node title.',
    };
  }

  let schemaDefaultDir: string | null = null;
  if (input.types.length >= 1) {
    const schema = db
      .prepare('SELECT default_directory FROM schemas WHERE name = ?')
      .get(input.types[0]) as { default_directory: string | null } | undefined;
    schemaDefaultDir = schema?.default_directory ?? null;
  }

  if (input.directory !== undefined && schemaDefaultDir && !input.override_default_directory) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      message: `Type "${input.types[0]}" routes to "${schemaDefaultDir}/" via schema. Pass override_default_directory: true to place this node elsewhere.`,
    };
  }

  if (input.directory !== undefined) return { ok: true, directory: input.directory, source: 'explicit' };
  if (schemaDefaultDir) return { ok: true, directory: schemaDefaultDir, source: 'schema_default' };
  return { ok: true, directory: '', source: 'root' };
}
