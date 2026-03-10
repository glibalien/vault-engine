// src/serializer/path.ts
import type Database from 'better-sqlite3';
import { getSchema } from '../schema/loader.js';

const UNSAFE_CHARS_RE = /[\\:*?"<>|]/g;
const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g;

function formatTemplateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function sanitizeSegment(segment: string): string {
  return segment.replace(UNSAFE_CHARS_RE, '').replace(/\s+/g, ' ').trim();
}

export function generateFilePath(
  title: string,
  types: string[],
  fields: Record<string, unknown>,
  db: Database.Database,
): string {
  // Find first schema (alphabetically) with a filename_template
  let template: string | undefined;
  const sortedTypes = [...types].sort();

  for (const typeName of sortedTypes) {
    const schema = getSchema(db, typeName);
    if (schema?.serialization?.filename_template) {
      template = schema.serialization.filename_template;
      break;
    }
  }

  if (!template) {
    template = '{{title}}.md';
  }

  // Build variable lookup: title + all fields
  const vars: Record<string, string> = { title };
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) {
      vars[key] = formatTemplateValue(value);
    }
  }

  // Interpolate template variables
  const resolved = template.replace(TEMPLATE_VAR_RE, (match, varName: string) => {
    if (!(varName in vars)) {
      throw new Error(
        `filename_template variable '${varName}' has no value. ` +
          `Template: '${template}', available: [${Object.keys(vars).join(', ')}]`,
      );
    }
    return vars[varName];
  });

  // Sanitize each path segment individually (preserve directory separators)
  const segments = resolved.split('/');
  return segments.map(sanitizeSegment).join('/');
}
