// src/validation/types.ts

export interface GlobalFieldDefinition {
  name: string;
  field_type: FieldType;
  enum_values: string[] | null;
  reference_target: string | null;
  description: string | null;
  default_value: unknown;
  required: boolean;
  per_type_overrides_allowed: boolean;
  list_item_type: FieldType | null;
}

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'enum' | 'list';

export interface FieldClaim {
  schema_name: string;
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required: boolean | null;       // null = not overridden
  default_value: unknown;         // null = not overridden
}

export interface EffectiveField {
  field: string;
  global_field: GlobalFieldDefinition;
  resolved_label: string | null;
  resolved_description: string | null;
  resolved_order: number;
  resolved_required: boolean;
  resolved_default_value: unknown;
  claiming_types: string[];
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
  code: IssueCode;
  message: string;
  details?: unknown;
}

export type IssueCode =
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
