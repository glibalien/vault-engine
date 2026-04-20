import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createTestDb } from '../helpers/db.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getHandler() {
  let capturedSchema: any;
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedSchema = schema;
      capturedHandler = (params: Record<string, unknown>) => {
        // Manually validate params with the captured zod schema
        // schema is an object where each property is a zod schema
        try {
          const paramsZodObject = z.object(schema as Record<string, any>);
          const validated = paramsZodObject.parse(params);
          return handler(validated);
        } catch (err: any) {
          if (err instanceof z.ZodError) {
            const firstIssue = err.issues?.[0];
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  error: { code: 'INVALID_PARAMS', message: firstIssue?.message || 'Validation error' },
                }),
              }],
            };
          }
          throw err;
        }
      };
    },
  } as unknown as McpServer;
  registerGetNode(fakeServer, db);
  return capturedHandler!;
}

function seedNode(id: string, filePath: string, title: string, body: string, mtime = 1000) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, mtime, 2000);
}

beforeEach(() => {
  db = createTestDb();
});

describe('get-node expand parameter — validation', () => {
  it('rejects empty types array', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: [] } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects max_nodes greater than 25', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'], max_nodes: 26 } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects max_nodes less than 1', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'], max_nodes: 0 } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects invalid direction', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'], direction: 'sideways' } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('accepts valid expand with defaults applied', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'] } }) as any);
    expect(env.ok).toBe(true);
    // expand fields may or may not exist yet; validation alone must pass.
  });

  it('leaves response unchanged when expand is omitted', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1' }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expanded).toBeUndefined();
    expect(env.data.expand_stats).toBeUndefined();
  });
});
