// src/pipeline/errors.ts
//
// Pipeline error predicates and codes.

import type { ValidationIssue } from '../validation/types.js';

/**
 * Determines whether tool-path writes should be blocked.
 * Tool writes proceed when the only error-severity issues are MERGE_CONFLICT
 * (which are schema-design problems, not bad data).
 */
export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some(i => i.severity === 'error' && i.code !== 'MERGE_CONFLICT');
}
