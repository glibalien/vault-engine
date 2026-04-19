import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { createTempVault } from '../helpers/vault.js';
import { checkTitleSafety, checkBodyFrontmatter } from '../../src/mcp/tools/title-warnings.js';

describe('checkTitleSafety', () => {
  it('returns no issues for clean titles', () => {
    expect(checkTitleSafety('My Normal Title')).toEqual([]);
  });

  it('flags parentheses', () => {
    const issues = checkTitleSafety('Something (with parens)');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('TITLE_WIKILINK_UNSAFE');
    expect(issues[0].characters).toContain('(');
    expect(issues[0].characters).toContain(')');
  });

  it('flags brackets', () => {
    const issues = checkTitleSafety('Has [brackets]');
    expect(issues[0].characters).toContain('[');
    expect(issues[0].characters).toContain(']');
  });

  it('flags pipe, hash, caret', () => {
    const issues = checkTitleSafety('A | B # C ^ D');
    expect(issues[0].characters).toEqual(expect.arrayContaining(['|', '#', '^']));
  });

  it('returns empty for titles with safe special chars like dashes and apostrophes', () => {
    expect(checkTitleSafety("It's a well-formed — title")).toEqual([]);
  });
});

describe('checkBodyFrontmatter', () => {
  it('returns no issue for normal body', () => {
    expect(checkBodyFrontmatter('Just some text')).toEqual([]);
  });

  it('returns no issue for empty body', () => {
    expect(checkBodyFrontmatter('')).toEqual([]);
  });

  it('flags body starting with frontmatter delimiter', () => {
    const issues = checkBodyFrontmatter('---\ntitle: oops\n---\nBody text');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('FRONTMATTER_IN_BODY');
  });

  it('does not flag horizontal rules mid-body', () => {
    expect(checkBodyFrontmatter('Some text\n\n---\n\nMore text')).toEqual([]);
  });
});

describe('rename-node surface tightening', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerRenameNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  function createNode(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: fp, title,
      types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
    });
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('rejects directory ending in .md', async () => {
    const node = createNode('Notes/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'new',
      directory: 'Notes/new.md',
    }));
    expect(result.code).toBe('INVALID_PARAMS');
    expect(result.error).toMatch(/directory.*must be a folder/i);
  });

  it('accepts directory param and derives file path from title', async () => {
    const node = createNode('Notes/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'Renamed',
      directory: 'Archive',
    }));
    expect(result.new_file_path).toBe('Archive/Renamed.md');
    expect(existsSync(join(vaultPath, 'Archive/Renamed.md'))).toBe(true);
  });

  it('defaults directory to schema default_directory when omitted', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const node = createNode('Tasks/old-task.md', 'old-task', { types: ['task'] });

    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'New Task',
    }));
    expect(result.new_file_path).toBe('Tasks/New Task.md');
  });

  it('keeps current directory when no schema and no directory param', async () => {
    const node = createNode('Somewhere/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'Renamed',
    }));
    expect(result.new_file_path).toBe('Somewhere/Renamed.md');
  });

  it('includes title safety warnings in response', async () => {
    const node = createNode('Notes/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'Something (with parens)',
    }));
    expect(result.new_file_path).toBe('Notes/Something (with parens).md');
    const issues = result.issues as Array<{ code: string }>;
    expect(issues.some(i => i.code === 'TITLE_WIKILINK_UNSAFE')).toBe(true);
  });
});

describe('create-node surface tightening', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerCreateNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('rejects directory ending in .md', async () => {
    const result = parseResult(await handler({
      title: 'Test',
      types: [],
      directory: 'Notes/test.md',
    })) as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PARAMS');
    expect(result.error.message).toMatch(/directory.*must be a folder/i);
  });

  it('uses schema default_directory when no directory param', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const result = parseResult(await handler({
      title: 'My Task',
      types: ['task'],
    })) as any;
    expect(result.ok).toBe(true);
    expect(result.data.file_path).toBe('Tasks/My Task.md');
  });

  it('rejects directory override when schema has default_directory and override flag is missing', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const result = parseResult(await handler({
      title: 'My Task',
      types: ['task'],
      directory: 'Elsewhere',
    })) as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PARAMS');
    expect(result.error.message).toMatch(/override_default_directory/);
  });

  it('allows directory override when override_default_directory is true', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const result = parseResult(await handler({
      title: 'My Task',
      types: ['task'],
      directory: 'Elsewhere',
      override_default_directory: true,
    })) as any;
    expect(result.ok).toBe(true);
    expect(result.data.file_path).toBe('Elsewhere/My Task.md');
  });

  it('allows directory on schema-less nodes without override flag', async () => {
    const result = parseResult(await handler({
      title: 'Loose Note',
      types: [],
      directory: 'Scratch',
    })) as any;
    expect(result.ok).toBe(true);
    expect(result.data.file_path).toBe('Scratch/Loose Note.md');
  });

  it('includes title safety warning in response', async () => {
    const result = parseResult(await handler({
      title: 'Something (bad)',
      types: [],
    })) as any;
    expect(result.ok).toBe(true);
    expect(result.data.file_path).toBe('Something (bad).md');
    const warnings = result.warnings as Array<{ code: string }>;
    expect(warnings.some(w => w.code === 'TITLE_WIKILINK_UNSAFE')).toBe(true);
  });

  it('includes frontmatter-in-body warning in response', async () => {
    const result = parseResult(await handler({
      title: 'Test Note',
      types: [],
      body: '---\ntitle: oops\n---\nContent',
    })) as any;
    expect(result.ok).toBe(true);
    expect(result.data.node_id).toBeDefined();
    const warnings = result.warnings as Array<{ code: string }>;
    expect(warnings.some(w => w.code === 'FRONTMATTER_IN_BODY')).toBe(true);
  });
});

describe('update-node set_title renames file', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerUpdateNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  function createNode(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: fp, title,
      types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
    });
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('set_title renames the file on disk', async () => {
    const node = createNode('Notes/Original.md', 'Original');
    const result = parseResult(await handler({
      node_id: node.node_id,
      set_title: 'Renamed',
    }));
    expect(result.file_path).toBe('Notes/Renamed.md');
    expect(existsSync(join(vaultPath, 'Notes/Renamed.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/Original.md'))).toBe(false);
  });

  it('set_title updates wiki-link references', async () => {
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });

    const target = createNode('Notes/Old Name.md', 'Old Name');
    createNode('Notes/Referencing.md', 'Referencing', {
      types: ['task'],
      fields: { project: 'Old Name' },
      body: 'See [[Old Name]] for details.',
    });

    await handler({
      node_id: target.node_id,
      set_title: 'New Name',
    });

    const refFields = db.prepare('SELECT value_text FROM node_fields WHERE node_id = (SELECT id FROM nodes WHERE title = ?) AND field_name = ?')
      .get('Referencing', 'project') as { value_text: string };
    expect(refFields.value_text).toBe('New Name');
  });

  it('set_title returns conflict error when target path exists', async () => {
    createNode('Notes/A.md', 'A');
    createNode('Notes/B.md', 'B');
    const result = parseResult(await handler({
      title: 'A',
      set_title: 'B',
    }));
    expect(result.code).toBe('CONFLICT');
  });

  it('set_title with same title is a no-op', async () => {
    const node = createNode('Notes/Same.md', 'Same');
    const result = parseResult(await handler({
      node_id: node.node_id,
      set_title: 'Same',
    }));
    expect(result.file_path).toBe('Notes/Same.md');
  });

  it('set_title includes title safety warnings', async () => {
    const node = createNode('Notes/Old.md', 'Old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      set_title: 'New (with parens)',
    }));
    expect(result.file_path).toBe('Notes/New (with parens).md');
    const issues = result.issues as Array<{ code: string }>;
    expect(issues.some(i => i.code === 'TITLE_WIKILINK_UNSAFE')).toBe(true);
  });
});

describe('update-node query mode set_directory', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerUpdateNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  function createNode(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: fp, title,
      types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
    });
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('rejects set_directory ending in .md', async () => {
    const result = parseResult(await handler({
      query: { types: ['task'] },
      set_directory: 'Archive/foo.md',
      dry_run: true,
    }));
    expect(result.code).toBe('INVALID_PARAMS');
    expect(result.error).toMatch(/directory.*must be a folder/i);
  });

  it('set_directory moves files in query mode', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode('Tasks/A.md', 'A', { types: ['task'] });

    const result = parseResult(await handler({
      query: { types: ['task'] },
      set_directory: 'Archive',
      dry_run: false,
      confirm_large_batch: true,
    }));
    expect(result.updated).toBe(1);
    expect(existsSync(join(vaultPath, 'Archive/A.md'))).toBe(true);
  });
});
