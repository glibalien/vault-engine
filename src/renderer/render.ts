// src/renderer/render.ts
//
// Deterministic renderer: DB state → canonical markdown file content.
// Pure function — no DB dependency. The caller provides all inputs.

import { stringify } from 'yaml';
import type { RenderInput } from './types.js';

const YAML_OPTIONS = {
  indent: 2,
  lineWidth: 0,             // no line wrapping
  defaultKeyType: 'PLAIN' as const,
  defaultStringType: 'PLAIN' as const,
};

/**
 * Wrap a value in [[wiki-link]] brackets.
 */
function wrapRef(value: unknown): unknown {
  if (typeof value === 'string') return `[[${value}]]`;
  return value;
}

/**
 * Wrap each element in a list in [[wiki-link]] brackets.
 */
function wrapListRef(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapRef);
  return value;
}

/**
 * Render a node's DB state to canonical markdown file content.
 *
 * The output is deterministic: same input always produces same bytes.
 * This is the invariant that makes the write lock and hash check safe.
 */
export function renderNode(input: RenderInput): string {
  const {
    title,
    types,
    fields,
    body,
    fieldOrdering,
    referenceFields,
    listReferenceFields,
    orphanRawValues,
  } = input;

  // Build frontmatter object with insertion-order keys
  const fm: Record<string, unknown> = {};

  // title always first
  fm.title = title;

  // types always second, always block sequence
  fm.types = types;

  // Fields in ordering
  for (const entry of fieldOrdering) {
    const { field, category } = entry;
    if (!(field in fields)) continue;
    const value = fields[field];

    // Null values are omitted from frontmatter
    if (value === null || value === undefined) continue;

    if (category === 'orphan' && field in orphanRawValues) {
      // Orphan with raw text — use verbatim for wiki-link preservation
      const raw = orphanRawValues[field];
      // For arrays stored as JSON in raw text, parse back
      if (raw.startsWith('[')) {
        try {
          fm[field] = JSON.parse(raw);
        } catch {
          fm[field] = raw;
        }
      } else {
        fm[field] = raw;
      }
    } else if (referenceFields.has(field)) {
      fm[field] = wrapRef(value);
    } else if (listReferenceFields.has(field)) {
      fm[field] = wrapListRef(value);
    } else {
      fm[field] = value;
    }
  }

  // Serialize YAML
  const yamlStr = stringify(fm, YAML_OPTIONS);

  // Build file content: ---\n{yaml}---\n{body}
  if (body === '') {
    return `---\n${yamlStr}---\n`;
  }
  return `---\n${yamlStr}---\n${body}`;
}
