// src/schema/claims.ts
//
// Shared claim-reading helpers for schema-ops tools.

import type Database from 'better-sqlite3';

export interface ClaimDiffShape {
  field: string;
  sort_order?: number;
  label?: string;
  description?: string;
  required?: boolean | null;
  default_value?: unknown;
  enum_values_override?: string[] | null;
}

interface ClaimRow {
  field: string;
  sort_order: number;
  label: string | null;
  description: string | null;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
}

/**
 * Read current schema_field_claims rows in the shape expected by diffClaims().
 */
export function readCurrentClaims(db: Database.Database, schemaName: string): ClaimDiffShape[] {
  const rows = db.prepare(
    'SELECT field, sort_order, label, description, required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ?',
  ).all(schemaName) as ClaimRow[];
  return rows.map(r => ({
    field: r.field,
    sort_order: r.sort_order,
    label: r.label ?? undefined,
    description: r.description ?? undefined,
    required: r.required_override !== null ? r.required_override === 1 : null,
    default_value: r.default_value_overridden === 1
      ? (r.default_value_override !== null ? JSON.parse(r.default_value_override) : null)
      : undefined,
    enum_values_override: r.enum_values_override !== null ? JSON.parse(r.enum_values_override) : null,
  }));
}
