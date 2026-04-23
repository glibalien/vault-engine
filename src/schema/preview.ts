// src/schema/preview.ts
//
// SAVEPOINT-based preview of an update-schema call. Runs the real mutation
// pipeline inside a savepoint and unconditionally rolls back. Used by
// update-schema's dry_run path, by the confirm_large_change gate to compute
// orphan counts pre-commit, and as the single source of the preview response
// shape.

import type Database from 'better-sqlite3';
import { getSchemaDefinition, updateSchemaDefinition, type UpdateSchemaInput } from './crud.js';
import { diffClaims, propagateSchemaChange } from './propagate.js';
import { readCurrentClaims } from './claims.js';
import { SchemaValidationError, type ValidationGroup } from './errors.js';
import type { WriteLockManager } from '../sync/write-lock.js';

export interface SchemaPreviewBaseFields {
  claims_added: string[];
  claims_removed: string[];
  claims_modified: string[];
  orphaned_field_names: Array<{ field: string; count: number }>;
  propagation: {
    nodes_affected: number;
    nodes_rerendered: number;
    defaults_populated: number;
    fields_orphaned: number;
  };
}

export type SchemaPreviewResult =
  | ({ ok: true } & SchemaPreviewBaseFields)
  | ({ ok: false; groups: ValidationGroup[] } & SchemaPreviewBaseFields);

export function previewSchemaChange(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  schemaName: string,
  proposedUpdate: UpdateSchemaInput,
): SchemaPreviewResult {
  const existing = getSchemaDefinition(db, schemaName);
  if (!existing) {
    throw new Error(`Schema '${schemaName}' not found`);
  }

  // Read current claims (pre-savepoint) for diff computation.
  const oldClaims = readCurrentClaims(db, schemaName);

  const base: SchemaPreviewBaseFields = {
    claims_added: [],
    claims_removed: [],
    claims_modified: [],
    orphaned_field_names: [],
    propagation: { nodes_affected: 0, nodes_rerendered: 0, defaults_populated: 0, fields_orphaned: 0 },
  };

  if (proposedUpdate.field_claims !== undefined) {
    const newClaimsShape = proposedUpdate.field_claims.map(c => ({
      field: c.field,
      sort_order: c.sort_order,
      label: c.label,
      description: c.description,
      required: c.required ?? null,
      default_value: c.default_value ?? null,
      enum_values_override: c.enum_values_override ?? null,
    }));
    const diff = diffClaims(oldClaims, newClaimsShape);
    base.claims_added = diff.added;
    base.claims_removed = diff.removed;
    base.claims_modified = diff.changed;
  }

  // The returned claims_added/removed/modified (in `base`) reflects the caller's
  // intent — computed pre-savepoint against the synthetic new-claims shape.
  // Inside the savepoint we re-compute the diff against the post-update DB
  // state to drive propagation. In normal operation these are identical;
  // the split exists because propagation must act on the actually-written
  // shape while the response reflects what the user asked for.
  db.prepare('SAVEPOINT preview_schema_change').run();
  let result: SchemaPreviewResult;
  try {
    try {
      updateSchemaDefinition(db, schemaName, proposedUpdate);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        result = { ok: false, groups: err.groups, ...base };
        return result;
      }
      throw err;
    }

    let propagationGroups: ValidationGroup[] = [];
    if (proposedUpdate.field_claims !== undefined) {
      const newClaims = readCurrentClaims(db, schemaName);
      const diff = diffClaims(oldClaims, newClaims);
      const prop = propagateSchemaChange(db, writeLock, vaultPath, schemaName, diff, undefined, { preview: true });
      base.propagation = {
        nodes_affected: prop.nodes_affected,
        nodes_rerendered: prop.nodes_rerendered,
        defaults_populated: prop.defaults_populated,
        fields_orphaned: prop.fields_orphaned,
      };
      base.orphaned_field_names = prop.orphaned_field_names ?? [];
      propagationGroups = prop.validation_groups ?? [];
    }

    if (propagationGroups.length > 0) {
      result = { ok: false, groups: propagationGroups, ...base };
    } else {
      result = { ok: true, ...base };
    }
    return result;
  } finally {
    db.prepare('ROLLBACK TO SAVEPOINT preview_schema_change').run();
    db.prepare('RELEASE SAVEPOINT preview_schema_change').run();
  }
}

