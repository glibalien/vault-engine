// src/validation/conformance.ts
//
// Cheap-join structural awareness for the get-node MCP tool.
// Implements steps 1-2 of the merge algorithm using DB queries only —
// no metadata resolution, no conflict detection.

import type Database from 'better-sqlite3';
import type { ConformanceResult } from './types.js';

export function getNodeConformance(
  db: Database.Database,
  nodeId: string,
  types: string[],
): ConformanceResult {
  const types_with_schemas: string[] = [];
  const types_without_schemas: string[] = [];

  // Step 1: classify each type by schema presence
  const schemaExistsStmt = db.prepare<[string], { exists: number }>(
    'SELECT 1 AS exists FROM schemas WHERE name = ?',
  );

  for (const type of types) {
    const row = schemaExistsStmt.get(type);
    if (row) {
      types_with_schemas.push(type);
    } else {
      types_without_schemas.push(type);
    }
  }

  // Step 2: build field → claiming_types map from schema_field_claims
  const claimsStmt = db.prepare<[string], { field: string }>(
    'SELECT field FROM schema_field_claims WHERE schema_name = ?',
  );

  const claimsMap = new Map<string, string[]>();
  for (const type of types_with_schemas) {
    const rows = claimsStmt.all(type);
    for (const row of rows) {
      const existing = claimsMap.get(row.field);
      if (existing) {
        existing.push(type);
      } else {
        claimsMap.set(row.field, [type]);
      }
    }
  }

  // Get all field names on the node
  const nodeFieldsStmt = db.prepare<[string], { field_name: string }>(
    'SELECT field_name FROM node_fields WHERE node_id = ?',
  );
  const nodeFieldRows = nodeFieldsStmt.all(nodeId);
  const nodeFieldSet = new Set(nodeFieldRows.map((r) => r.field_name));

  // Three-way classification
  const claimed_fields: Array<{ field: string; claiming_types: string[] }> = [];
  const orphan_fields: string[] = [];

  for (const fieldName of nodeFieldSet) {
    const claiming = claimsMap.get(fieldName);
    if (claiming) {
      claimed_fields.push({ field: fieldName, claiming_types: claiming });
    } else {
      orphan_fields.push(fieldName);
    }
  }

  // Unfilled claims: in claims map but not in node_fields
  const requiredStmt = db.prepare<[string], { required: number }>(
    'SELECT required FROM global_fields WHERE name = ?',
  );

  const unfilled_claims: Array<{ field: string; claiming_types: string[]; required: boolean }> = [];
  for (const [field, claiming_types] of claimsMap) {
    if (!nodeFieldSet.has(field)) {
      const gf = requiredStmt.get(field);
      const required = gf ? Boolean(gf.required) : false;
      unfilled_claims.push({ field, claiming_types, required });
    }
  }

  return {
    claimed_fields,
    orphan_fields,
    unfilled_claims,
    types_with_schemas,
    types_without_schemas,
  };
}
