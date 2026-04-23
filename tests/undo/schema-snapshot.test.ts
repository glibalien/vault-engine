import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition, deleteSchemaDefinition, getSchemaDefinition } from '../../src/schema/crud.js';
import { createOperation } from '../../src/undo/operation.js';
import { captureSchemaSnapshot, restoreSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
import { renderSchemaFile, deleteSchemaFile } from '../../src/schema/render.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
});

afterEach(() => { db.close(); cleanup(); });

describe('captureSchemaSnapshot + restoreSchemaSnapshot — update path', () => {
  it('restores schema row + claims to pre-update state', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createGlobalField(db, { name: 'priority', field_type: 'string' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status' }],
      display_name: 'Task',
    });

    const op = createOperation(db, { source_tool: 'update-schema', description: 'u' });
    captureSchemaSnapshot(db, op, 'task');

    updateSchemaDefinition(db, 'task', {
      display_name: 'Tasks!',
      field_claims: [{ field: 'priority' }],
    });

    expect(getSchemaDefinition(db, 'task')!.display_name).toBe('Tasks!');
    const claimsBeforeRestore = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claimsBeforeRestore.map(c => c.field)).toEqual(['priority']);

    restoreSchemaSnapshot(db, vaultPath, op, 'task');

    expect(getSchemaDefinition(db, 'task')!.display_name).toBe('Task');
    const claimsAfter = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claimsAfter.map(c => c.field)).toEqual(['status']);
  });
});

describe('captureSchemaSnapshot + restoreSchemaSnapshot — was_new path', () => {
  it('restore deletes a newly created schema (and its yaml file)', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });

    const op = createOperation(db, { source_tool: 'create-schema', description: 'c' });
    captureSchemaSnapshot(db, op, 'task', { was_new: true });

    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    renderSchemaFile(db, vaultPath, 'task');
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(true);

    restoreSchemaSnapshot(db, vaultPath, op, 'task');

    expect(getSchemaDefinition(db, 'task')).toBeNull();
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(false);
  });
});

describe('captureSchemaSnapshot + restoreSchemaSnapshot — was_deleted path', () => {
  it('restore re-inserts a deleted schema + claims + yaml file', () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }], display_name: 'Task' });

    const op = createOperation(db, { source_tool: 'delete-schema', description: 'd' });
    captureSchemaSnapshot(db, op, 'task', { was_deleted: true });

    deleteSchemaDefinition(db, 'task');
    deleteSchemaFile(db, vaultPath, 'task');
    expect(getSchemaDefinition(db, 'task')).toBeNull();

    restoreSchemaSnapshot(db, vaultPath, op, 'task');

    expect(getSchemaDefinition(db, 'task')!.display_name).toBe('Task');
    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task') as Array<{ field: string }>;
    expect(claims.map(c => c.field)).toEqual(['status']);
    expect(existsSync(join(vaultPath, '.schemas', 'task.yaml'))).toBe(true);
  });
});

describe('captureSchemaSnapshot — idempotency', () => {
  it('INSERT OR IGNORE: second capture for same (op, schema) is a no-op', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const op = createOperation(db, { source_tool: 'update-schema', description: 'u' });

    captureSchemaSnapshot(db, op, 'task');
    captureSchemaSnapshot(db, op, 'task');

    const rows = db.prepare('SELECT COUNT(*) AS c FROM undo_schema_snapshots WHERE operation_id = ?').get(op) as { c: number };
    expect(rows.c).toBe(1);
  });
});
