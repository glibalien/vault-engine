import { basename, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  '.vault-engine',
  '.schemas',
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
]);

let customExcludeDirs: string[] = [];

/**
 * Set additional directory prefixes to exclude from indexing.
 * Matching is segment-based: excluding "Notes" won't match "TaskNotes".
 */
export function setExcludeDirs(dirs: string[]): void {
  customExcludeDirs = dirs
    .map(d => d.replace(/\/+$/, '').trim())
    .filter(Boolean);
}

/**
 * Determine whether a vault-relative path should be ignored by the indexer.
 *
 * Ignores:
 * - Non-.md files
 * - Obsidian .sync-conflict-* files
 * - Any path segment starting with "."
 * - Known ignored directories
 * - Custom excluded directories (set via VAULT_EXCLUDE_DIRS)
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

  // Custom excluded directories — match on first segment(s)
  for (const exclude of customExcludeDirs) {
    const excludeSegments = exclude.split('/');
    if (excludeSegments.length <= segments.length) {
      const match = excludeSegments.every((es, i) => segments[i] === es);
      if (match) return true;
    }
  }

  return false;
}
