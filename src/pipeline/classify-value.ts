// src/pipeline/classify-value.ts
//
// Classify a JS value into typed DB columns for node_fields storage.
// Shared between the indexer and the write pipeline.

export interface FieldColumns {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

export function classifyValue(v: unknown): FieldColumns {
  if (v === null || v === undefined) {
    return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(null) };
  }
  if (v instanceof Date) {
    return { value_text: null, value_number: null, value_date: v.toISOString(), value_json: null };
  }
  if (typeof v === 'string') {
    return { value_text: v, value_number: null, value_date: null, value_json: null };
  }
  if (typeof v === 'number') {
    return { value_text: null, value_number: v, value_date: null, value_json: null };
  }
  // boolean, array, object
  return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(v) };
}

/**
 * Reconstruct a JS value from typed DB columns.
 * Inverse of classifyValue. Priority: value_json > value_number > value_date > value_text.
 */
export function reconstructValue(row: {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}): unknown {
  if (row.value_json !== null) return JSON.parse(row.value_json);
  if (row.value_number !== null) return row.value_number;
  if (row.value_date !== null) return row.value_date;
  if (row.value_text !== null) return row.value_text;
  return null;
}
