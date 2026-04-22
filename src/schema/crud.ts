// src/schema/crud.ts

import type Database from 'better-sqlite3';
import { SchemaValidationError, type ValidationGroup } from './errors.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface SchemaDefinition {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: unknown;
}

export interface ClaimInput {
  field: string;
  label?: string;
  description?: string;
  sort_order?: number;
  required?: boolean;                        // maps to required_override column
  default_value?: unknown;                   // maps to default_value_override column
  default_value_overridden?: boolean;        // true when default_value key is present (even if null)
  enum_values_override?: string[];           // maps to enum_values_override column
}

export interface CreateSchemaInput {
  name: string;
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims: ClaimInput[];
  metadata?: unknown;
}

export interface UpdateSchemaInput {
  display_name?: string;
  icon?: string;
  filename_template?: string;
  default_directory?: string;
  field_claims?: ClaimInput[];
  metadata?: unknown;
}

// ── Row → SchemaDefinition ────────────────────────────────────────────

interface SchemaRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
}

function rowToDefinition(row: SchemaRow): SchemaDefinition {
  return {
    name: row.name,
    display_name: row.display_name,
    icon: row.icon,
    filename_template: row.filename_template,
    default_directory: row.default_directory,
    metadata: row.metadata !== null ? JSON.parse(row.metadata) : null,
  };
}

// ── Claim validation ──────────────────────────────────────────────────

interface GlobalFieldRow {
  name: string;
  field_type: string;
  list_item_type: string | null;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
}

function validateClaims(db: Database.Database, claims: ClaimInput[]): void {
  const groups: ValidationGroup[] = [];

  for (const claim of claims) {
    const gf = db
      .prepare(`SELECT name, field_type, list_item_type, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values FROM global_fields WHERE name = ?`)
      .get(claim.field) as GlobalFieldRow | undefined;

    if (!gf) {
      groups.push({
        reason: 'UNKNOWN_FIELD',
        field: claim.field,
        count: 1,
        message: `Global field '${claim.field}' does not exist. Create it first with create-global-field.`,
      });
      continue; // subsequent checks on this claim are meaningless without gf
    }

    if (claim.required !== undefined && gf.overrides_allowed_required !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow required overrides. Set overrides_allowed.required = true on the global field.`,
      });
    }
    if ((claim.default_value !== undefined || claim.default_value_overridden) && gf.overrides_allowed_default_value !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow default_value overrides. Set overrides_allowed.default_value = true on the global field.`,
      });
    }
    if (claim.enum_values_override !== undefined && gf.overrides_allowed_enum_values !== 1) {
      groups.push({
        reason: 'OVERRIDE_NOT_ALLOWED',
        field: claim.field,
        count: 1,
        message: `Field '${claim.field}' does not allow enum_values overrides. Set overrides_allowed.enum_values = true on the global field.`,
      });
    }

    if (claim.enum_values_override !== undefined) {
      const isEnumCompatible =
        gf.field_type === 'enum' ||
        (gf.field_type === 'list' && gf.list_item_type === 'enum');
      if (!isEnumCompatible) {
        groups.push({
          reason: 'STRUCTURAL_INCOMPAT',
          field: claim.field,
          count: 1,
          message: `Field '${claim.field}' (${gf.field_type}${gf.list_item_type ? '<' + gf.list_item_type + '>' : ''}) is structurally incompatible with enum_values_override. Only enum and list<enum> fields support enum overrides.`,
        });
      }
    }
  }

  if (groups.length > 0) throw new SchemaValidationError(groups);
}

// ── Insert claims ─────────────────────────────────────────────────────

function insertClaims(db: Database.Database, schemaName: string, claims: ClaimInput[]): void {
  const stmt = db.prepare(`
    INSERT INTO schema_field_claims (schema_name, field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const claim of claims) {
    const requiredInt =
      claim.required === undefined ? null : claim.required ? 1 : 0;

    // Discriminated union: default_value_overridden distinguishes inherit from override-to-null
    const overridden = claim.default_value_overridden ?? (claim.default_value !== undefined);
    const defaultValueJson = overridden
      ? (claim.default_value !== undefined && claim.default_value !== null ? JSON.stringify(claim.default_value) : null)
      : null;

    const enumOverrideJson = claim.enum_values_override
      ? JSON.stringify(claim.enum_values_override)
      : null;

    stmt.run(
      schemaName,
      claim.field,
      claim.label ?? null,
      claim.description ?? null,
      claim.sort_order ?? null,
      requiredInt,
      defaultValueJson,
      overridden ? 1 : 0,
      enumOverrideJson,
    );
  }
}

// ── getSchemaDefinition ───────────────────────────────────────────────

export function getSchemaDefinition(
  db: Database.Database,
  name: string,
): SchemaDefinition | null {
  const row = db
    .prepare(`SELECT name, display_name, icon, filename_template, default_directory, metadata FROM schemas WHERE name = ?`)
    .get(name) as SchemaRow | undefined;
  return row ? rowToDefinition(row) : null;
}

// ── createSchemaDefinition ────────────────────────────────────────────

export function createSchemaDefinition(
  db: Database.Database,
  input: CreateSchemaInput,
): SchemaDefinition {
  validateClaims(db, input.field_claims);

  const metadataJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO schemas (name, display_name, icon, filename_template, default_directory, field_claims, metadata)
      VALUES (?, ?, ?, ?, ?, '[]', ?)
    `).run(
      input.name,
      input.display_name ?? null,
      input.icon ?? null,
      input.filename_template ?? null,
      input.default_directory ?? null,
      metadataJson,
    );

    insertClaims(db, input.name, input.field_claims);
  });

  tx();

  return getSchemaDefinition(db, input.name)!;
}

// ── updateSchemaDefinition ────────────────────────────────────────────

export function updateSchemaDefinition(
  db: Database.Database,
  name: string,
  input: UpdateSchemaInput,
): SchemaDefinition {
  const current = getSchemaDefinition(db, name);
  if (!current) {
    throw new Error(`Schema '${name}' not found`);
  }

  if (input.field_claims !== undefined) {
    validateClaims(db, input.field_claims);
  }

  const tx = db.transaction(() => {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.display_name !== undefined) {
      updates.push('display_name = ?');
      params.push(input.display_name);
    }
    if (input.icon !== undefined) {
      updates.push('icon = ?');
      params.push(input.icon);
    }
    if (input.filename_template !== undefined) {
      updates.push('filename_template = ?');
      params.push(input.filename_template);
    }
    if (input.default_directory !== undefined) {
      updates.push('default_directory = ?');
      params.push(input.default_directory);
    }
    if (input.metadata !== undefined) {
      updates.push('metadata = ?');
      params.push(JSON.stringify(input.metadata));
    }

    if (updates.length > 0) {
      params.push(name);
      db.prepare(`UPDATE schemas SET ${updates.join(', ')} WHERE name = ?`).run(...params);
    }

    if (input.field_claims !== undefined) {
      db.prepare(`DELETE FROM schema_field_claims WHERE schema_name = ?`).run(name);
      insertClaims(db, name, input.field_claims);
    }
  });

  tx();

  return getSchemaDefinition(db, name)!;
}

// ── deleteSchemaDefinition ────────────────────────────────────────────

export function deleteSchemaDefinition(
  db: Database.Database,
  name: string,
): { affected_nodes: number } {
  const current = getSchemaDefinition(db, name);
  if (!current) {
    throw new Error(`Schema '${name}' not found`);
  }

  const affectedNodes = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM node_types WHERE schema_type = ?`)
      .get(name) as { cnt: number }
  ).cnt;

  // CASCADE removes schema_field_claims
  db.prepare(`DELETE FROM schemas WHERE name = ?`).run(name);

  return { affected_nodes: affectedNodes };
}
