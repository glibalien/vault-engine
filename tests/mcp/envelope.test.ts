import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerListTypes } from '../../src/mcp/tools/list-types.js';
import { registerListSchemas } from '../../src/mcp/tools/list-schemas.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity: 'error' | 'warning' }>;
}

function parse(result: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(result.content[0].text) as Envelope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureHandler(registerFn: (server: McpServer, ...args: any[]) => void, ...extras: unknown[]) {
  let captured: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      captured = (args) => handler(args);
    },
    registerTool: (_name: string, _config: unknown, handler: (...a: unknown[]) => unknown) => {
      captured = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, ...extras);
  return captured!;
}

function assertEnvelope(env: Envelope): void {
  expect(env).toHaveProperty('ok');
  expect(typeof env.ok).toBe('boolean');
  expect(Array.isArray(env.warnings)).toBe(true);
  if (env.ok) {
    expect(env).toHaveProperty('data');
    expect(env).not.toHaveProperty('error');
  } else {
    expect(env).toHaveProperty('error');
    expect(env).not.toHaveProperty('data');
    expect(typeof env.error?.code).toBe('string');
    expect(typeof env.error?.message).toBe('string');
  }
  for (const w of env.warnings) {
    expect(typeof w.code).toBe('string');
    expect(typeof w.message).toBe('string');
    expect(['error', 'warning']).toContain(w.severity);
  }
}

describe('envelope invariant', () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'envelope-test-'));
    db = createTestDb();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('list-types returns a valid success envelope', async () => {
    const handler = captureHandler(registerListTypes, db);
    const env = parse(await handler({}) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(true);
  });

  it('list-schemas returns a valid success envelope', async () => {
    const handler = captureHandler(registerListSchemas, db);
    const env = parse(await handler({}) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(true);
  });

  it('vault-stats returns a valid success envelope', async () => {
    const handler = captureHandler(registerVaultStats, db);
    const env = parse(await handler({}) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(true);
  });

  it('get-node returns a valid failure envelope on missing node', async () => {
    const handler = captureHandler(registerGetNode, db);
    const env = parse(await handler({ node_id: 'does-not-exist' }) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('NOT_FOUND');
  });

  it('create-node returns a valid failure envelope with UNKNOWN_TYPE details', async () => {
    const writeLock = new WriteLockManager();
    const handler = captureHandler(registerCreateNode, db, writeLock, tmp);
    const env = parse(await handler({ title: 'x', types: ['NoSuchType'] }) as any);
    assertEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('UNKNOWN_TYPE');
    expect(env.error?.details).toHaveProperty('unknown_types');
    expect(env.error?.details).toHaveProperty('available_schemas');
  });
});
