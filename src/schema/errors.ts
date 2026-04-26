// src/schema/errors.ts
//
// Structured validation errors for schema-ops tools.
// Sets the error-shape contract surfaced in MCP envelope details.

import type { ValidationIssueCode } from '../validation/types.js';

// ClaimValidationReason is the outward-facing reason enum. It collapses the
// pipeline's fine-grained ValidationIssueCode set into reasons that are meaningful to a
// schema-change caller (e.g., COERCION_FAILED + TYPE_MISMATCH both surface as
// TYPE_MISMATCH).
export type ClaimValidationReason =
  | 'UNKNOWN_FIELD'
  | 'OVERRIDE_NOT_ALLOWED'
  | 'STRUCTURAL_INCOMPAT'
  | 'ENUM_INVALID'
  | 'TYPE_MISMATCH'
  | 'REQUIRED_MISSING';

export interface ValidationGroup {
  reason: ClaimValidationReason;
  field: string;
  count: number;
  invalid_values?: Array<{ value: string; count: number }>;
  sample_nodes?: Array<{ id: string; title: string }>;
  message: string;
}

export interface PerNodeIssue {
  node_id: string;
  title: string;
  field: string;
  code: ValidationIssueCode;
  value?: unknown;
}

export class SchemaValidationError extends Error {
  constructor(public readonly groups: ValidationGroup[]) {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    super(`Schema change rejected: ${groups.length} validation group(s), ${total} total issue(s)`);
    this.name = 'SchemaValidationError';
  }
}

const ISSUE_TO_REASON: Record<ValidationIssueCode, ClaimValidationReason | null> = {
  REQUIRED_MISSING: 'REQUIRED_MISSING',
  ENUM_MISMATCH: 'ENUM_INVALID',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  COERCION_FAILED: 'TYPE_MISMATCH',
  LIST_ITEM_COERCION_FAILED: 'TYPE_MISMATCH',
  MERGE_CONFLICT: null,
  INTERNAL_CONSISTENCY: null,
};

const SAMPLE_LIMIT = 5;

export function groupValidationIssues(issues: PerNodeIssue[]): ValidationGroup[] {
  const buckets = new Map<string, {
    reason: ClaimValidationReason;
    field: string;
    nodes: Array<{ id: string; title: string }>;
    values: Map<string, number>;
  }>();

  for (const issue of issues) {
    const reason = ISSUE_TO_REASON[issue.code];
    if (!reason) continue;
    const key = `${reason}:${issue.field}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { reason, field: issue.field, nodes: [], values: new Map() };
      buckets.set(key, bucket);
    }
    bucket.nodes.push({ id: issue.node_id, title: issue.title });
    if (reason === 'ENUM_INVALID' && issue.value !== undefined) {
      const v = typeof issue.value === 'string' ? issue.value : JSON.stringify(issue.value);
      bucket.values.set(v, (bucket.values.get(v) ?? 0) + 1);
    }
  }

  return Array.from(buckets.values()).map(b => {
    const group: ValidationGroup = {
      reason: b.reason,
      field: b.field,
      count: b.nodes.length,
      sample_nodes: b.nodes.slice(0, SAMPLE_LIMIT),
      message: buildMessage(b.reason, b.field, b.nodes.length, b.values),
    };
    if (b.reason === 'ENUM_INVALID' && b.values.size > 0) {
      group.invalid_values = Array.from(b.values.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
    }
    return group;
  });
}

function buildMessage(
  reason: ClaimValidationReason,
  field: string,
  count: number,
  values: Map<string, number>,
): string {
  switch (reason) {
    case 'ENUM_INVALID': {
      const valueList = Array.from(values.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([v, c]) => `${v} (${c})`)
        .join(', ');
      return `${count} node(s) have values not in enum for field '${field}': ${valueList}. Either clean up the values on those nodes, extend the global enum, or enable enum_values_override on the global field.`;
    }
    case 'TYPE_MISMATCH':
      return `${count} node(s) have values incompatible with the declared type of field '${field}'. Fix the values on those nodes, or change the global field's type.`;
    case 'REQUIRED_MISSING':
      return `${count} node(s) are missing required field '${field}'. Provide values on those nodes, mark the claim non-required, or provide a default_value.`;
    case 'UNKNOWN_FIELD':
      return `Claim references unknown global field '${field}'. Create it first with create-global-field.`;
    case 'OVERRIDE_NOT_ALLOWED':
      return `Claim overrides a property on field '${field}' that is not marked overrides_allowed. Set the corresponding overrides_allowed flag on the global field first.`;
    case 'STRUCTURAL_INCOMPAT':
      return `Claim on field '${field}' is structurally incompatible (e.g. enum override on a non-enum field).`;
  }
}
