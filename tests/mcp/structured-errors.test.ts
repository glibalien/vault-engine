import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import { fail, adaptIssue } from '../../src/mcp/tools/errors.js';
import { buildFixable } from '../../src/validation/fixable.js';
import type { ValidationResult } from '../../src/validation/types.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';

const writeLock = {
  withLockSync<T>(_path: string, fn: () => T): T { return fn(); },
  isLocked() { return false; },
} as any;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function renderValidationEnvelope(validation: ValidationResult) {
  return fail(
    'VALIDATION_FAILED',
    `Validation failed with ${validation.issues.filter(i => i.severity === 'error').length} error(s)`,
    {
      details: {
        issues: validation.issues.map(adaptIssue),
        fixable: buildFixable(validation.issues, validation.effective_fields),
      },
    },
  );
}

describe('structured validation error responses', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    addUiHints(db);

    // Create global fields
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'in-progress', 'done', 'dropped'],
      required: true,
    });
    createGlobalField(db, {
      name: 'priority',
      field_type: 'number',
      required: false,
    });

    // Create task schema claiming both fields, status required with no default
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [
        { field: 'status', sort_order: 1 },
        { field: 'priority', sort_order: 2 },
      ],
    });
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('bad enum value → VALIDATION_FAILED with ENUM_MISMATCH details and fixable entry', () => {
    let caughtError: PipelineError | undefined;
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: 'Tasks/My Task.md',
        title: 'My Task',
        types: ['task'],
        fields: { status: 'opne' },
        body: '',
      });
    } catch (err) {
      if (err instanceof PipelineError) caughtError = err;
      else throw err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.validation).toBeDefined();

    const result = parseResult(renderValidationEnvelope(caughtError!.validation!));

    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('VALIDATION_FAILED');

    const details = error.details as Record<string, unknown>;
    const issues = details.issues as Array<Record<string, unknown>>;
    const enumIssue = issues.find(i => i.code === 'ENUM_MISMATCH');
    expect(enumIssue).toBeDefined();
    expect(enumIssue!.field).toBe('status');

    const enumDetails = enumIssue!.details as Record<string, unknown>;
    expect(enumDetails.provided).toBe('opne');
    expect(Array.isArray(enumDetails.allowed_values)).toBe(true);
    expect(enumDetails.allowed_values).toEqual(expect.arrayContaining(['open', 'in-progress', 'done', 'dropped']));
    expect(enumDetails.closest_match).toBe('open');

    const fixable = details.fixable as Array<Record<string, unknown>>;
    const statusFix = fixable.find(f => f.field === 'status');
    expect(statusFix).toBeDefined();
    expect(statusFix!.suggestion).toBe('open');
  });

  it('missing required field → fixable entry with allowed_values and null suggestion', () => {
    let caughtError: PipelineError | undefined;
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: 'Tasks/My Task.md',
        title: 'My Task',
        types: ['task'],
        fields: {},
        body: '',
      });
    } catch (err) {
      if (err instanceof PipelineError) caughtError = err;
      else throw err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.validation).toBeDefined();

    const result = parseResult(renderValidationEnvelope(caughtError!.validation!));

    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('VALIDATION_FAILED');

    const details = error.details as Record<string, unknown>;
    const issues = details.issues as Array<Record<string, unknown>>;
    const missingIssue = issues.find(i => i.code === 'REQUIRED_MISSING' && i.field === 'status');
    expect(missingIssue).toBeDefined();

    const fixable = details.fixable as Array<Record<string, unknown>> | undefined;
    expect(fixable).toBeDefined();
    const statusFix = fixable!.find(f => f.field === 'status');
    expect(statusFix).toBeDefined();
    expect(statusFix!.suggestion).toBeNull();
    expect(Array.isArray(statusFix!.allowed_values)).toBe(true);
    expect(statusFix!.allowed_values).toEqual(expect.arrayContaining(['open', 'in-progress', 'done', 'dropped']));
  });

  it('type mismatch on priority → VALIDATION_FAILED with TYPE_MISMATCH details, priority NOT in fixable', () => {
    let caughtError: PipelineError | undefined;
    try {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: 'Tasks/My Task.md',
        title: 'My Task',
        types: ['task'],
        fields: { status: 'open', priority: 'not-a-number' },
        body: '',
      });
    } catch (err) {
      if (err instanceof PipelineError) caughtError = err;
      else throw err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.validation).toBeDefined();

    const result = parseResult(renderValidationEnvelope(caughtError!.validation!));

    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('VALIDATION_FAILED');

    const details = error.details as Record<string, unknown>;
    const issues = details.issues as Array<Record<string, unknown>>;
    const typeMismatch = issues.find(i => i.code === 'TYPE_MISMATCH' && i.field === 'priority');
    expect(typeMismatch).toBeDefined();

    const tmDetails = typeMismatch!.details as Record<string, unknown>;
    expect(tmDetails.expected_type).toBe('number');

    // priority should NOT be in fixable (type mismatches are not fixable)
    const fixable = details.fixable as Array<Record<string, unknown>> | undefined;
    if (fixable) {
      const priorityFix = fixable.find(f => f.field === 'priority');
      expect(priorityFix).toBeUndefined();
    }
  });
});
