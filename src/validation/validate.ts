// src/validation/validate.ts

import type {
  GlobalFieldDefinition,
  FieldClaim,
  EffectiveFieldSet,
  ConflictedFieldSet,
  CoercedValue,
  ValidationIssue,
  ValidationResult,
  IssueCode,
} from './types.js';
import { mergeFieldClaims } from './merge.js';
import { coerceValue } from './coerce.js';
import type { CoercionFailure } from './coerce.js';
import { resolveDefaultValue, type FileContext } from './resolve-default.js';

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
  const opts: ValidateOptions = fileCtxOrOpts !== null && typeof fileCtxOrOpts === 'object' && 'skipDefaults' in fileCtxOrOpts
    ? fileCtxOrOpts
    : { fileCtx: fileCtxOrOpts };
  const fileCtx = opts.fileCtx;
  const skipDefaults = opts.skipDefaults ?? false;
  const issues: ValidationIssue[] = [];
  const coerced_state: Record<string, CoercedValue> = {};
  const orphan_fields: string[] = [];

  // ── Step 1: Run the merge ──────────────────────────────────────────
  const mergeResult = mergeFieldClaims(types, claimsByType, globalFields);

  let effectiveFields: EffectiveFieldSet;
  let conflictedFields: ConflictedFieldSet = new Map();
  const conflictFieldNames = new Set<string>();

  if (mergeResult.ok) {
    effectiveFields = mergeResult.effective_fields;
  } else {
    effectiveFields = mergeResult.partial_fields;
    conflictedFields = mergeResult.conflicted_fields;
    for (const conflict of mergeResult.conflicts) {
      conflictFieldNames.add(conflict.field);
      issues.push({
        field: conflict.field,
        severity: 'error',
        code: 'MERGE_CONFLICT',
        message: `Merge conflict on "${conflict.field}" for property "${conflict.property}" between types: ${conflict.conflicting_claims.map(c => c.type).join(', ')}`,
        details: conflict,
      });
    }
  }

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
        });
      }
      // Non-required fields without a value: absent is fine, default is just metadata
      continue;
    }

    // ── Step 3: Validate and coerce provided fields ──────────────────
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
      if (fail.closest_matches) {
        code = 'ENUM_MISMATCH';
      } else if (fail.element_errors) {
        code = 'LIST_ITEM_COERCION_FAILED';
      } else {
        code = 'TYPE_MISMATCH';
      }

      const details: Record<string, unknown> = {};
      if (fail.closest_matches) details.closest_matches = fail.closest_matches;
      if (fail.element_errors) details.element_errors = fail.element_errors;

      issues.push({
        field: fieldName,
        severity: 'error',
        code,
        message: fail.reason,
        details: Object.keys(details).length > 0 ? details : undefined,
      });
    }
  }

  // ── Step 3b: Handle conflicted fields (Phase 3 merge-conflict recovery) ──
  // Provided values for conflicted fields are validated against the global
  // field definition. Unprovided values are omitted (the engine can't
  // determine the correct default when claims disagree).
  for (const [fieldName, cf] of conflictedFields) {
    const provided = fieldName in proposedFields;
    const value = proposedFields[fieldName];

    if (provided && value === null) {
      // Null is deletion intent — field omitted, no coerced_state entry
      continue;
    }

    if (!provided) {
      // Case 4: if types agree on required but disagree on default,
      // REQUIRED_MISSING is surfaced alongside the MERGE_CONFLICT already emitted
      // We can't check resolved_required because it's conflicted — but we can
      // check if ALL claiming types' resolved required (via global) is true
      if (cf.global_field.required) {
        issues.push({
          field: fieldName,
          severity: 'error',
          code: 'REQUIRED_MISSING',
          message: `Required field "${fieldName}" is missing and default is conflicted`,
        });
      }
      continue;
    }

    // Validate provided value against global field definition
    const result = coerceValue(value, cf.global_field.field_type, {
      enum_values: cf.global_field.enum_values ?? undefined,
      list_item_type: cf.global_field.list_item_type ?? undefined,
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
      if (fail.closest_matches) {
        code = 'ENUM_MISMATCH';
      } else if (fail.element_errors) {
        code = 'LIST_ITEM_COERCION_FAILED';
      } else {
        code = 'TYPE_MISMATCH';
      }

      const details: Record<string, unknown> = {};
      if (fail.closest_matches) details.closest_matches = fail.closest_matches;
      if (fail.element_errors) details.element_errors = fail.element_errors;

      issues.push({
        field: fieldName,
        severity: 'error',
        code,
        message: fail.reason,
        details: Object.keys(details).length > 0 ? details : undefined,
      });
    }
  }

  // ── Step 4: Handle orphan fields ───────────────────────────────────
  for (const fieldName of Object.keys(proposedFields)) {
    if (effectiveFields.has(fieldName)) continue;
    if (conflictFieldNames.has(fieldName)) continue;

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
