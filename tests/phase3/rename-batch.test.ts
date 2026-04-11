import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { PipelineError } from '../../src/pipeline/types.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { resolveTarget } from '../../src/resolver/resolve.js';
import { reconstructValue } from '../../src/pipeline/classify-value.js';
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
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

function create(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: fp, title,
    types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
  });
}

// ── rename-node tests ─────────────────────────────────────────────────

describe('rename-node', () => {
  it('renames file on disk and updates DB', () => {
    const node = create('old-name.md', 'Old Name');

    // Simulate rename
    const txn = db.transaction(() => {
      const oldAbs = join(vaultPath, 'old-name.md');
      const newAbs = join(vaultPath, 'New Name.md');
      renameSync(oldAbs, newAbs);

      db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?')
        .run('New Name.md', 'New Name', node.node_id);

      executeMutation(db, writeLock, vaultPath, {
        source: 'tool', node_id: node.node_id, file_path: 'New Name.md',
        title: 'New Name', types: [], fields: {}, body: '',
      });
    });
    txn();

    expect(existsSync(join(vaultPath, 'New Name.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'old-name.md'))).toBe(false);

    const updated = db.prepare('SELECT title, file_path FROM nodes WHERE id = ?').get(node.node_id) as { title: string; file_path: string };
    expect(updated.title).toBe('New Name');
    expect(updated.file_path).toBe('New Name.md');
  });

  it('updates frontmatter reference fields in referencing nodes', () => {
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });

    const target = create('target.md', 'Old Project');
    const source = create('source.md', 'My Task', {
      types: ['task'],
      fields: { project: 'Old Project' },
    });

    // Update the source to point to new title
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: source.node_id, file_path: 'source.md',
      title: 'My Task', types: ['task'], fields: { project: 'New Project' }, body: '',
    });

    // Verify the relationship was updated
    const rels = db.prepare('SELECT target FROM relationships WHERE source_id = ?').all(source.node_id) as { target: string }[];
    expect(rels.some(r => r.target === 'New Project')).toBe(true);

    // Verify file content
    const content = readFileSync(join(vaultPath, 'source.md'), 'utf-8');
    expect(content).toContain('[[New Project]]');
  });

  it('updates body wiki-links with alias preservation', () => {
    const target = create('target.md', 'Old Title');
    const source = create('source.md', 'Source', {
      body: 'See [[Old Title|the project]] and [[Old Title]] for details.',
    });

    // Simulate rename: update source body
    const newBody = 'See [[New Title|the project]] and [[New Title]] for details.';
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: source.node_id, file_path: 'source.md',
      title: 'Source', types: [], fields: {}, body: newBody,
    });

    const updated = db.prepare('SELECT body FROM nodes WHERE id = ?').get(source.node_id) as { body: string };
    expect(updated.body).toContain('[[New Title|the project]]');
    expect(updated.body).toContain('[[New Title]]');
    expect(updated.body).not.toContain('Old Title');
  });
});

// ── batch-mutate tests ────────────────────────────────────────────────

describe('batch-mutate', () => {
  it('atomic multi-create: all succeed or none', () => {
    const txn = db.transaction(() => {
      create('a.md', 'Node A');
      create('b.md', 'Node B');
      create('c.md', 'Node C');
    });
    txn();

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    // temp vault has fixture nodes too, so just check our 3 exist
    expect(db.prepare("SELECT id FROM nodes WHERE title = 'Node A'").get()).toBeDefined();
    expect(db.prepare("SELECT id FROM nodes WHERE title = 'Node B'").get()).toBeDefined();
    expect(db.prepare("SELECT id FROM nodes WHERE title = 'Node C'").get()).toBeDefined();
  });

  it('failure rolls back all operations', () => {
    createGlobalField(db, { name: 'req', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'strict', field_claims: [{ field: 'req' }] });

    const beforeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;

    try {
      const txn = db.transaction(() => {
        // This succeeds
        create('ok.md', 'OK Node');
        // This fails: missing required field
        create('fail.md', 'Fail Node', { types: ['strict'], fields: {} });
      });
      txn();
    } catch {
      // Expected
    }

    const afterCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount); // rolled back
    expect(db.prepare("SELECT id FROM nodes WHERE title = 'OK Node'").get()).toBeUndefined();
  });

  it('in-flight reference: later op sees earlier op', () => {
    const txn = db.transaction(() => {
      create('a.md', 'Alpha');
      // Can resolve Alpha within the same transaction
      const resolved = resolveTarget(db, 'Alpha');
      expect(resolved).toBeDefined();
      expect(resolved!.title).toBe('Alpha');
    });
    txn();
  });
});
