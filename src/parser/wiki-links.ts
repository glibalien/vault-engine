import type { Root } from 'mdast';
import type { WikiLink } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface RawWikiLink {
  target: string;
  alias?: string;
}

export function extractWikiLinksFromString(text: string): RawWikiLink[] {
  const links: RawWikiLink[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  while ((match = re.exec(text)) !== null) {
    links.push({
      target: match[1].trim(),
      alias: match[2]?.trim(),
    });
  }
  return links;
}

export function extractWikiLinksFromMdast(mdast: Root): WikiLink[] {
  const links: WikiLink[] = [];
  visit(mdast, links);
  return links;
}

function visit(node: any, links: WikiLink[]): void {
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    const raw = extractWikiLinksFromString(node.value);
    for (const link of raw) {
      links.push({
        target: link.target,
        alias: link.alias,
        source: 'body',
        context: node.value.replace(WIKI_LINK_RE, (_: string, target: string) => target),
        position: node.position,
      });
    }
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      visit(child, links);
    }
  }
}

export function stripWikiLinks(text: string): string {
  return text.replace(WIKI_LINK_RE, (_: string, target: string) => target);
}
