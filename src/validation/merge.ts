// src/validation/merge.ts

import type {
  GlobalFieldDefinition,
  FieldClaim,
  EffectiveField,
  EffectiveFieldSet,
  MergeConflict,
  MergeResult,
} from './types.js';

/**
 * Merge field claims from multiple types into an effective field set.
 * Pure function — no DB dependency.
 */
export function mergeFieldClaims(
  types: string[],
  claimsByType: Map<string, FieldClaim[]>,
  globalFields: Map<string, GlobalFieldDefinition>,
): MergeResult {
  const effectiveFields: EffectiveFieldSet = new Map();
  const conflicts: MergeConflict[] = [];

  // Track per-field: ordered list of (type, claim) pairs
  const fieldClaims = new Map<string, Array<{ type: string; claim: FieldClaim }>>();

  // Step 1: Collect claims in type-order
  for (const type of types) {
    const claims = claimsByType.get(type);
    if (!claims) continue;

    for (const claim of claims) {
      // Skip claims referencing unknown global fields
      if (!globalFields.has(claim.field)) continue;

      let entries = fieldClaims.get(claim.field);
      if (!entries) {
        entries = [];
        fieldClaims.set(claim.field, entries);
      }
      entries.push({ type, claim });
    }
  }

  // Step 2 & 3: Build effective fields, resolve metadata
  for (const [fieldName, claimEntries] of fieldClaims) {
    const globalField = globalFields.get(fieldName)!;
    const claimingTypes = claimEntries.map(e => e.type);
    const fieldConflicts: MergeConflict[] = [];

    // Presentation metadata: first-defined wins
    let resolvedLabel: string | null = null;
    let resolvedDescription: string | null = null;
    let resolvedOrder = 1000;

    for (const { claim } of claimEntries) {
      if (resolvedLabel === null && claim.label !== null) {
        resolvedLabel = claim.label;
      }
      if (resolvedDescription === null && claim.description !== null) {
        resolvedDescription = claim.description;
      }
    }
    for (const { claim } of claimEntries) {
      if (claim.sort_order !== 1000) {
        resolvedOrder = claim.sort_order;
        break;
      }
    }

    // Semantic metadata: required & default_value
    let resolvedRequired = globalField.required;
    let resolvedDefaultValue = globalField.default_value;

    // Check required overrides
    const requiredOverrides = claimEntries.filter(e => e.claim.required !== null);
    if (requiredOverrides.length > 0) {
      if (!globalField.per_type_overrides_allowed) {
        // Internal consistency error
        fieldConflicts.push({
          field: fieldName,
          property: 'required',
          conflicting_claims: requiredOverrides.map(e => ({ type: e.type, value: e.claim.required })),
        });
      } else {
        // Check agreement
        const values = requiredOverrides.map(e => e.claim.required);
        const allAgree = values.every(v => v === values[0]);
        if (allAgree) {
          resolvedRequired = values[0]!;
        } else {
          fieldConflicts.push({
            field: fieldName,
            property: 'required',
            conflicting_claims: requiredOverrides.map(e => ({ type: e.type, value: e.claim.required })),
          });
        }
      }
    }

    // Check default_value overrides
    const defaultOverrides = claimEntries.filter(e => e.claim.default_value !== null);
    if (defaultOverrides.length > 0) {
      if (!globalField.per_type_overrides_allowed) {
        fieldConflicts.push({
          field: fieldName,
          property: 'default_value',
          conflicting_claims: defaultOverrides.map(e => ({ type: e.type, value: e.claim.default_value })),
        });
      } else {
        const first = JSON.stringify(defaultOverrides[0].claim.default_value);
        const allAgree = defaultOverrides.every(e => JSON.stringify(e.claim.default_value) === first);
        if (allAgree) {
          resolvedDefaultValue = defaultOverrides[0].claim.default_value;
        } else {
          fieldConflicts.push({
            field: fieldName,
            property: 'default_value',
            conflicting_claims: defaultOverrides.map(e => ({ type: e.type, value: e.claim.default_value })),
          });
        }
      }
    }

    if (fieldConflicts.length > 0) {
      conflicts.push(...fieldConflicts);
      // Don't add to effective fields
    } else {
      effectiveFields.set(fieldName, {
        field: fieldName,
        global_field: globalField,
        resolved_label: resolvedLabel,
        resolved_description: resolvedDescription,
        resolved_order: resolvedOrder,
        resolved_required: resolvedRequired,
        resolved_default_value: resolvedDefaultValue,
        claiming_types: claimingTypes,
      });
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, conflicts, partial_fields: effectiveFields };
  }
  return { ok: true, effective_fields: effectiveFields };
}
