// src/global-fields/crud.ts

import type Database from 'better-sqlite3';
import type { GlobalFieldDefinition, FieldType } from '../validation/types.js';
import { coerceValue } from '../validation/coerce.js';

// ── Shared types ─────────────────────────────────────────────────────

export interface CreateGlobalFieldInput {
  name: string;
  field_type: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
}

export interface UpdateGlobalFieldInput {
  field_type?: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
  confirm?: boolean;
}

export interface TypeChangeResult {
  preview: boolean;
  applied?: boolean;
  field?: GlobalFieldDefinition;
  affected_nodes?: number;
  coercible?: Array<{ node_id: string; old_value: unknown; new_value: unknown }>;
  uncoercible?: Array<{ node_id: string; value: unknown; reason: string }>;
  would_orphan?: number;
}

const VALID_FIELD_TYPES: Set<string> = new Set([
  'string', 'number', 'date', 'boolean', 'reference', 'enum', 'list',
]);

// ── Value helpers ────────────────────────────────────────────────────

function extractValue(row: {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}): unknown {
  if (row.value_json !== null) return JSON.parse(row.value_json);
  if (row.value_number !== null) return row.value_number;
  if (row.value_date !== null) return row.value_date;
  return row.value_text;
}

function classifyCoercedValue(value: unknown): {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
} {
  if (value === null || value === undefined) {
    return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(null) };
  }
  if (typeof value === 'string') {
    return { value_text: value, value_number: null, value_date: null, value_json: null };
  }
  if (typeof value === 'number') {
    return { value_text: null, value_number: value, value_date: null, value_json: null };
  }
  return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(value) };
}

// ── Row → GlobalFieldDefinition ──────────────────────────────────────

interface GlobalFieldRow {
  name: string;
  field_type: string;
  enum_values: string | null;
  reference_target: string | null;
  description: string | null;
  default_value: string | null;
  required: number;
  overrides_allowed_required: number;
  overrides_allowed_default_value: number;
  overrides_allowed_enum_values: number;
  list_item_type: string | null;
}

function rowToDefinition(row: GlobalFieldRow): GlobalFieldDefinition {
  return {
    name: row.name,
    field_type: row.field_type as FieldType,
    enum_values: row.enum_values ? JSON.parse(row.enum_values) : null,
    reference_target: row.reference_target,
    description: row.description,
    default_value: row.default_value !== null ? JSON.parse(row.default_value) : null,
    required: row.required === 1,
    overrides_allowed: {
      required: row.overrides_allowed_required === 1,
      default_value: row.overrides_allowed_default_value === 1,
      enum_values: row.overrides_allowed_enum_values === 1,
    },
    list_item_type: row.list_item_type as FieldType | null,
  };
}

// ── getGlobalField ───────────────────────────────────────────────────

export function getGlobalField(
  db: Database.Database,
  name: string,
): GlobalFieldDefinition | null {
  const row = db.prepare(`SELECT * FROM global_fields WHERE name = ?`).get(name) as
    | GlobalFieldRow
    | undefined;
  return row ? rowToDefinition(row) : null;
}

// ── createGlobalField ────────────────────────────────────────────────

export function createGlobalField(
  db: Database.Database,
  input: CreateGlobalFieldInput,
): GlobalFieldDefinition {
  // Validate field_type
  if (!VALID_FIELD_TYPES.has(input.field_type)) {
    throw new Error(`Invalid field_type: ${input.field_type}`);
  }

  // Validate enum requires enum_values
  if (input.field_type === 'enum') {
    if (!input.enum_values || input.enum_values.length === 0) {
      throw new Error('enum field_type requires non-empty enum_values');
    }
  }

  // Validate list requires list_item_type
  if (input.field_type === 'list') {
    if (!input.list_item_type) {
      throw new Error('list field_type requires list_item_type');
    }
    if (input.list_item_type === 'list') {
      throw new Error('Nested lists are not allowed (list_item_type cannot be list)');
    }
  }

  const enumValues = input.enum_values ? JSON.stringify(input.enum_values) : null;
  const defaultValue = input.default_value !== undefined && input.default_value !== null
    ? JSON.stringify(input.default_value)
    : null;

  try {
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.field_type,
      enumValues,
      input.reference_target ?? null,
      input.description ?? null,
      defaultValue,
      input.required ? 1 : 0,
      input.overrides_allowed?.required ? 1 : 0,
      input.overrides_allowed?.default_value ? 1 : 0,
      input.overrides_allowed?.enum_values ? 1 : 0,
      input.list_item_type ?? null,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      throw new Error(`Global field '${input.name}' already exists`);
    }
    throw err;
  }

  return getGlobalField(db, input.name)!;
}

// ── updateGlobalField ────────────────────────────────────────────────

export function updateGlobalField(
  db: Database.Database,
  name: string,
  input: UpdateGlobalFieldInput,
): TypeChangeResult {
  const current = getGlobalField(db, name);
  if (!current) {
    throw new Error(`Global field '${name}' not found`);
  }

  const isTypeChange = input.field_type !== undefined && input.field_type !== current.field_type;

  if (!isTypeChange) {
    // Non-type-change: validate invariants after applying updates
    const effectiveType = current.field_type;
    const effectiveEnumValues = input.enum_values !== undefined ? input.enum_values : current.enum_values;
    const effectiveListItemType = input.list_item_type !== undefined ? input.list_item_type : current.list_item_type;

    if (effectiveType === 'enum' && (!effectiveEnumValues || effectiveEnumValues.length === 0)) {
      throw new Error('enum field_type requires non-empty enum_values');
    }
    if (effectiveType === 'list' && !effectiveListItemType) {
      throw new Error('list field_type requires list_item_type');
    }
    if (effectiveListItemType === 'list') {
      throw new Error('Nested lists are not allowed (list_item_type cannot be list)');
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.enum_values !== undefined) {
      updates.push('enum_values = ?');
      params.push(JSON.stringify(input.enum_values));
    }
    if (input.reference_target !== undefined) {
      updates.push('reference_target = ?');
      params.push(input.reference_target);
    }
    if (input.default_value !== undefined) {
      updates.push('default_value = ?');
      params.push(JSON.stringify(input.default_value));
    }
    if (input.required !== undefined) {
      updates.push('required = ?');
      params.push(input.required ? 1 : 0);
    }
    if (input.list_item_type !== undefined) {
      updates.push('list_item_type = ?');
      params.push(input.list_item_type);
    }
    if (input.overrides_allowed !== undefined) {
      if (input.overrides_allowed.required !== undefined) {
        updates.push('overrides_allowed_required = ?');
        params.push(input.overrides_allowed.required ? 1 : 0);
      }
      if (input.overrides_allowed.default_value !== undefined) {
        updates.push('overrides_allowed_default_value = ?');
        params.push(input.overrides_allowed.default_value ? 1 : 0);
      }
      if (input.overrides_allowed.enum_values !== undefined) {
        updates.push('overrides_allowed_enum_values = ?');
        params.push(input.overrides_allowed.enum_values ? 1 : 0);
      }
    }

    if (updates.length > 0) {
      params.push(name);
      db.prepare(`UPDATE global_fields SET ${updates.join(', ')} WHERE name = ?`).run(...params);
    }

    return { preview: false, field: getGlobalField(db, name)! };
  }

  // Type change path
  const newType = input.field_type!;

  // Gather all node_fields rows for this field
  interface NodeFieldRow {
    node_id: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
  }

  const rows = db.prepare(
    `SELECT node_id, value_text, value_number, value_date, value_json FROM node_fields WHERE field_name = ?`,
  ).all(name) as NodeFieldRow[];

  const coercible: Array<{ node_id: string; old_value: unknown; new_value: unknown }> = [];
  const uncoercible: Array<{ node_id: string; value: unknown; reason: string }> = [];

  for (const row of rows) {
    const oldValue = extractValue(row);
    const result = coerceValue(oldValue, newType, {
      enum_values: input.enum_values ?? current.enum_values ?? undefined,
      list_item_type: input.list_item_type ?? current.list_item_type ?? undefined,
    });

    if (result.ok) {
      coercible.push({ node_id: row.node_id, old_value: oldValue, new_value: result.value });
    } else {
      uncoercible.push({ node_id: row.node_id, value: oldValue, reason: result.reason });
    }
  }

  if (!input.confirm) {
    // Preview mode
    return {
      preview: true,
      affected_nodes: rows.length,
      coercible,
      uncoercible,
      would_orphan: uncoercible.length,
    };
  }

  // Apply mode
  const applyTx = db.transaction(() => {
    // Update global_fields type
    const gfUpdates: string[] = ['field_type = ?'];
    const gfParams: unknown[] = [newType];

    if (input.enum_values !== undefined) {
      gfUpdates.push('enum_values = ?');
      gfParams.push(JSON.stringify(input.enum_values));
    }
    if (input.list_item_type !== undefined) {
      gfUpdates.push('list_item_type = ?');
      gfParams.push(input.list_item_type);
    }
    if (input.reference_target !== undefined) {
      gfUpdates.push('reference_target = ?');
      gfParams.push(input.reference_target);
    }

    gfParams.push(name);
    db.prepare(`UPDATE global_fields SET ${gfUpdates.join(', ')} WHERE name = ?`).run(...gfParams);

    // Coerce node_fields
    const updateStmt = db.prepare(
      `UPDATE node_fields SET value_text = ?, value_number = ?, value_date = ?, value_json = ?
       WHERE node_id = ? AND field_name = ?`,
    );

    for (const c of coercible) {
      const cols = classifyCoercedValue(c.new_value);
      updateStmt.run(cols.value_text, cols.value_number, cols.value_date, cols.value_json, c.node_id, name);
    }

    // Remove uncoercible values — the old value can't satisfy the new type,
    // so the field becomes unfilled. The schema claim remains; the node will
    // show this field in unfilled_claims until a valid value is provided.
    if (uncoercible.length > 0) {
      const deleteStmt = db.prepare(
        `DELETE FROM node_fields WHERE node_id = ? AND field_name = ?`,
      );
      const logStmt = db.prepare(
        `INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)`,
      );
      const now = Date.now();
      for (const u of uncoercible) {
        deleteStmt.run(u.node_id, name);
        logStmt.run(u.node_id, now, 'value-removed', JSON.stringify({
          source: 'tool',
          trigger: `update-global-field type change: ${current.field_type} → ${newType}`,
          field: name,
          removed_value: u.value,
          reason: u.reason,
        }));
      }
    }
  });

  applyTx();

  return {
    preview: false,
    applied: true,
    affected_nodes: rows.length,
    coercible,
    uncoercible,
    would_orphan: uncoercible.length,
  };
}

// ── renameGlobalField ────────────────────────────────────────────────

export function renameGlobalField(
  db: Database.Database,
  oldName: string,
  newName: string,
): { affected_nodes: number; affected_schemas: number } {
  const current = getGlobalField(db, oldName);
  if (!current) {
    throw new Error(`Global field '${oldName}' not found`);
  }

  const renameTx = db.transaction(() => {
    // 1. Insert new global_fields row first (so FK references can point to it)
    db.prepare(`
      INSERT INTO global_fields (name, field_type, enum_values, reference_target, description, default_value, required, overrides_allowed_required, overrides_allowed_default_value, overrides_allowed_enum_values, list_item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newName,
      current.field_type,
      current.enum_values ? JSON.stringify(current.enum_values) : null,
      current.reference_target,
      current.description,
      current.default_value !== null ? JSON.stringify(current.default_value) : null,
      current.required ? 1 : 0,
      current.overrides_allowed.required ? 1 : 0,
      current.overrides_allowed.default_value ? 1 : 0,
      current.overrides_allowed.enum_values ? 1 : 0,
      current.list_item_type,
    );

    // 2. Update schema_field_claims to point to new name
    const sfcResult = db.prepare(
      `UPDATE schema_field_claims SET field = ? WHERE field = ?`,
    ).run(newName, oldName);

    // 3. Update node_fields
    const nfResult = db.prepare(
      `UPDATE node_fields SET field_name = ? WHERE field_name = ?`,
    ).run(newName, oldName);

    // 4. Delete old global_fields row (no more FK references to it)
    db.prepare(`DELETE FROM global_fields WHERE name = ?`).run(oldName);

    return {
      affected_nodes: nfResult.changes,
      affected_schemas: sfcResult.changes,
    };
  });

  return renameTx();
}

// ── deleteGlobalField ────────────────────────────────────────────────

export function deleteGlobalField(
  db: Database.Database,
  name: string,
): { affected_nodes: number; affected_schemas: number } {
  // Count before deleting
  const nodeCount = (
    db.prepare(`SELECT COUNT(*) as cnt FROM node_fields WHERE field_name = ?`).get(name) as { cnt: number }
  ).cnt;
  const schemaCount = (
    db.prepare(`SELECT COUNT(*) as cnt FROM schema_field_claims WHERE field = ?`).get(name) as { cnt: number }
  ).cnt;

  // Delete schema_field_claims first (FK has no CASCADE on field column)
  db.prepare(`DELETE FROM schema_field_claims WHERE field = ?`).run(name);
  // Then delete global_fields row
  db.prepare(`DELETE FROM global_fields WHERE name = ?`).run(name);

  return { affected_nodes: nodeCount, affected_schemas: schemaCount };
}
