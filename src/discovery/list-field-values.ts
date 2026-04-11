// src/discovery/list-field-values.ts
//
// Discovery comes before definition — this module operates on node_fields
// directly and works whether or not a global field exists for the field name.

import type Database from 'better-sqlite3';

export interface ListFieldValuesResult {
  values: Array<{ value: unknown; count: number }>;
  total_nodes: number;
  total_distinct: number;
}

export function listFieldValues(
  db: Database.Database,
  fieldName: string,
  options?: { types?: string[]; limit?: number },
): ListFieldValuesResult {
  const limit = options?.limit ?? 50;
  const types = options?.types;

  // Build query. When types filter is provided, join against node_types.
  // Use COALESCE to produce a consistent group key across the typed columns.
  // We also need to recover the actual typed value for the result, so we
  // include each column individually and select the first non-null one.
  const typeJoin = types && types.length > 0
    ? `JOIN node_types nt ON nf.node_id = nt.node_id AND nt.schema_type IN (${types.map(() => '?').join(',')})`
    : '';

  const sql = `
    SELECT
      COALESCE(nf.value_text, CAST(nf.value_number AS TEXT), nf.value_date, nf.value_json) AS group_key,
      nf.value_text,
      nf.value_number,
      nf.value_date,
      nf.value_json,
      COUNT(*) AS cnt
    FROM node_fields nf
    ${typeJoin}
    WHERE nf.field_name = ?
    GROUP BY group_key
    ORDER BY cnt DESC
    LIMIT ?
  `;

  const params: unknown[] = [];
  if (types && types.length > 0) {
    params.push(...types);
  }
  params.push(fieldName, limit);

  interface Row {
    group_key: string | null;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
    cnt: number;
  }

  const rows = db.prepare(sql).all(...params) as Row[];

  // Count totals — we need a separate query for total_nodes (before limit)
  // and total_distinct.
  const totalSql = `
    SELECT
      COUNT(*) AS total_nodes,
      COUNT(DISTINCT COALESCE(nf.value_text, CAST(nf.value_number AS TEXT), nf.value_date, nf.value_json)) AS total_distinct
    FROM node_fields nf
    ${typeJoin}
    WHERE nf.field_name = ?
  `;

  const totalParams: unknown[] = [];
  if (types && types.length > 0) {
    totalParams.push(...types);
  }
  totalParams.push(fieldName);

  const totals = db.prepare(totalSql).get(...totalParams) as {
    total_nodes: number;
    total_distinct: number;
  };

  const values = rows.map(row => {
    let value: unknown;
    if (row.value_number !== null) {
      value = row.value_number;
    } else if (row.value_date !== null) {
      value = row.value_date;
    } else if (row.value_json !== null) {
      try {
        value = JSON.parse(row.value_json);
      } catch {
        value = row.value_json;
      }
    } else {
      value = row.value_text;
    }
    return { value, count: row.cnt };
  });

  return {
    values,
    total_nodes: totals.total_nodes,
    total_distinct: totals.total_distinct,
  };
}
