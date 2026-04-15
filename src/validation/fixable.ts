// src/validation/fixable.ts

import type {
  ValidationIssue,
  EffectiveFieldSet,
  FixableEntry,
  EnumMismatchDetails,
  RequiredMissingDetails,
} from './types.js';

/**
 * Build a convenience summary of which validation issues the caller can fix
 * in a follow-up call without human intervention.
 *
 * Fixable rules:
 *   - ENUM_MISMATCH with closest_match -> suggestion = closest_match
 *   - ENUM_MISMATCH without closest_match -> suggestion = null, allowed_values provided
 *   - REQUIRED_MISSING with default_value -> suggestion = default_value
 *   - REQUIRED_MISSING enum without default -> suggestion = null, allowed_values provided
 *   - REQUIRED_MISSING boolean without default -> suggestion = null, field_type = boolean
 *   - REQUIRED_MISSING reference -> suggestion = null, field_type = reference
 *   - Everything else (TYPE_MISMATCH, freeform string/number, MERGE_CONFLICT) -> not fixable
 *
 * Results are ordered by field declaration order from effectiveFields.
 */
export function buildFixable(
  issues: ValidationIssue[],
  effectiveFields: EffectiveFieldSet,
): FixableEntry[] {
  const entries: FixableEntry[] = [];

  for (const issue of issues) {
    if (issue.code === 'ENUM_MISMATCH' && issue.details) {
      const d = issue.details as EnumMismatchDetails;
      const entry: FixableEntry = {
        field: issue.field,
        suggestion: d.closest_match ?? null,
      };
      if (!d.closest_match) {
        entry.allowed_values = d.allowed_values;
      }
      entries.push(entry);
    } else if (issue.code === 'REQUIRED_MISSING' && issue.details) {
      const d = issue.details as RequiredMissingDetails;

      if (d.default_value !== undefined) {
        entries.push({ field: issue.field, suggestion: d.default_value });
      } else if (d.field_type === 'enum' && d.allowed_values) {
        entries.push({ field: issue.field, suggestion: null, allowed_values: d.allowed_values });
      } else if (d.field_type === 'boolean') {
        entries.push({ field: issue.field, suggestion: null, field_type: 'boolean' });
      } else if (d.field_type === 'reference') {
        entries.push({ field: issue.field, suggestion: null, field_type: 'reference' });
      }
      // string, number, date, list without default -> not fixable
    }
    // TYPE_MISMATCH, COERCION_FAILED, MERGE_CONFLICT, etc. -> not fixable
  }

  // Sort by field declaration order
  entries.sort((a, b) => {
    const orderA = effectiveFields.get(a.field)?.resolved_order ?? Infinity;
    const orderB = effectiveFields.get(b.field)?.resolved_order ?? Infinity;
    return orderA - orderB;
  });

  return entries;
}
