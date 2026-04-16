// src/pipeline/schema-context.ts
//
// Stage 1: Load schema context (claims-by-type and global field definitions)
// from the DB for a set of proposed types.

import type Database from 'better-sqlite3';
import type { FieldClaim, GlobalFieldDefinition } from '../validation/types.js';
import { getGlobalField } from '../global-fields/crud.js';

export interface SchemaContext {
  claimsByType: Map<string, FieldClaim[]>;
  globalFields: Map<string, GlobalFieldDefinition>;
}

/**
 * Load claims-by-type and global field definitions for the given types.
 * Same pattern as the validate-node tool handler, extracted for reuse.
 */
export function loadSchemaContext(db: Database.Database, types: string[]): SchemaContext {
  const claimsByType = new Map<string, FieldClaim[]>();

  for (const typeName of types) {
    const rows = db.prepare('SELECT * FROM schema_field_claims WHERE schema_name = ?').all(typeName) as Array<{
      schema_name: string;
      field: string;
      label: string | null;
      description: string | null;
      sort_order: number | null;
      required_override: number | null;
      default_value_override: string | null;
      default_value_overridden: number;
      enum_values_override: string | null;
    }>;

    if (rows.length > 0) {
      claimsByType.set(typeName, rows.map(r => ({
        schema_name: r.schema_name,
        field: r.field,
        label: r.label,
        description: r.description,
        sort_order: r.sort_order ?? 1000,
        required_override: r.required_override !== null ? r.required_override === 1 : null,
        default_value_override: r.default_value_overridden === 1
          ? { kind: 'override' as const, value: r.default_value_override !== null ? JSON.parse(r.default_value_override) : null }
          : { kind: 'inherit' as const },
        enum_values_override: r.enum_values_override !== null ? JSON.parse(r.enum_values_override) : null,
      })));
    }
  }

  const globalFields = new Map<string, GlobalFieldDefinition>();
  const allFieldNames = new Set<string>();
  for (const claims of claimsByType.values()) {
    for (const c of claims) allFieldNames.add(c.field);
  }
  for (const name of allFieldNames) {
    const gf = getGlobalField(db, name);
    if (gf) globalFields.set(name, gf);
  }

  return { claimsByType, globalFields };
}
