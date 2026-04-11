// src/pipeline/populate-defaults.ts
//
// Given a node's type set and current fields, run the merge algorithm
// and populate missing fields with resolved defaults.
// Used by add-type-to-node, watcher type-addition, and propagation.

import type Database from 'better-sqlite3';
import { mergeFieldClaims } from '../validation/merge.js';
import { loadSchemaContext } from './schema-context.js';

export interface PopulatedDefault {
  field: string;
  default_value: unknown;
  default_source: 'global' | 'claim';
}

/**
 * Populate defaults for fields that the node doesn't have values for.
 * Returns the defaults to merge into the proposed fields and the list of
 * defaults populated (for edits log entries).
 */
export function populateDefaults(
  db: Database.Database,
  types: string[],
  currentFields: Record<string, unknown>,
): { defaults: Record<string, unknown>; populated: PopulatedDefault[] } {
  const { claimsByType, globalFields } = loadSchemaContext(db, types);
  const mergeResult = mergeFieldClaims(types, claimsByType, globalFields);

  const effectiveFields = mergeResult.ok
    ? mergeResult.effective_fields
    : mergeResult.partial_fields;

  const defaults: Record<string, unknown> = {};
  const populated: PopulatedDefault[] = [];

  for (const [fieldName, ef] of effectiveFields) {
    // Only populate if the node doesn't already have this field
    if (fieldName in currentFields && currentFields[fieldName] !== undefined) continue;

    if (ef.resolved_default_value !== null) {
      defaults[fieldName] = ef.resolved_default_value;

      // Determine source: if any claim has a non-null default, it's from a claim
      let source: 'global' | 'claim' = 'global';
      for (const claims of claimsByType.values()) {
        for (const c of claims) {
          if (c.field === fieldName && c.default_value !== null) {
            source = 'claim';
            break;
          }
        }
        if (source === 'claim') break;
      }

      populated.push({ field: fieldName, default_value: ef.resolved_default_value, default_source: source });
    }
  }

  return { defaults, populated };
}
