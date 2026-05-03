import type Database from 'better-sqlite3';
import { StaleNodeError } from '../../pipeline/execute.js';
import { fail } from './errors.js';

interface CurrentNodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  version: number;
}

interface FieldRow {
  field_name: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

export function buildCurrentNodeForStale(db: Database.Database, nodeId: string): Record<string, unknown> | undefined {
  const row = db.prepare(
    'SELECT id, file_path, title, body, version FROM nodes WHERE id = ?',
  ).get(nodeId) as CurrentNodeRow | undefined;

  if (row === undefined) return undefined;

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY rowid')
    .all(nodeId) as { schema_type: string }[]).map(t => t.schema_type);
  const fieldRows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?',
  ).all(nodeId) as FieldRow[];
  const fields: Record<string, unknown> = {};
  for (const f of fieldRows) {
    if (f.value_text !== null) fields[f.field_name] = f.value_text;
    else if (f.value_number !== null) fields[f.field_name] = f.value_number;
    else if (f.value_date !== null) fields[f.field_name] = f.value_date;
    else if (f.value_json !== null) fields[f.field_name] = JSON.parse(f.value_json);
  }

  return {
    id: row.id,
    file_path: row.file_path,
    title: row.title,
    types,
    fields,
    body: row.body,
    version: row.version,
  };
}

export function buildStaleNodeDetails(db: Database.Database, err: StaleNodeError): Record<string, unknown> {
  const details: Record<string, unknown> = {
    current_version: err.currentVersion,
    expected_version: err.expectedVersion,
  };
  const currentNode = buildCurrentNodeForStale(db, err.nodeId);
  if (currentNode !== undefined) {
    details.current_node = currentNode;
  }
  return details;
}

export function buildStaleNodeEnvelope(db: Database.Database, err: StaleNodeError) {
  return fail(
    'STALE_NODE',
    `Node ${err.nodeId} was modified (v${err.expectedVersion} -> v${err.currentVersion})`,
    { details: buildStaleNodeDetails(db, err) },
  );
}
