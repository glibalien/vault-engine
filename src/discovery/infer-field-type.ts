// src/discovery/infer-field-type.ts
//
// Purely observational — ignores any existing global field definition.
// Classifies each node_fields row by which typed column is populated,
// then picks the dominant type and computes confidence.

import type Database from 'better-sqlite3';
import type { FieldType } from '../validation/types.js';

export interface InferFieldTypeResult {
  proposed_type: FieldType;
  confidence: number; // 0.0-1.0
  evidence: {
    distinct_values: number;
    sample_values: unknown[];
    type_distribution: Record<string, number>;
    dissenters: Array<{ node_id: string; value: unknown }>;
  };
}

interface NodeFieldRow {
  node_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

function classifyRow(row: NodeFieldRow): string {
  if (row.value_number !== null) return 'number';
  if (row.value_date !== null) return 'date';
  if (row.value_json !== null) {
    try {
      const parsed = JSON.parse(row.value_json);
      if (typeof parsed === 'boolean') return 'boolean';
      if (Array.isArray(parsed)) return 'list';
    } catch {
      // fall through to string
    }
    return 'string';
  }
  return 'string';
}

function extractValue(row: NodeFieldRow): unknown {
  if (row.value_number !== null) return row.value_number;
  if (row.value_date !== null) return row.value_date;
  if (row.value_json !== null) {
    try {
      return JSON.parse(row.value_json);
    } catch {
      return row.value_json;
    }
  }
  return row.value_text;
}

export function inferFieldType(
  db: Database.Database,
  fieldName: string,
): InferFieldTypeResult {
  const empty: InferFieldTypeResult = {
    proposed_type: 'string',
    confidence: 0,
    evidence: {
      distinct_values: 0,
      sample_values: [],
      type_distribution: {},
      dissenters: [],
    },
  };

  const rows = db.prepare(
    `SELECT node_id, value_text, value_number, value_date, value_json
     FROM node_fields
     WHERE field_name = ?`,
  ).all(fieldName) as NodeFieldRow[];

  if (rows.length === 0) return empty;

  // Build type distribution
  const typeDistribution: Record<string, number> = {};
  for (const row of rows) {
    const t = classifyRow(row);
    typeDistribution[t] = (typeDistribution[t] ?? 0) + 1;
  }

  // Find dominant type
  let dominantType = 'string';
  let dominantCount = 0;
  for (const [type, count] of Object.entries(typeDistribution)) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantType = type;
    }
  }

  const total = rows.length;
  let confidence = dominantCount / total;

  // Collect sample values (up to 10 unique)
  const seenSamples = new Set<string>();
  const sampleValues: unknown[] = [];
  for (const row of rows) {
    if (sampleValues.length >= 10) break;
    const val = extractValue(row);
    const key = JSON.stringify(val);
    if (!seenSamples.has(key)) {
      seenSamples.add(key);
      sampleValues.push(val);
    }
  }

  // Dissenters: values that don't match the dominant type. Cap at 10 per dissenter type.
  const dissenterCountByType: Record<string, number> = {};
  const dissenters: Array<{ node_id: string; value: unknown }> = [];
  for (const row of rows) {
    const t = classifyRow(row);
    if (t !== dominantType) {
      dissenterCountByType[t] = (dissenterCountByType[t] ?? 0) + 1;
      if (dissenterCountByType[t] <= 10) {
        dissenters.push({ node_id: row.node_id, value: extractValue(row) });
      }
    }
  }

  // Compute distinct values count
  const distinctQuery = db.prepare(
    `SELECT COUNT(DISTINCT COALESCE(value_text, CAST(value_number AS TEXT), value_date, value_json)) AS cnt
     FROM node_fields
     WHERE field_name = ?`,
  ).get(fieldName) as { cnt: number };
  const distinctValues = distinctQuery.cnt;

  // Enum heuristic: applies when dominant type is string
  let proposedType: FieldType = dominantType as FieldType;
  if (dominantType === 'string' && dominantCount >= 5) {
    const distinctRatio = distinctValues / total;
    if (distinctValues <= 10 && distinctRatio <= 0.3) {
      proposedType = 'enum';
    }
  }

  return {
    proposed_type: proposedType,
    confidence,
    evidence: {
      distinct_values: distinctValues,
      sample_values: sampleValues,
      type_distribution: typeDistribution,
      dissenters,
    },
  };
}
