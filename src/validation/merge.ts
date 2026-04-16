// src/validation/merge.ts

import type {
  GlobalFieldDefinition,
  FieldClaim,
  EffectiveField,
  EffectiveFieldSet,
  MergeResult,
  PerTypeEnumValues,
} from './types.js';

/**
 * Merge field claims from multiple types into an effective field set.
 * Pure function — no DB dependency.
 *
 * Conflicts are resolved by cancellation: when types disagree on required
 * or default_value, the result falls back to the global field's value.
 * Per-type enum_values overrides are surfaced on EffectiveField for
 * valid-for-any-type validation.
 */
export function mergeFieldClaims(
  types: string[],
  claimsByType: Map<string, FieldClaim[]>,
  globalFields: Map<string, GlobalFieldDefinition>,
): MergeResult {
  const effectiveFields: EffectiveFieldSet = new Map();

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

    // --- Resolve required: cancellation on conflict ---
    let resolvedRequired = globalField.required;
    const requiredOverrides = claimEntries.filter(e => e.claim.required_override !== null);
    if (requiredOverrides.length > 0) {
      const values = requiredOverrides.map(e => e.claim.required_override);
      const allAgree = values.every(v => v === values[0]);
      resolvedRequired = allAgree ? values[0]! : globalField.required;
    }

    // --- Resolve default_value: cancellation on conflict ---
    let resolvedDefaultValue = globalField.default_value;
    const defaultOverrides = claimEntries.filter(e => e.claim.default_value_override.kind === 'override');
    if (defaultOverrides.length > 0) {
      const first = JSON.stringify((defaultOverrides[0].claim.default_value_override as { kind: 'override'; value: unknown }).value);
      const allAgree = defaultOverrides.every(e =>
        JSON.stringify((e.claim.default_value_override as { kind: 'override'; value: unknown }).value) === first
      );
      resolvedDefaultValue = allAgree
        ? (defaultOverrides[0].claim.default_value_override as { kind: 'override'; value: unknown }).value
        : globalField.default_value;
    }

    // --- Resolve enum_values: per-type values ---
    let perTypeEnumValues: PerTypeEnumValues[] | undefined;
    const hasAnyEnumOverride = claimEntries.some(e => e.claim.enum_values_override !== null);
    if (hasAnyEnumOverride) {
      perTypeEnumValues = claimEntries.map(e => ({
        type: e.type,
        values: e.claim.enum_values_override ?? globalField.enum_values,
      }));
    }

    effectiveFields.set(fieldName, {
      field: fieldName,
      global_field: globalField,
      resolved_label: resolvedLabel,
      resolved_description: resolvedDescription,
      resolved_order: resolvedOrder,
      resolved_required: resolvedRequired,
      resolved_default_value: resolvedDefaultValue,
      claiming_types: claimingTypes,
      per_type_enum_values: perTypeEnumValues,
    });
  }

  return { ok: true, effective_fields: effectiveFields };
}
