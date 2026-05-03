// src/undo/global-field-snapshot.ts
//
// Global-field undo snapshots. Captures the global_fields row plus dependent
// schema_field_claims and node_fields rows with explicit shared column lists.

import type Database from 'better-sqlite3';

export const GLOBAL_FIELD_COLUMNS = [
  'name',
  'field_type',
  'enum_values',
  'reference_target',
  'description',
  'default_value',
  'required',
  'overrides_allowed_required',
  'overrides_allowed_default_value',
  'overrides_allowed_enum_values',
  'list_item_type',
  'ui_hints',
] as const;

export const SCHEMA_FIELD_CLAIM_COLUMNS = [
  'schema_name',
  'field',
  'label',
  'description',
  'sort_order',
  'required_override',
  'default_value_override',
  'default_value_overridden',
  'enum_values_override',
] as const;

export const NODE_FIELD_COLUMNS = [
  'node_id',
  'field_name',
  'value_text',
  'value_number',
  'value_date',
  'value_json',
  'value_raw_text',
  'source',
] as const;

type GlobalFieldRow = Record<(typeof GLOBAL_FIELD_COLUMNS)[number], string | number | null>;
type SchemaFieldClaimRow = Record<(typeof SCHEMA_FIELD_CLAIM_COLUMNS)[number], string | number | null>;
type NodeFieldRow = Record<(typeof NODE_FIELD_COLUMNS)[number], string | number | null>;

interface SnapshotRow {
  operation_id: string;
  field_name: string;
  was_new: number;
  was_deleted: number;
  was_renamed_from: string | null;
  global_field: string | null;
  schema_claims: string;
  node_fields: string;
}

export interface CaptureGlobalFieldOptions {
  was_new?: boolean;
  was_deleted?: boolean;
  was_renamed_from?: string;
}

export interface GlobalFieldRestoreFileAction {
  renderFieldsCatalog: true;
  schemaNames: string[];
  nodeIds: string[];
}

/**
 * Capture pre-mutation state for one global-field operation.
 *
 * `fieldName` is the operation identity. For rename, pass the new name as
 * `fieldName` and the old name as `was_renamed_from`.
 */
export function captureGlobalFieldSnapshot(
  db: Database.Database,
  operation_id: string,
  fieldName: string,
  opts: CaptureGlobalFieldOptions = {},
): void {
  const wasNew = opts.was_new === true ? 1 : 0;
  const wasDeleted = opts.was_deleted === true ? 1 : 0;
  const sourceFieldName = opts.was_renamed_from ?? fieldName;

  let globalField: GlobalFieldRow | null = null;
  let schemaClaims: SchemaFieldClaimRow[] = [];
  let nodeFields: NodeFieldRow[] = [];

  if (wasNew !== 1) {
    globalField = (db.prepare(
      `SELECT ${GLOBAL_FIELD_COLUMNS.join(', ')} FROM global_fields WHERE name = ?`,
    ).get(sourceFieldName) as GlobalFieldRow | undefined) ?? null;
    if (!globalField) return;

    schemaClaims = db.prepare(
      `SELECT ${SCHEMA_FIELD_CLAIM_COLUMNS.join(', ')} FROM schema_field_claims WHERE field = ? ORDER BY schema_name`,
    ).all(sourceFieldName) as SchemaFieldClaimRow[];
    nodeFields = db.prepare(
      `SELECT ${NODE_FIELD_COLUMNS.join(', ')} FROM node_fields WHERE field_name = ? ORDER BY node_id`,
    ).all(sourceFieldName) as NodeFieldRow[];
  }

  db.prepare(`
    INSERT OR IGNORE INTO undo_global_field_snapshots (
      operation_id, field_name, was_new, was_deleted, was_renamed_from,
      global_field, schema_claims, node_fields
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation_id,
    fieldName,
    wasNew,
    wasDeleted,
    opts.was_renamed_from ?? null,
    globalField ? JSON.stringify(globalField) : null,
    JSON.stringify(schemaClaims),
    JSON.stringify(nodeFields),
  );

  db.prepare('UPDATE undo_operations SET global_field_count = 1 WHERE operation_id = ?').run(operation_id);
}

export function restoreGlobalFieldSnapshot(
  db: Database.Database,
  operation_id: string,
  fieldName: string,
): GlobalFieldRestoreFileAction | null {
  const snap = db.prepare(`
    SELECT operation_id, field_name, was_new, was_deleted, was_renamed_from,
           global_field, schema_claims, node_fields
    FROM undo_global_field_snapshots
    WHERE operation_id = ? AND field_name = ?
  `).get(operation_id, fieldName) as SnapshotRow | undefined;
  if (!snap) return null;

  const schemaClaims = JSON.parse(snap.schema_claims) as SchemaFieldClaimRow[];
  const nodeFields = JSON.parse(snap.node_fields) as NodeFieldRow[];
  const currentSchemaNames = getSchemaNamesForField(db, snap.field_name);
  const currentNodeIds = getNodeIdsForField(db, snap.field_name);
  const schemaNames = unique([...schemaClaims.map(r => String(r.schema_name)), ...currentSchemaNames]);
  const nodeIds = unique([...nodeFields.map(r => String(r.node_id)), ...currentNodeIds]);

  if (snap.was_new === 1) {
    deleteFieldState(db, snap.field_name);
    return { renderFieldsCatalog: true, schemaNames, nodeIds };
  }

  const restoreName = snap.was_renamed_from ?? snap.field_name;
  if (snap.was_renamed_from !== null) {
    deleteFieldState(db, snap.field_name);
    deleteFieldState(db, restoreName);
  } else {
    deleteFieldState(db, restoreName);
  }

  const globalField = snap.global_field ? JSON.parse(snap.global_field) as GlobalFieldRow : null;
  if (globalField) insertGlobalField(db, { ...globalField, name: restoreName });
  insertSchemaClaims(db, schemaClaims.map(row => ({ ...row, field: restoreName })));
  insertNodeFields(db, nodeFields.map(row => ({ ...row, field_name: restoreName })));

  return { renderFieldsCatalog: true, schemaNames, nodeIds };
}

function deleteFieldState(db: Database.Database, fieldName: string): void {
  db.prepare('DELETE FROM schema_field_claims WHERE field = ?').run(fieldName);
  db.prepare('DELETE FROM node_fields WHERE field_name = ?').run(fieldName);
  db.prepare('DELETE FROM global_fields WHERE name = ?').run(fieldName);
}

function insertGlobalField(db: Database.Database, row: GlobalFieldRow): void {
  const placeholders = GLOBAL_FIELD_COLUMNS.map(() => '?').join(', ');
  db.prepare(`
    INSERT INTO global_fields (${GLOBAL_FIELD_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `).run(...GLOBAL_FIELD_COLUMNS.map(col => row[col]));
}

function insertSchemaClaims(db: Database.Database, rows: SchemaFieldClaimRow[]): void {
  const placeholders = SCHEMA_FIELD_CLAIM_COLUMNS.map(() => '?').join(', ');
  const insert = db.prepare(`
    INSERT INTO schema_field_claims (${SCHEMA_FIELD_CLAIM_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `);
  for (const row of rows) insert.run(...SCHEMA_FIELD_CLAIM_COLUMNS.map(col => row[col]));
}

function insertNodeFields(db: Database.Database, rows: NodeFieldRow[]): void {
  const placeholders = NODE_FIELD_COLUMNS.map(() => '?').join(', ');
  const insert = db.prepare(`
    INSERT INTO node_fields (${NODE_FIELD_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `);
  for (const row of rows) insert.run(...NODE_FIELD_COLUMNS.map(col => row[col]));
}

function getSchemaNamesForField(db: Database.Database, fieldName: string): string[] {
  return (db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ? ORDER BY schema_name')
    .all(fieldName) as Array<{ schema_name: string }>).map(r => r.schema_name);
}

function getNodeIdsForField(db: Database.Database, fieldName: string): string[] {
  return (db.prepare('SELECT DISTINCT node_id FROM node_fields WHERE field_name = ? ORDER BY node_id')
    .all(fieldName) as Array<{ node_id: string }>).map(r => r.node_id);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
