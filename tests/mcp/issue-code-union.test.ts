import { describe, it, expect } from 'vitest';
import type { IssueCode } from '../../src/mcp/tools/errors.js';

// Compile-time exhaustiveness pin: every variant of IssueCode must
// appear as a key in this map. If a future PR adds a code to the
// union, TS will flag the missing key here. If a code is removed
// from the union but left in the map, TS flags an unknown key.
//
// The Record<IssueCode, true> type IS the test. The runtime assertion
// below just keeps Vitest from skipping the file as empty.
const ALL_ISSUE_CODES: Record<IssueCode, true> = {
  // ValidationIssueCode subset
  REQUIRED_MISSING: true,
  ENUM_MISMATCH: true,
  TYPE_MISMATCH: true,
  COERCION_FAILED: true,
  LIST_ITEM_COERCION_FAILED: true,
  MERGE_CONFLICT: true,
  INTERNAL_CONSISTENCY: true,
  // ToolIssueCode subset
  TITLE_WIKILINK_UNSAFE: true,
  FRONTMATTER_IN_BODY: true,
  TYPE_OP_CONFLICT: true,
  TITLE_FILENAME_SANITIZED: true,
  // Tool-only warning codes (errors.ts)
  CROSS_NODE_FILTER_UNRESOLVED: true,
  DEPRECATED_PARAM: true,
  FIELD_OPERATOR_MISMATCH: true,
  LAST_TYPE_REMOVAL: true,
  PENDING_REFERENCES: true,
  RESULT_TRUNCATED: true,
};

describe('IssueCode union', () => {
  it('all variants are pinned (compile-time check via Record)', () => {
    // The Record<IssueCode, true> declaration is the actual exhaustiveness
    // check — it lives at compile time. This runtime assertion confirms
    // the map is non-empty and the import resolves.
    expect(Object.keys(ALL_ISSUE_CODES).length).toBeGreaterThan(0);
  });
});
