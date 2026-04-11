/**
 * Body wiki-link extraction using remark AST walking.
 *
 * Walks text nodes in the parsed markdown AST, skipping code blocks
 * and YAML frontmatter nodes. Extracts [[target]] and [[target|alias]] links.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { Node, Parent } from 'unist';
import type { Text } from 'mdast';
import type { WikiLink } from './types.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** AST node types to skip when extracting wiki-links. */
const SKIP_TYPES = new Set(['code', 'inlineCode', 'yaml']);

interface TextNodeWithContext {
  text: string;
  paragraphText: string;
}

/**
 * Collect all text content from a parent node (for context).
 */
function collectText(node: Node): string {
  if ('value' in node && typeof (node as Text).value === 'string') {
    return (node as Text).value;
  }
  if ('children' in node) {
    return (node as Parent).children.map(collectText).join('');
  }
  return '';
}

/**
 * Walk the AST and collect text nodes with their paragraph context.
 */
function collectTextNodes(
  node: Node,
  contextNode: Node | null,
  results: TextNodeWithContext[],
): void {
  if (SKIP_TYPES.has(node.type)) return;

  if (node.type === 'text') {
    const ctx = contextNode ?? node;
    const paragraphText = collectText(ctx);
    results.push({
      text: (node as Text).value,
      paragraphText: paragraphText.slice(0, 200),
    });
    return;
  }

  if ('children' in node) {
    // Use block-level nodes as context providers
    const isBlockContext =
      node.type === 'paragraph' ||
      node.type === 'heading' ||
      node.type === 'listItem' ||
      node.type === 'tableCell';
    const nextContext = isBlockContext ? node : contextNode;

    for (const child of (node as Parent).children) {
      collectTextNodes(child, nextContext, results);
    }
  }
}

/**
 * Extract wiki-links from the body of a markdown document using remark AST.
 */
export function extractBodyWikiLinks(body: string): WikiLink[] {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm);

  const tree = processor.parse(body);
  const textNodes: TextNodeWithContext[] = [];
  collectTextNodes(tree, null, textNodes);

  const links: WikiLink[] = [];
  for (const { text, paragraphText } of textNodes) {
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(text)) !== null) {
      links.push({
        target: match[1],
        alias: match[2] ?? null,
        context: paragraphText,
      });
    }
  }

  return links;
}
