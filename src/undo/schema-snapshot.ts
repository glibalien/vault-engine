// src/undo/schema-snapshot.ts
//
// Schema-level undo snapshot capture and restore. Mirrors the node-level
// undo_snapshots flow but operates on schemas + schema_field_claims.

import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { renderSchemaFile } from '../schema/render.js';

export interface CaptureOptions {
  was_new?: boolean;
  was_deleted?: boolean;
}

interface SchemaRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
}

interface ClaimRow {
  field: string;
  label: string | null;
  description: string | null;
  sort_order: number;
  required_override: number | null;
  default_value_override: string | null;
  default_value_overridden: number;
  enum_values_override: string | null;
}

/**
 * Capture the pre-mutation state of a schema into undo_schema_snapshots.
 *
 * - was_new=true: called before a create-schema; stores a marker row only.
 *   Restore = DELETE.
 * - was_deleted=true: called before a delete-schema; captures current schema
 *   row + all claims so restore can re-INSERT.
 * - Default (update path): captures current schema row + claims so restore
 *   can UPDATE schemas + DELETE/re-INSERT schema_field_claims.
 *
 * INSERT OR IGNORE: idempotent when multi-call tool handlers share an
 * operation_id.
 */
export function captureSchemaSnapshot(
  db: Database.Database,
  operation_id: string,
  schema_name: string,
  opts: CaptureOptions = {},
): void {
  const wasNew = opts.was_new === true ? 1 : 0;
  const wasDeleted = opts.was_deleted === true ? 1 : 0;

  if (wasNew === 1) {
    db.prepare(`
      INSERT OR IGNORE INTO undo_schema_snapshots (
        operation_id, schema_name, was_new, was_deleted,
        display_name, icon, filename_template, default_directory, metadata, field_claims
      ) VALUES (?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(operation_id, schema_name);
    return;
  }

  const schemaRow = db.prepare(
    'SELECT name, display_name, icon, filename_template, default_directory, metadata FROM schemas WHERE name = ?',
  ).get(schema_name) as SchemaRow | undefined;
  if (!schemaRow) return;

  const claims = db.prepare(
    'SELECT field, label, description, sort_order, required_override, default_value_override, default_value_overridden, enum_values_override FROM schema_field_claims WHERE schema_name = ?',
  ).all(schema_name) as ClaimRow[];

  db.prepare(`
    INSERT OR IGNORE INTO undo_schema_snapshots (
      operation_id, schema_name, was_new, was_deleted,
      display_name, icon, filename_template, default_directory, metadata, field_claims
    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    operation_id,
    schema_name,
    wasDeleted,
    schemaRow.display_name,
    schemaRow.icon,
    schemaRow.filename_template,
    schemaRow.default_directory,
    schemaRow.metadata,
    JSON.stringify(claims),
  );
}

interface SnapshotRow {
  operation_id: string;
  schema_name: string;
  was_new: number;
  was_deleted: number;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  metadata: string | null;
  field_claims: string | null;
}

/**
 * Restore a schema to its captured state.
 */
export function restoreSchemaSnapshot(
  db: Database.Database,
  vaultPath: string,
  operation_id: string,
  schema_name: string,
): void {
  const snap = db.prepare(
    'SELECT * FROM undo_schema_snapshots WHERE operation_id = ? AND schema_name = ?',
  ).get(operation_id, schema_name) as SnapshotRow | undefined;
  if (!snap) return;

  if (snap.was_new === 1) {
    db.prepare('DELETE FROM schemas WHERE name = ?').run(schema_name);
    try {
      const absPath = safeVaultPath(vaultPath, join('.schemas', `${schema_name}.yaml`));
      if (existsSync(absPath)) unlinkSync(absPath);
      db.prepare('DELETE FROM schema_file_hashes WHERE file_path = ?').run(`.schemas/${schema_name}.yaml`);
    } catch {
      // Path traversal block or file-missing — don't propagate; restore continues.
    }
    return;
  }

  db.prepare(`
    INSERT OR REPLACE INTO schemas (
      name, display_name, icon, filename_template, default_directory, field_claims, metadata
    ) VALUES (?, ?, ?, ?, ?, '[]', ?)
  `).run(
    schema_name,
    snap.display_name,
    snap.icon,
    snap.filename_template,
    snap.default_directory,
    snap.metadata,
  );

  db.prepare('DELETE FROM schema_field_claims WHERE schema_name = ?').run(schema_name);
  if (snap.field_claims) {
    const claims = JSON.parse(snap.field_claims) as Array<{
      field: string; label: string | null; description: string | null; sort_order: number;
      required_override: number | null; default_value_override: string | null;
      default_value_overridden: number; enum_values_override: string | null;
    }>;
    const insert = db.prepare(`
      INSERT INTO schema_field_claims (
        schema_name, field, label, description, sort_order,
        required_override, default_value_override, default_value_overridden, enum_values_override
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of claims) {
      insert.run(
        schema_name,
        c.field,
        c.label,
        c.description,
        c.sort_order,
        c.required_override,
        c.default_value_override,
        c.default_value_overridden,
        c.enum_values_override,
      );
    }
  }

  renderSchemaFile(db, vaultPath, schema_name);
}
