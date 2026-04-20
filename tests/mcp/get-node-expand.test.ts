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
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, schema: unknown, handler: (...args: unknown[]) => unknown) => {
      // Unlike sibling MCP tests that just pass params through, we validate here via
      // z.object(schema).parse() because the MCP SDK's own validation layer is not
      // invoked by this fake server — and the validation tests below need it to run.
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
function seedRel(sourceId: string, target: string, relType: string) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
  ).run(sourceId, target, relType, null);
}
function seedType(nodeId: string, schemaType: string) {
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(nodeId, schemaType);
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

  it('accepts valid expand', async () => {
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

describe('get-node expand parameter — integration', () => {
  it('returns expanded map and stats when expand is provided', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('m1', 'notes/m1.md', 'M1', 'meeting 1', 2000);
    seedNode('m2', 'notes/m2.md', 'M2', 'meeting 2', 1000);
    seedType('m1', 'meeting');
    seedType('m2', 'meeting');
    seedRel('root', 'M1', 'wiki-link');
    seedRel('root', 'M2', 'wiki-link');

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['meeting'] } }) as any);
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data.expanded).sort()).toEqual(['m1', 'm2']);
    expect(env.data.expanded.m1.body).toBe('meeting 1');
    expect(env.data.expanded.m1.types).toEqual(['meeting']);
    expect(env.data.expand_stats).toEqual({ returned: 2, considered: 2, truncated: false });
  });

  it('truncation surfaces via expand_stats.truncated', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    for (let i = 0; i < 3; i++) {
      seedNode(`n${i}`, `notes/n${i}.md`, `N${i}`, `body ${i}`, 1000 + i);
      seedType(`n${i}`, 'note');
      seedRel('root', `N${i}`, 'wiki-link');
    }

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['note'], max_nodes: 2 } }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expand_stats).toEqual({ returned: 2, considered: 3, truncated: true });
  });

  it('direction=incoming surfaces backlinks', async () => {
    seedNode('proj', 'notes/Project.md', 'Project', 'project body');
    seedNode('note1', 'notes/note1.md', 'Note1', 'note about project', 1500);
    seedType('note1', 'note');
    seedRel('note1', 'Project', 'wiki-link');

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'proj', expand: { types: ['note'], direction: 'incoming' } }) as any);
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data.expanded)).toEqual(['note1']);
  });

  it('empty-match case returns zeroed stats and empty map', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('p', 'notes/p.md', 'P', 'person body');
    seedType('p', 'person');
    seedRel('root', 'P', 'wiki-link');

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['meeting'] } }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expanded).toEqual({});
    expect(env.data.expand_stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });

  it('root with zero relationships returns empty expansion, no error', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['note'] } }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expanded).toEqual({});
    expect(env.data.expand_stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});
