import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import type { ProposedMutation } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
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

afterEach(() => {
  db.close();
  cleanup();
});

function makeMutation(overrides: Partial<ProposedMutation> = {}): ProposedMutation {
  return {
    source: 'propagation',
    node_id: null,
    file_path: 'test-node.md',
    title: 'Test Node',
    types: [],
    fields: {},
    body: '',
    ...overrides,
  };
}

describe("executeMutation — source: 'propagation'", () => {
  it('tolerates REQUIRED_MISSING (does not throw)', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // First create a node WITHOUT the required field via the normalizer source
    // (which tolerates REQUIRED_MISSING). We can't create with 'tool' since that
    // would reject on the missing required field.
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'normalizer',
      file_path: 'task.md',
      title: 'Task',
      types: ['task'],
      fields: {},
    }));
    expect(created.node_id).toBeTruthy();

    // Re-render via propagation; should NOT throw despite REQUIRED_MISSING
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'propagation',
      node_id: created.node_id,
      file_path: 'task.md',
      title: 'Task',
      types: ['task'],
      fields: {},
    }));

    expect(result.node_id).toBe(created.node_id);
    expect(result.validation.issues.some(i => i.code === 'REQUIRED_MISSING')).toBe(true);
  });

  it('throws on non-tolerated errors (TYPE_MISMATCH)', () => {
    createGlobalField(db, { name: 'count', field_type: 'number' });
    createSchemaDefinition(db, { name: 'item', field_claims: [{ field: 'count' }] });

    expect(() => {
      executeMutation(db, writeLock, vaultPath, makeMutation({
        source: 'propagation',
        file_path: 'item.md',
        title: 'Item',
        types: ['item'],
        fields: { count: 'not-a-number' },
      }));
    }).toThrow(PipelineError);
  });

  it("skipDefaults is true: required+default missing stays missing", () => {
    // With skipDefaults=true, the validator must NOT populate the default.
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'propagation',
      file_path: 'task.md',
      title: 'Task',
      types: ['task'],
      fields: {},
    }));

    // Field remains absent from coerced_state (no 'defaulted' entry)
    expect(result.validation.coerced_state['status']).toBeUndefined();

    // REQUIRED_MISSING is emitted but tolerated
    expect(result.validation.issues.some(i => i.code === 'REQUIRED_MISSING' && i.field === 'status')).toBe(true);

    // node_fields does NOT contain a 'status' row
    const field = db.prepare('SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(result.node_id, 'status');
    expect(field).toBeUndefined();
  });

  it('no-op: file + DB hash match → file_written is false', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'tool',
      file_path: 'doc.md',
      title: 'Doc',
    }));
    expect(created.file_written).toBe(true);

    // Call again with identical inputs via propagation: expect no-op
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'propagation',
      node_id: created.node_id,
      file_path: 'doc.md',
      title: 'Doc',
    }));

    expect(result.file_written).toBe(false);
    expect(result.edits_logged).toBe(0);
  });
});
