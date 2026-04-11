// src/pipeline/relationships.ts
//
// Derive relationships from the final validated state.
// Relationships are derived in Stage 6, not carried in ProposedMutation.

import type { GlobalFieldDefinition } from '../validation/types.js';
import { extractBodyWikiLinks } from '../parser/wiki-links.js';

const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface DerivedRelationship {
  target: string;
  rel_type: string;
  context: string;
}

/**
 * Derive relationships from final field values and body wiki-links.
 */
export function deriveRelationships(
  fields: Record<string, unknown>,
  body: string,
  globalFields: Map<string, GlobalFieldDefinition>,
  orphanRawValues: Record<string, string>,
): DerivedRelationship[] {
  const rels: DerivedRelationship[] = [];
  const seen = new Set<string>();

  function addRel(target: string, relType: string, context: string): void {
    const key = `${target}|${relType}`;
    if (seen.has(key)) return;
    seen.add(key);
    rels.push({ target, rel_type: relType, context });
  }

  // Frontmatter reference fields
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;

    const gf = globalFields.get(fieldName);
    if (gf) {
      if (gf.field_type === 'reference' && typeof value === 'string') {
        addRel(value, fieldName, fieldName);
      } else if (gf.field_type === 'list' && gf.list_item_type === 'reference' && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            addRel(item, fieldName, fieldName);
          }
        }
      }
    }

    // Orphan fields — extract wiki-links from raw text or from the value itself
    if (!gf) {
      // Prefer value_raw_text if available (watcher path)
      const textToScan = (fieldName in orphanRawValues)
        ? orphanRawValues[fieldName]
        : (typeof value === 'string' ? value : (Array.isArray(value) ? JSON.stringify(value) : null));

      if (textToScan) {
        WIKILINK_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = WIKILINK_PATTERN.exec(textToScan)) !== null) {  // RegExp.exec, not child_process
          addRel(match[1], fieldName, fieldName);
        }
      }
    }
  }

  // Body wiki-links
  const bodyLinks = extractBodyWikiLinks(body);
  for (const link of bodyLinks) {
    addRel(link.target, 'wiki-link', link.context);
  }

  return rels;
}
