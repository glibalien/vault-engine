// src/schema/types.ts

export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'boolean'
  | 'enum'
  | 'reference'
  | 'list<string>'
  | 'list<reference>';

export interface FieldDefinition {
  type: SchemaFieldType;
  required?: boolean;
  default?: unknown;
  values?: string[];
  target_schema?: string;
}

export interface SchemaDefinition {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}

export interface ResolvedSchema {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  ancestors: string[];
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}

export interface MergedField {
  type: SchemaFieldType;
  required?: boolean;
  default?: unknown;
  values?: string[];
  target_schema?: string;
  sources: string[];
}

export interface MergeConflict {
  field: string;
  definitions: Array<{ schema: string; type: SchemaFieldType }>;
  message: string;
}

export interface MergeResult {
  fields: Record<string, MergedField>;
  conflicts: MergeConflict[];
}

export interface ValidationWarning {
  field: string;
  message: string;
  rule: 'required' | 'type_mismatch' | 'invalid_enum' | 'invalid_reference';
}

export interface ValidationResult {
  valid: boolean;
  warnings: ValidationWarning[];
}
