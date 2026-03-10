import { parseMarkdown } from '../parser/markdown.js';
import { extractWikiLinksFromMdast } from '../parser/wiki-links.js';

export function updateBodyReferences(body: string, oldTitle: string, newTitle: string): string {
  if (!body) return body;

  const mdast = parseMarkdown(body);
  const links = extractWikiLinksFromMdast(mdast);

  // Filter links matching old title (case-insensitive, exact match)
  const matching = links
    .filter(l => l.target.toLowerCase() === oldTitle.toLowerCase())
    .filter(l => l.position?.start.offset != null && l.position?.end.offset != null);

  if (matching.length === 0) return body;

  // Sort by offset descending so replacements don't shift earlier positions
  matching.sort((a, b) => b.position!.start.offset! - a.position!.start.offset!);

  let result = body;
  for (const link of matching) {
    const start = link.position!.start.offset!;
    const end = link.position!.end.offset!;
    const replacement = link.alias
      ? `[[${newTitle}|${link.alias}]]`
      : `[[${newTitle}]]`;
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}
