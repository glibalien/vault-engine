/**
 * Main markdown parser entry point.
 *
 * Combines frontmatter parsing and body wiki-link extraction
 * into a single ParsedNode result.
 */

import { basename } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { Heading, Text } from 'mdast';
import type { Parent } from 'unist';
import { parseFrontmatter } from './frontmatter.js';
import { extractBodyWikiLinks } from './wiki-links.js';
import type { ParsedNode } from './types.js';

/**
 * Extract the first H1 heading text from markdown body.
 */
function extractFirstH1(body: string): string | null {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm);

  const tree = processor.parse(body);

  for (const child of (tree as Parent).children) {
    if (child.type === 'heading' && (child as Heading).depth === 1) {
      // Collect text from heading children
      const texts: string[] = [];
      for (const hChild of (child as Heading).children) {
        if (hChild.type === 'text') {
          texts.push((hChild as Text).value);
        }
      }
      const text = texts.join('');
      if (text.length > 0) return text;
    }
  }

  return null;
}

/**
 * Derive title from filename: basename without .md extension.
 */
function titleFromFilename(filePath: string): string {
  const base = basename(filePath);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Parse a markdown file into a structured ParsedNode.
 *
 * @param raw - The raw file content as a string.
 * @param filePath - The file path, used for filename-based title fallback.
 */
export function parseMarkdown(raw: string, filePath: string): ParsedNode {
  const fm = parseFrontmatter(raw);

  // On parse error, return early with error state
  if (fm.parseError !== null) {
    return {
      title: titleFromFilename(filePath),
      types: [],
      fields: new Map(),
      body: fm.body,
      wikiLinks: [],
      parseError: fm.parseError,
    };
  }

  // Resolve title: frontmatter → H1 → filename
  let title = fm.title;
  if (title === null) {
    title = extractFirstH1(fm.body);
  }
  if (title === null) {
    title = titleFromFilename(filePath);
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
