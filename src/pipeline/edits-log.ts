// src/pipeline/edits-log.ts
//
// Deviation logging functions for the write pipeline (Section 4 event types).

import type Database from 'better-sqlite3';
import type { CoercedValue, ValidationIssue, MergeConflict } from '../validation/types.js';

export interface EditsLogEntry {
  node_id: string | null;
  event_type: string;
  details: Record<string, unknown>;
}

/**
 * Build edits log entries for deviations during a write.
 * Returns entries to be committed within the pipeline's DB transaction.
 */
export function buildDeviationEntries(
  nodeId: string,
  source: 'tool' | 'watcher',
  coercedState: Record<string, CoercedValue>,
  issues: ValidationIssue[],
  nodeTypes: string[],
  retainedValues?: Record<string, { retained_value: unknown; rejected_value: unknown }>,
  defaultedFields?: Array<{ field: string; default_value: unknown; default_source: 'global' | 'claim' }>,
): EditsLogEntry[] {
  const entries: EditsLogEntry[] = [];

  // value-coerced: fields that were transformed
  for (const [, cv] of Object.entries(coercedState)) {
    if (cv.changed && cv.source === 'provided') {
      entries.push({
        node_id: nodeId,
        event_type: 'value-coerced',
        details: {
          source,
          field: cv.field,
          original_value: cv.original,
          coerced_value: cv.value,
          coercions: cv.coercion_code
            ? [{ step: `${cv.original} → ${cv.value}`, code: cv.coercion_code }]
            : [],
          node_types: nodeTypes,
        },
      });
    }
  }

  // value-rejected: watcher-path only, fields that failed validation
  if (source === 'watcher' && retainedValues) {
    for (const [fieldName, rv] of Object.entries(retainedValues)) {
      const issue = issues.find(i => i.field === fieldName && i.code !== 'MERGE_CONFLICT');
      entries.push({
        node_id: nodeId,
        event_type: 'value-rejected',
        details: {
          source: 'watcher',
          field: fieldName,
          rejected_value: rv.rejected_value,
          retained_value: rv.retained_value,
          reason_code: issue?.code ?? 'UNKNOWN',
          reason: issue?.message ?? 'Validation failed',
          node_types: nodeTypes,
        },
      });
    }
  }

  // merge-conflict: one entry per (field, property) pair
  for (const issue of issues) {
    if (issue.code === 'MERGE_CONFLICT' && issue.details) {
      const conflict = issue.details as MergeConflict;
      const valueInState = coercedState[conflict.field];
      entries.push({
        node_id: nodeId,
        event_type: 'merge-conflict',
        details: {
          source,
          field: conflict.field,
          property: conflict.property,
          conflicting_claims: conflict.conflicting_claims,
          resolution: valueInState ? 'value_written' : 'field_omitted',
          ...(valueInState ? { value_written: valueInState.value } : {}),
          node_types: nodeTypes,
        },
      });
    }
  }

  // field-defaulted
  if (defaultedFields) {
    for (const df of defaultedFields) {
      entries.push({
        node_id: nodeId,
        event_type: 'field-defaulted',
        details: {
          source,
          field: df.field,
          default_value: df.default_value,
          default_source: df.default_source,
          node_types: nodeTypes,
        },
      });
    }
  }

  return entries;
}

/**
 * Write edits log entries to the DB.
 */
export function writeEditsLogEntries(
  db: Database.Database,
  entries: EditsLogEntry[],
): number {
  const stmt = db.prepare(
    'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
  );
  const now = Date.now();
  for (const entry of entries) {
    stmt.run(entry.node_id, now, entry.event_type, JSON.stringify(entry.details));
  }
  return entries.length;
}
