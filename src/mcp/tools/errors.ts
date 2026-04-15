import type { ValidationResult } from '../../validation/types.js';
import { buildFixable } from '../../validation/fixable.js';

export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR' | 'VALIDATION_FAILED' | 'UNKNOWN_TYPE' | 'EXTRACTOR_UNAVAILABLE' | 'AMBIGUOUS_FILENAME' | 'CONFLICT';

export function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function toolErrorResult(code: ErrorCode, message: string) {
  return toolResult({ error: message, code });
}

/**
 * Build a structured VALIDATION_FAILED error response.
 * Includes full issues array and fixable convenience summary.
 */
export function toolValidationErrorResult(validation: ValidationResult) {
  const fixable = buildFixable(validation.issues, validation.effective_fields);
  return toolResult({
    error: `Validation failed with ${validation.issues.filter(i => i.severity === 'error').length} error(s)`,
    code: 'VALIDATION_FAILED' as ErrorCode,
    issues: validation.issues,
    fixable: fixable.length > 0 ? fixable : undefined,
  });
}
