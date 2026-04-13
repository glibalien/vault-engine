/**
 * Frontmatter parsing and wiki-link extraction from YAML values.
 *
 * Uses the `yaml` package directly (no gray-matter).
 */

import { parse as parseYaml } from 'yaml';
import type { YamlValue, WikiLink } from './types.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface FrontmatterResult {
  title: string | null;
  types: string[];
  fields: Map<string, YamlValue>;
  wikiLinks: WikiLink[];
  body: string;
  parseError: string | null;
}

/**
 * Split raw markdown into frontmatter YAML string and body.
 * Returns null for yaml if no frontmatter block is found.
 */
export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  // Frontmatter must start at the very beginning of the file
  if (!raw.startsWith('---')) {
    return { yaml: null, body: raw };
  }

  // Find the closing ---
  const closingIndex = raw.indexOf('\n---', 3);
  if (closingIndex === -1) {
    return { yaml: null, body: raw };
  }

  const yamlStr = raw.slice(4, closingIndex); // skip opening "---\n"
  const body = raw.slice(closingIndex + 4); // skip "\n---"

  // Strip leading newline from body if present
  return {
    yaml: yamlStr,
    body: body.startsWith('\n') ? body.slice(1) : body,
  };
}

/**
 * Extract wiki-links from a YAML value, recursively handling strings, arrays, and objects.
 * Returns the cleaned value (brackets stripped from strings) and any wiki-links found.
 */
function extractWikiLinksFromValue(
  value: YamlValue,
  fieldName: string,
): { cleaned: YamlValue; links: WikiLink[] } {
  if (typeof value === 'string') {
    const links: WikiLink[] = [];
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(value)) !== null) {
      links.push({
        target: match[1],
        alias: match[2] ?? null,
        context: fieldName,
      });
    }
    // Strip brackets from the string value, keeping canonical target (not alias)
    const cleaned = value.replace(WIKILINK_RE, (_match, target) => target);
    return { cleaned, links };
  }

  if (Array.isArray(value)) {
    const allLinks: WikiLink[] = [];
    const cleanedArr = value.map((item) => {
      const result = extractWikiLinksFromValue(item, fieldName);
      allLinks.push(...result.links);
      return result.cleaned;
    });
    return { cleaned: cleanedArr, links: allLinks };
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const allLinks: WikiLink[] = [];
    const cleanedObj: Record<string, YamlValue> = {};
    for (const [key, val] of Object.entries(value)) {
      const result = extractWikiLinksFromValue(val, fieldName);
      allLinks.push(...result.links);
      cleanedObj[key] = result.cleaned;
    }
    return { cleaned: cleanedObj, links: allLinks };
  }

  // number, boolean, Date, null — pass through
  return { cleaned: value, links: [] };
}

/**
 * Parse frontmatter and extract structured data.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const { yaml: yamlStr, body } = splitFrontmatter(raw);

  if (yamlStr === null) {
    return {
      title: null,
      types: [],
      fields: new Map(),
      wikiLinks: [],
      body,
      parseError: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlStr, { uniqueKeys: false });
  } catch (err) {
    return {
      title: null,
      types: [],
      fields: new Map(),
      wikiLinks: [],
      body: raw, // entire file content as body on parse error
      parseError: err instanceof Error ? err.message : String(err),
    };
  }

  // Empty frontmatter (--- followed immediately by ---)
  if (parsed === null || parsed === undefined) {
    return {
      title: null,
      types: [],
      fields: new Map(),
      wikiLinks: [],
      body,
      parseError: null,
    };
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      title: null,
      types: [],
      fields: new Map(),
      wikiLinks: [],
      body,
      parseError: 'Frontmatter is not a YAML mapping',
    };
  }

  const data = parsed as Record<string, YamlValue>;
  const allLinks: WikiLink[] = [];
  const fields = new Map<string, YamlValue>();

  // Extract title
  let title: string | null = null;
  if ('title' in data && data.title != null) {
    const titleResult = extractWikiLinksFromValue(data.title, 'title');
    allLinks.push(...titleResult.links);
    title = String(titleResult.cleaned);
  }

  // Extract types
  let types: string[] = [];
  if ('types' in data) {
    const rawTypes = data.types;
    if (Array.isArray(rawTypes)) {
      types = rawTypes
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.replace(/^\[\[(.+)\]\]$/, '$1'));
    } else if (typeof rawTypes === 'string') {
      types = [rawTypes.replace(/^\[\[(.+)\]\]$/, '$1')];
    }
  }

  // Extract all other fields
  for (const [key, value] of Object.entries(data)) {
    if (key === 'title' || key === 'types') continue;
    const result = extractWikiLinksFromValue(value, key);
    allLinks.push(...result.links);
    fields.set(key, result.cleaned);
  }

  return { title, types, fields, wikiLinks: allLinks, body, parseError: null };
}
