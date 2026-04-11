import { basename, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  '.vault-engine',
  '.schemas',
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
]);

/**
 * Determine whether a vault-relative path should be ignored by the indexer.
 *
 * Ignores:
 * - Non-.md files
 * - Obsidian .sync-conflict-* files
 * - Any path segment starting with "."
 * - Known ignored directories
 */
export function shouldIgnore(relativePath: string): boolean {
  const name = basename(relativePath);

  // Must be a markdown file
  if (!name.endsWith('.md')) return true;

  // Obsidian sync conflicts
  if (name.startsWith('.sync-conflict-')) return true;

  // Check each path segment
  const segments = relativePath.split(sep);
  for (const segment of segments) {
    if (segment.startsWith('.')) return true;
    if (IGNORED_DIRS.has(segment)) return true;
  }

  return false;
}
