/**
 * Type definitions for the markdown parser.
 */

export type YamlPrimitive = string | number | boolean | Date | null;

export type YamlValue = YamlPrimitive | YamlArray | YamlRecord;

export interface YamlArray extends Array<YamlValue> {}

export interface YamlRecord extends Record<string, YamlValue> {}

export interface WikiLink {
  /** The canonical target (without brackets). */
  target: string;
  /** Display alias if provided, e.g. [[target|alias]]. */
  alias: string | null;
  /** For frontmatter links: the field name. For body links: surrounding text. */
  context: string;
}

export interface ParsedNode {
  /** Resolved title: frontmatter title → first H1 → filename → null. */
  title: string | null;
  /** True when the title came from a frontmatter `title` key (not H1 or filename). */
  titleFromFrontmatter: boolean;
  /** Types extracted from frontmatter `types` field. */
  types: string[];
  /** All frontmatter KV pairs except title and types. */
  fields: Map<string, YamlValue>;
  /** Everything after the frontmatter block. */
  body: string;
  /** Wiki-links from both frontmatter values and body text. */
  wikiLinks: WikiLink[];
  /** Set when frontmatter YAML is malformed. */
  parseError: string | null;
}
