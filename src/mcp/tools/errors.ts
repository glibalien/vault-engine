import type { ValidationResult, ValidationIssue } from '../../validation/types.js';
import type { ToolIssue } from './title-warnings.js';
import { buildFixable } from '../../validation/fixable.js';

export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'AMBIGUOUS_MATCH'
  | 'INTERNAL_ERROR'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_TYPE'
  | 'EXTRACTOR_UNAVAILABLE'
  | 'AMBIGUOUS_FILENAME'
  | 'CONFLICT'
  | 'BATCH_FAILED';

export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  details?: unknown;
}

export type Envelope<T> =
  | { ok: true; data: T; warnings: Issue[] }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> }; warnings: Issue[] };

type ToolCallResult = { content: Array<{ type: 'text'; text: string }> };

function wrap(body: unknown): ToolCallResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

export function ok<T>(data: T, warnings: Issue[] = []): ToolCallResult {
  const env: Envelope<T> = { ok: true, data, warnings };
  return wrap(env);
}

export function fail(
  code: ErrorCode,
  message: string,
  options?: { details?: Record<string, unknown>; warnings?: Issue[] },
): ToolCallResult {
  const error = options?.details !== undefined
    ? { code, message, details: options.details }
    : { code, message };
  const env: Envelope<never> = { ok: false, error, warnings: options?.warnings ?? [] };
  return wrap(env);
}

export function adaptIssue(v: ValidationIssue | ToolIssue): Issue {
  // Discriminator: ValidationIssue has severity: 'error' (required); ToolIssue has no severity.
  // If ToolIssue ever gains a severity field, update this discriminator to use a more explicit check.
  if ('severity' in v) {
    const issue: Issue = {
      code: v.code,
      message: v.message,
      severity: v.severity,
    };
    if (v.field !== undefined) issue.field = v.field;
    if (v.details !== undefined) issue.details = v.details;
    return issue;
  }
  const issue: Issue = { code: v.code, message: v.message, severity: 'warning' };
  if (v.characters !== undefined) issue.details = { characters: v.characters };
  return issue;
}

// ─── Legacy helpers — to be deleted in final task ─────────────────────

export function toolResult(data: unknown): ToolCallResult {
  return wrap(data);
}

export function toolErrorResult(code: ErrorCode, message: string) {
  return toolResult({ error: message, code });
}

export function toolValidationErrorResult(validation: ValidationResult) {
  const fixable = buildFixable(validation.issues, validation.effective_fields);
  return toolResult({
    error: `Validation failed with ${validation.issues.filter(i => i.severity === 'error').length} error(s)`,
    code: 'VALIDATION_FAILED' as ErrorCode,
    issues: validation.issues,
    fixable,
  });
}
