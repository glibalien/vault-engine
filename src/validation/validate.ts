// src/validation/validate.ts

import type {
  GlobalFieldDefinition,
  FieldClaim,
  CoercedValue,
  ValidationIssue,
  ValidationResult,
  IssueCode,
  RequiredMissingDetails,
} from './types.js';
import { mergeFieldClaims } from './merge.js';
import { coerceValue, closestMatches } from './coerce.js';
import type { CoercionFailure } from './coerce.js';
import { resolveDefaultValue, type FileContext } from './resolve-default.js';

function buildRequiredMissingDetails(gf: GlobalFieldDefinition): RequiredMissingDetails {
  const details: RequiredMissingDetails = { field_type: gf.field_type };
  if (gf.enum_values) details.allowed_values = gf.enum_values;
  if (gf.default_value !== null) details.default_value = gf.default_value;
  if (gf.reference_target) details.reference_target = gf.reference_target;
  return details;
}

export interface ValidateOptions {
  fileCtx?: FileContext | null;
  /** Skip default population for missing fields (normalizer path — defaults are creation-only). */
  skipDefaults?: boolean;
}

export function validateProposedState(
  proposedFields: Record<string, unknown>,
  types: string[],
  claimsByType: Map<string, FieldClaim[]>,
  globalFields: Map<string, GlobalFieldDefinition>,
  fileCtxOrOpts?: FileContext | null | ValidateOptions,
): ValidationResult {
  const opts: ValidateOptions = fileCtxOrOpts !== null && fileCtxOrOpts !== undefined && 'skipDefaults' in fileCtxOrOpts
    ? fileCtxOrOpts as ValidateOptions
    : { fileCtx: fileCtxOrOpts as FileContext | null | undefined };
  const fileCtx = opts.fileCtx;
  const skipDefaults = opts.skipDefaults ?? false;
  const issues: ValidationIssue[] = [];
  const coerced_state: Record<string, CoercedValue> = {};
  const orphan_fields: string[] = [];

  // ── Step 1: Run the merge ──────────────────────────────────────────
  const mergeResult = mergeFieldClaims(types, claimsByType, globalFields);
  if (!mergeResult.ok) throw new Error('Unexpected merge failure');  // merge always returns ok: true
  const effectiveFields = mergeResult.effective_fields;

  // ── Step 2: Check required fields and defaults ─────────────────────
  for (const [fieldName, ef] of effectiveFields) {
    const provided = fieldName in proposedFields;
    const value = proposedFields[fieldName];

    if (provided && value === null) {
      // Null is deletion intent
      if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" cannot be null`,
          details: buildRequiredMissingDetails(ef.global_field),
        });
      }
      // Null excludes from coerced_state regardless
      continue;
    }

    if (!provided) {
      if (!skipDefaults && ef.resolved_required && ef.resolved_default_value !== null) {
        const resolved = resolveDefaultValue(ef.resolved_default_value, fileCtx ?? null);
        coerced_state[fieldName] = {
          field: fieldName,
          value: resolved,
          source: 'defaulted',
          changed: false,
        };
      } else if (ef.resolved_required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" is missing`,
          details: buildRequiredMissingDetails(ef.global_field),
        });
      }
      // Non-required fields without a value: absent is fine, default is just metadata
      continue;
    }

    // ── Step 3: Validate and coerce provided fields ──────────────────
    if (ef.per_type_enum_values) {
      // Per-type enum validation: valid-for-any-type
      let accepted = false;
      let lastFailure: CoercionFailure | null = null;

      for (const pte of ef.per_type_enum_values) {
        const r = coerceValue(value, ef.global_field.field_type, {
          enum_values: pte.values ?? undefined,
          list_item_type: ef.global_field.list_item_type ?? undefined,
        });
        if (r.ok) {
          const entry: CoercedValue = {
            field: fieldName,
            value: r.value,
            source: 'provided',
            changed: r.changed,
          };
          if (r.changed) {
            entry.original = value;
            if (r.code) entry.coercion_code = r.code;
          }
          coerced_state[fieldName] = entry;
          accepted = true;
          break;
        }
        lastFailure = r as CoercionFailure;
      }

      if (!accepted && lastFailure) {
        // Collect all effective enum values across all types for closestMatches
        const allValues = new Set<string>();
        for (const pte of ef.per_type_enum_values) {
          if (pte.values) pte.values.forEach((v: string) => allValues.add(v));
        }
        const deduped = Array.from(allValues);
        const matches = closestMatches(String(value), deduped);

        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'ENUM_MISMATCH',
          message: lastFailure.reason,
          details: {
            provided: value,
            allowed_values: deduped,
            closest_match: matches[0] ?? null,
          },
        });
      }
      continue;  // skip the standard coercion path
    }

    // Standard coercion (no per-type enum overrides)
    const result = coerceValue(value, ef.global_field.field_type, {
      enum_values: ef.global_field.enum_values ?? undefined,
      list_item_type: ef.global_field.list_item_type ?? undefined,
    });

    if (result.ok) {
      const entry: CoercedValue = {
        field: fieldName,
        value: result.value,
        source: 'provided',
        changed: result.changed,
      };
      if (result.changed) {
        entry.original = value;
        if (result.code) entry.coercion_code = result.code;
      }
      coerced_state[fieldName] = entry;
    } else {
      const fail = result as CoercionFailure;
      let code: IssueCode;
      if (fail.to_type === 'enum' || fail.closest_matches) {
        code = 'ENUM_MISMATCH';
      } else if (fail.element_errors) {
        code = 'LIST_ITEM_COERCION_FAILED';
      } else {
        code = 'TYPE_MISMATCH';
      }

      let details: unknown;
      if (code === 'ENUM_MISMATCH') {
        details = {
          provided: value,
          allowed_values: effectiveFields.get(fieldName)?.global_field.enum_values ?? [],
          closest_match: fail.closest_matches?.[0] ?? null,
        };
      } else if (code === 'TYPE_MISMATCH') {
        details = {
          expected_type: effectiveFields.get(fieldName)?.global_field.field_type ?? fail.to_type,
          provided_type: fail.from_type,
          coercion_failed_reason: fail.reason,
        };
      } else if (fail.element_errors) {
        details = { element_errors: fail.element_errors };
      }

      issues.push({
        field: fieldName,
        severity: 'error',
        code,
        message: fail.reason,
        details,
      });
    }
  }

  // ── Step 4: Handle orphan fields ───────────────────────────────────
  for (const fieldName of Object.keys(proposedFields)) {
    if (effectiveFields.has(fieldName)) continue;

    orphan_fields.push(fieldName);
    coerced_state[fieldName] = {
      field: fieldName,
      value: proposedFields[fieldName],
      source: 'orphan',
      changed: false,
    };
  }

  // ── Step 5: Return result ──────────────────────────────────────────
  const valid = issues.filter(i => i.severity === 'error').length === 0;

  return {
    valid,
    effective_fields: effectiveFields,
    coerced_state,
    issues,
    orphan_fields,
  };
}
