import { serializeFrontmatter } from './frontmatter.js';

export interface SerializeNodeOptions {
  title: string;
  types: string[];
  fields: Record<string, unknown>;
  body?: string;
  fieldOrder?: string[];
}

export function serializeNode(opts: SerializeNodeOptions): string {
  const { title, types, fields, body, fieldOrder } = opts;

  // Build ordered entries: title first, types second
  const entries: Array<{ key: string; value: unknown }> = [
    { key: 'title', value: title },
    { key: 'types', value: types },
  ];

  // Collect field keys, filtering out null/undefined
  const fieldKeys = Object.keys(fields).filter(
    k => fields[k] !== null && fields[k] !== undefined,
  );

  const added = new Set<string>();

  // Schema-ordered fields first
  if (fieldOrder) {
    for (const key of fieldOrder) {
      if (fieldKeys.includes(key) && !added.has(key)) {
        entries.push({ key, value: fields[key] });
        added.add(key);
      }
    }
  }

  // Remaining fields alphabetically
  const remaining = fieldKeys.filter(k => !added.has(k)).sort();
  for (const key of remaining) {
    entries.push({ key, value: fields[key] });
  }

  // Assemble file
  const frontmatter = serializeFrontmatter(entries);
  let result = `---\n${frontmatter}---\n`;

  if (body && body.length > 0) {
    result += `\n${body}\n`;
  }

  return result;
}
