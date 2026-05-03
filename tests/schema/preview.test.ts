import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { previewSchemaChange } from '../../src/schema/preview.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
});

afterEach(() => { db.close(); cleanup(); });

function createNode(overrides: { file_path: string; title: string; types: string[]; fields?: Record<string, unknown> }) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: overrides.file_path,
    title: overrides.title,
    types: overrides.types,
    fields: overrides.fields ?? {},
    body: '',
  });
}

describe('previewSchemaChange — SAVEPOINT-based preview', () => {
  it('ok:true — claim added, propagation succeeds, DB unchanged after preview', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const claimsBefore = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'status' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims_added).toEqual(['status']);
    expect(result.claims_removed).toEqual([]);
    expect(result.claims_modified).toEqual([]);
    expect(result.propagation.nodes_affected).toBe(1);
    expect(result.propagation.defaults_populated).toBe(1);
    expect(result.propagation.fields_orphaned).toBe(0);
    expect(result.orphaned_field_names).toEqual([]);

    const claimsAfter = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claimsAfter).toEqual(claimsBefore);
  });

  it('ok:false with claim-level failure (UNKNOWN_FIELD) — groups populated, DB unchanged', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [] });

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'nonexistent' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.groups.some(g => g.reason === 'UNKNOWN_FIELD')).toBe(true);

    const claims = db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all('task');
    expect(claims).toEqual([]);
  });

  it('ok:false with propagation-level failure (ENUM_INVALID)', () => {
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'done'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    // Seed a bad status value as an orphan (status is unclaimed here — bypasses create-time enum check).
    createNode({ file_path: 'ok.md', title: 'OK', types: ['task'], fields: { status: 'open' } });
    createNode({ file_path: 'bad.md', title: 'Bad', types: ['task'], fields: { status: 'bogus' } });

    createGlobalField(db, { name: 'priority', field_type: 'string', required: true, default_value: 'normal' });

    // Now claim status + priority — propagation should trip on the bogus value in n2.
    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'status' }, { field: 'priority' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.groups.some(g => g.reason === 'ENUM_INVALID')).toBe(true);
    expect(result.claims_added).toContain('priority');
    expect(result.claims_added).toContain('status');
  });

  it('display-only update — no claim diff, propagation a no-op', () => {
    createSchemaDefinition(db, { name: 'task', field_claims: [], display_name: 'Task' });

    const result = previewSchemaChange(db, writeLock, vaultPath, 'task', {
      display_name: 'Tasks',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims_added).toEqual([]);
    expect(result.claims_removed).toEqual([]);
    expect(result.claims_modified).toEqual([]);
    expect(result.propagation.nodes_affected).toBe(0);
  });

  it('does not write files to disk when propagation would re-render them', () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNode({ file_path: 'a.md', title: 'A', types: ['task'] });

    const mtimeBefore = statSync(join(vaultPath, 'a.md')).mtimeMs;

    previewSchemaChange(db, writeLock, vaultPath, 'task', {
      field_claims: [{ field: 'status' }],
    });

    const mtimeAfter = statSync(join(vaultPath, 'a.md')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
