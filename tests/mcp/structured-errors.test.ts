import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import { toolValidationErrorResult } from '../../src/mcp/tools/errors.js';
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
        fields: { status: 'medium' },
        body: '',
      });
    } catch (err) {
      if (err instanceof PipelineError) caughtError = err;
      else throw err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.validation).toBeDefined();

    const result = parseResult(toolValidationErrorResult(caughtError!.validation!));

    expect(result.code).toBe('VALIDATION_FAILED');

    const issues = result.issues as Array<Record<string, unknown>>;
    const enumIssue = issues.find(i => i.code === 'ENUM_MISMATCH');
    expect(enumIssue).toBeDefined();
    expect(enumIssue!.field).toBe('status');

    const details = enumIssue!.details as Record<string, unknown>;
    expect(details.provided).toBe('medium');
    expect(Array.isArray(details.allowed_values)).toBe(true);
    expect(details.allowed_values).toEqual(expect.arrayContaining(['open', 'in-progress', 'done', 'dropped']));
    expect('closest_match' in details).toBe(true);

    const fixable = result.fixable as Array<Record<string, unknown>> | undefined;
    expect(fixable).toBeDefined();
    const statusFix = fixable!.find(f => f.field === 'status');
    expect(statusFix).toBeDefined();
    // closest_match should be a suggestion (string or null)
    expect('suggestion' in statusFix!).toBe(true);
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

    const result = parseResult(toolValidationErrorResult(caughtError!.validation!));

    expect(result.code).toBe('VALIDATION_FAILED');

    const issues = result.issues as Array<Record<string, unknown>>;
    const missingIssue = issues.find(i => i.code === 'REQUIRED_MISSING' && i.field === 'status');
    expect(missingIssue).toBeDefined();

    const fixable = result.fixable as Array<Record<string, unknown>> | undefined;
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

    const result = parseResult(toolValidationErrorResult(caughtError!.validation!));

    expect(result.code).toBe('VALIDATION_FAILED');

    const issues = result.issues as Array<Record<string, unknown>>;
    const typeMismatch = issues.find(i => i.code === 'TYPE_MISMATCH' && i.field === 'priority');
    expect(typeMismatch).toBeDefined();

    const details = typeMismatch!.details as Record<string, unknown>;
    expect(details.expected_type).toBe('number');

    // priority should NOT be in fixable (type mismatches are not fixable)
    const fixable = result.fixable as Array<Record<string, unknown>> | undefined;
    if (fixable) {
      const priorityFix = fixable.find(f => f.field === 'priority');
      expect(priorityFix).toBeUndefined();
    }
  });
});
