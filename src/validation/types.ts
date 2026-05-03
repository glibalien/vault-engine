// src/validation/types.ts

import type { UiHints } from '../global-fields/ui-hints.js';

export interface OverridesAllowed {
  required: boolean;
  default_value: boolean;
  enum_values: boolean;
}

export interface GlobalFieldDefinition {
  name: string;
  field_type: FieldType;
  enum_values: string[] | null;
  reference_target: string | null;
  description: string | null;
  default_value: unknown;
  required: boolean;
  overrides_allowed: OverridesAllowed;
  list_item_type: FieldType | null;
  ui_hints: UiHints | null;
}

export type Override<T> = { kind: 'inherit' } | { kind: 'override'; value: T };

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'enum' | 'list';

export interface FieldClaim {
  schema_name: string;
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required_override: boolean | null;       // null = not overridden
  default_value_override: Override<unknown>;
  enum_values_override: string[] | null;
}

export interface PerTypeEnumValues {
  type: string;
  values: string[] | null;
}

export interface EffectiveField {
  field: string;
  global_field: GlobalFieldDefinition;
  resolved_label: string | null;
  resolved_description: string | null;
  resolved_order: number;
  resolved_required: boolean;
  resolved_default_value: unknown;
  /** Where `resolved_default_value` came from: 'claim' iff a per-type override
   *  actually won (single override or all overrides agreed). 'global' otherwise,
   *  including the cancel-to-global case when overrides disagreed. */
  default_source: 'global' | 'claim';
  claiming_types: string[];
  per_type_enum_values?: PerTypeEnumValues[];
}

export type EffectiveFieldSet = Map<string, EffectiveField>;

export interface MergeConflict {
  field: string;
  property: 'required' | 'default_value';
  conflicting_claims: Array<{ type: string; value: unknown }>;
}

export interface ConflictedField {
  field: string;
  global_field: GlobalFieldDefinition;
  claiming_types: string[];
  resolved_order: number;
  resolved_label: string | null;
  resolved_description: string | null;
}

export type ConflictedFieldSet = Map<string, ConflictedField>;

export type MergeResult =
  | { ok: true; effective_fields: EffectiveFieldSet }
  | { ok: false; conflicts: MergeConflict[]; partial_fields: EffectiveFieldSet; conflicted_fields: ConflictedFieldSet };

export interface CoercedValue {
  field: string;
  value: unknown;
  original?: unknown;  // populated when changed: true and source: 'provided'
  source: 'provided' | 'defaulted' | 'orphan';
  changed: boolean;
  coercion_code?: string;  // e.g. STRING_TO_NUMBER — populated when changed && source === 'provided'
}

export interface ValidationIssue {
  field: string;
  severity: 'error';
  code: ValidationIssueCode;
  message: string;
  details?: unknown;
}

export type ValidationIssueCode =
  | 'REQUIRED_MISSING'
  | 'ENUM_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'COERCION_FAILED'
  | 'LIST_ITEM_COERCION_FAILED'
  | 'MERGE_CONFLICT'
  | 'INTERNAL_CONSISTENCY';

export interface ValidationResult {
  valid: boolean;
  effective_fields: EffectiveFieldSet;
  coerced_state: Record<string, CoercedValue>;
  issues: ValidationIssue[];
  orphan_fields: string[];
}

export interface ConformanceResult {
  claimed_fields: Array<{ field: string; claiming_types: string[] }>;
  orphan_fields: string[];
  unfilled_claims: Array<{ field: string; claiming_types: string[]; required: boolean }>;
  types_with_schemas: string[];
  types_without_schemas: string[];
}

// ── Structured issue details ────────────────────────────────────────

export interface EnumMismatchDetails {
  provided: unknown;
  allowed_values: string[];
  closest_match: string | null;
}

export interface RequiredMissingDetails {
  field_type: FieldType;
  allowed_values?: string[];
  default_value?: unknown;
  reference_target?: string;
}

export interface TypeMismatchDetails {
  expected_type: FieldType;
  provided_type: string;
  coercion_failed_reason: string;
}

export interface FixableEntry {
  field: string;
  suggestion: unknown;
  allowed_values?: string[];
  field_type?: FieldType;
}
