import type { Root } from 'mdast';
import type { Position } from 'unist';

export type { Root, Position };

export interface WikiLink {
  target: string;
  alias?: string;
  source: 'frontmatter' | 'body';
  field?: string;
  context?: string;
  position?: Position;
}

export type FieldValueType = 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'list';

export interface FieldEntry {
  key: string;
  value: unknown;
  valueType: FieldValueType;
}

export interface ParsedFile {
  filePath: string;
  frontmatter: Record<string, unknown>;
  types: string[];
  fields: FieldEntry[];
  wikiLinks: WikiLink[];
  mdast: Root;
  contentText: string;
  contentMd: string;
}
