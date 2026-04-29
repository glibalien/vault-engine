import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('global-field MCP undo', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerAllTools(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) });
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function readVault(relPath: string): string {
    return readFileSync(join(vaultPath, relPath), 'utf-8');
  }

  async function latestOperationId(sourceTool: string): Promise<string> {
    const history = payload(await callTool(server, 'list-undo-history', { source_tool: sourceTool }));
    expect(history.ok).toBe(true);
    expect(history.data.operations[0].global_field_count).toBe(1);
    return history.data.operations[0].operation_id;
  }

  async function undo(operationId: string): Promise<void> {
    const result = payload(await callTool(server, 'undo-operations', {
      operation_ids: [operationId],
      dry_run: false,
    }));
    expect(result.ok).toBe(true);
  }

  function seedStatusSchema(): void {
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed'],
      description: 'Original status',
    });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'status', sort_order: 1 }],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
  }

  function seedTaskNode(value: string, id = 'n1', filePath = 'task.md'): void {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: id,
      file_path: filePath,
      title: id,
      types: ['task'],
      fields: { status: value },
      body: 'Body',
    });
  }

  it('create-global-field undo removes the field and updates _fields.yaml', async () => {
    const create = payload(await callTool(server, 'create-global-field', {
      name: 'priority',
      field_type: 'string',
      description: 'Priority field',
    }));
    expect(create.ok).toBe(true);
    expect(readVault('.schemas/_fields.yaml')).toContain('priority');

    const opId = await latestOperationId('create-global-field');
    await undo(opId);

    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'priority'`).get()).toBeUndefined();
    const fieldsYaml = readVault('.schemas/_fields.yaml');
    expect(fieldsYaml).not.toContain('priority');
  });

  it('update-global-field undo restores _fields.yaml and affected schema YAML', async () => {
    seedStatusSchema();

    const update = payload(await callTool(server, 'update-global-field', {
      name: 'status',
      enum_values: ['open', 'done'],
      description: 'Updated status',
    }));
    expect(update.ok).toBe(true);
    expect(readVault('.schemas/_fields.yaml')).toContain('done');
    expect(readVault('.schemas/task.yaml')).toContain('done');

    const opId = await latestOperationId('update-global-field');
    await undo(opId);

    const fieldsYaml = readVault('.schemas/_fields.yaml');
    const schemaYaml = readVault('.schemas/task.yaml');
    expect(fieldsYaml).toContain('closed');
    expect(fieldsYaml).not.toContain('done');
    expect(schemaYaml).toContain('closed');
    expect(schemaYaml).not.toContain('done');
  });

  it('confirmed type-change undo restores deleted node_fields rows and node markdown', async () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [{ field: 'count', sort_order: 1 }],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n1',
      file_path: 'n1.md',
      title: 'n1',
      types: ['task'],
      fields: { count: '42' },
      body: '',
    });
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: 'n2',
      file_path: 'n2.md',
      title: 'n2',
      types: ['task'],
      fields: { count: 'not-a-number' },
      body: '',
    });

    const update = payload(await callTool(server, 'update-global-field', {
      name: 'count',
      field_type: 'number',
      confirm: true,
      discard_uncoercible: true,
    }));
    expect(update.ok).toBe(true);
    expect(db.prepare(`SELECT 1 FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`).get()).toBeUndefined();

    const opId = await latestOperationId('update-global-field');
    await undo(opId);

    const restored = db.prepare(`SELECT value_text FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`).get() as { value_text: string };
    expect(restored.value_text).toBe('not-a-number');
    expect(readVault('n1.md')).toContain('count: "42"');
    expect(readVault('n2.md')).toContain('count: not-a-number');
  });

  it('rename-global-field undo restores DB rows and rendered files', async () => {
    seedStatusSchema();
    seedTaskNode('open');

    const rename = payload(await callTool(server, 'rename-global-field', {
      old_name: 'status',
      new_name: 'state',
    }));
    expect(rename.ok).toBe(true);
    expect(readVault('task.md')).toContain('state: open');

    const opId = await latestOperationId('rename-global-field');
    await undo(opId);

    expect(db.prepare(`SELECT name FROM global_fields WHERE name = 'status'`).get()).toEqual({ name: 'status' });
    expect(db.prepare(`SELECT 1 FROM global_fields WHERE name = 'state'`).get()).toBeUndefined();
    expect(readVault('.schemas/_fields.yaml')).toContain('status');
    expect(readVault('.schemas/_fields.yaml')).not.toContain('state');
    expect(readVault('.schemas/task.yaml')).toContain('field: status');
    expect(readVault('task.md')).toContain('status: open');
    expect(readVault('task.md')).not.toContain('state: open');
  });

  it('delete-global-field undo restores field, claims, and rendered YAML', async () => {
    seedStatusSchema();
    seedTaskNode('open');

    const del = payload(await callTool(server, 'delete-global-field', { name: 'status' }));
    expect(del.ok).toBe(true);
    expect(readVault('.schemas/_fields.yaml')).not.toContain('status');
    expect(readVault('.schemas/task.yaml')).not.toContain('field: status');

    const opId = await latestOperationId('delete-global-field');
    await undo(opId);

    expect(db.prepare(`SELECT name FROM global_fields WHERE name = 'status'`).get()).toEqual({ name: 'status' });
    expect(db.prepare(`SELECT field FROM schema_field_claims WHERE schema_name = 'task' AND field = 'status'`).get()).toEqual({ field: 'status' });
    expect(readVault('.schemas/_fields.yaml')).toContain('status');
    expect(readVault('.schemas/task.yaml')).toContain('field: status');
    expect(readVault('task.md')).toContain('status: open');
  });
});
