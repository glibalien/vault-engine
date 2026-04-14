/**
 * Main markdown parser entry point.
 *
 * Combines frontmatter parsing and body wiki-link extraction
 * into a single ParsedNode result.
 */

import { basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { extractBodyWikiLinks } from './wiki-links.js';
import type { ParsedNode } from './types.js';

/**
 * Derive title from filename: basename without .md extension.
 * The filename is always the canonical title — never frontmatter or H1.
 */
function titleFromFilename(filePath: string): string {
  const base = basename(filePath);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Parse a markdown file into a structured ParsedNode.
 *
 * @param raw - The raw file content as a string.
 * @param filePath - The file path; title is always derived from the filename.
 */
export function parseMarkdown(raw: string, filePath: string): ParsedNode {
  const title = titleFromFilename(filePath);
  const fm = parseFrontmatter(raw);

  // On parse error, return early with error state
  if (fm.parseError !== null) {
    return {
      title,
      types: [],
      fields: new Map(),
      body: fm.body,
      wikiLinks: [],
      parseError: fm.parseError,
    };
  }

  // Extract body wiki-links
  const bodyLinks = extractBodyWikiLinks(fm.body);

  // Combine frontmatter and body wiki-links
  const wikiLinks = [...fm.wikiLinks, ...bodyLinks];

  return {
    title,
    types: fm.types,
    fields: fm.fields,
    body: fm.body,
    wikiLinks,
    parseError: null,
  };
}
