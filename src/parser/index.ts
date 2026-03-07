import { parseMarkdown, extractPlainText } from './markdown.js';
import { parseFrontmatter } from './frontmatter.js';
import { extractWikiLinksFromMdast } from './wiki-links.js';
import type { ParsedFile } from './types.js';

export type { ParsedFile, WikiLink, FieldEntry, FieldValueType } from './types.js';

export function parseFile(filePath: string, raw: string): ParsedFile {
  const mdast = parseMarkdown(raw);
  const { data, content, types, fields, wikiLinks: frontmatterLinks } = parseFrontmatter(raw);
  const bodyLinks = extractWikiLinksFromMdast(mdast);
  const contentText = extractPlainText(mdast);

  return {
    filePath,
    frontmatter: data,
    types,
    fields,
    wikiLinks: [...frontmatterLinks, ...bodyLinks],
    mdast,
    contentText,
    contentMd: content.trim(),
  };
}
