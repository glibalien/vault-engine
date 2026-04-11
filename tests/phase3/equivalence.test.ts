import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { reconstructValue } from '../../src/pipeline/classify-value.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

// Two parallel DBs: one for tool path, one for watcher path
let dbTool: Database.Database;
let dbWatcher: Database.Database;

function setupSchema(db: Database.Database) {
  createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open' });
  createGlobalField(db, { name: 'count', field_type: 'number' });
  createSchemaDefinition(db, { name: 'task', field_claims: [
    { field: 'status', sort_order: 100 },
    { field: 'count', sort_order: 200 },
  ] });
}

function getDbState(db: Database.Database, nodeId: string) {
  const node = db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(nodeId) as { title: string; body: string };
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type')
    .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);
  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ? ORDER BY field_name')
    .all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  const fields: Record<string, unknown> = {};
  for (const row of fieldRows) fields[row.field_name] = reconstructValue(row);
  return { title: node.title, body: node.body, types, fields };
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();

  dbTool = new Database(':memory:');
  dbTool.pragma('journal_mode = WAL');
  dbTool.pragma('foreign_keys = ON');
  createSchema(dbTool);
  setupSchema(dbTool);

  dbWatcher = new Database(':memory:');
  dbWatcher.pragma('journal_mode = WAL');
  dbWatcher.pragma('foreign_keys = ON');
  createSchema(dbWatcher);
  setupSchema(dbWatcher);
});

afterEach(() => {
  dbTool.close();
  dbWatcher.close();
  cleanup();
});

describe('pipeline entry-point equivalence', () => {
  it('create equivalence: tool vs watcher produce identical DB state', () => {
    // Tool path
    const toolResult = executeMutation(dbTool, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'equiv-tool.md',
      title: 'Equiv Test',
      types: ['task'],
      fields: { count: 5 },
      body: 'Test body.',
    });

    // Watcher path: write the equivalent file and process it
    const watcherResult = executeMutation(dbWatcher, writeLock, vaultPath, {
      source: 'watcher',
      node_id: null,
      file_path: 'equiv-watcher.md',
      title: 'Equiv Test',
      types: ['task'],
      fields: { count: 5 },
      body: 'Test body.',
    });

    const toolState = getDbState(dbTool, toolResult.node_id);
    const watcherState = getDbState(dbWatcher, watcherResult.node_id);

    expect(watcherState.title).toBe(toolState.title);
    expect(watcherState.types).toEqual(toolState.types);
    expect(watcherState.fields).toEqual(toolState.fields);
    expect(watcherState.body).toBe(toolState.body);
  });

  it('update equivalence: tool and watcher produce same field state', () => {
    // Create identical nodes in both DBs
    const toolNode = executeMutation(dbTool, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'upd-tool.md',
      title: 'Update Test', types: ['task'], fields: { status: 'open', count: 1 }, body: '',
    });
    const watcherNode = executeMutation(dbWatcher, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'upd-watcher.md',
      title: 'Update Test', types: ['task'], fields: { status: 'open', count: 1 }, body: '',
    });

    // Update via tool
    executeMutation(dbTool, writeLock, vaultPath, {
      source: 'tool', node_id: toolNode.node_id, file_path: 'upd-tool.md',
      title: 'Update Test', types: ['task'], fields: { status: 'closed', count: 2 }, body: '',
    });

    // Update via watcher (simulating file edit)
    writeFileSync(join(vaultPath, 'upd-watcher.md'),
      '---\ntitle: Update Test\ntypes:\n  - task\nstatus: closed\ncount: 2\n---\n');
    executeMutation(dbWatcher, writeLock, vaultPath, {
      source: 'watcher', node_id: watcherNode.node_id, file_path: 'upd-watcher.md',
      title: 'Update Test', types: ['task'], fields: { status: 'closed', count: 2 }, body: '',
    });

    const toolState = getDbState(dbTool, toolNode.node_id);
    const watcherState = getDbState(dbWatcher, watcherNode.node_id);

    expect(watcherState.fields).toEqual(toolState.fields);
  });

  it('body change equivalence', () => {
    const toolNode = executeMutation(dbTool, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'body-tool.md',
      title: 'Body Test', types: [], fields: {}, body: 'Original.',
    });
    const watcherNode = executeMutation(dbWatcher, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'body-watcher.md',
      title: 'Body Test', types: [], fields: {}, body: 'Original.',
    });

    // Tool update
    executeMutation(dbTool, writeLock, vaultPath, {
      source: 'tool', node_id: toolNode.node_id, file_path: 'body-tool.md',
      title: 'Body Test', types: [], fields: {}, body: 'Updated body content.\n',
    });

    // Watcher update
    executeMutation(dbWatcher, writeLock, vaultPath, {
      source: 'watcher', node_id: watcherNode.node_id, file_path: 'body-watcher.md',
      title: 'Body Test', types: [], fields: {}, body: 'Updated body content.\n',
    });

    expect(getDbState(dbTool, toolNode.node_id).body).toBe(getDbState(dbWatcher, watcherNode.node_id).body);
  });
});
