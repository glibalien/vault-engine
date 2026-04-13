import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerQuerySyncLog } from '../../src/mcp/tools/query-sync-log.js';

let db: Database.Database;

function getToolHandler(registerFn: (server: McpServer, db: Database.Database) => void) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db);
  return capturedHandler!;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function insertRow(filePath: string, event: string, source: string, details: Record<string, unknown>, timestamp?: number): void {
  db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
    .run(timestamp ?? Date.now(), filePath, event, source, JSON.stringify(details));
}

async function callTool(params: Record<string, unknown>): Promise<any> {
  const handler = getToolHandler(registerQuerySyncLog);
  return parseResult(await handler(params) as any) as any;
}

describe('query-sync-log tool', () => {
  it('returns all events for a file', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', { hash: 'abc', size: 100 });
    insertRow('note.md', 'deferred-write-scheduled', 'watcher', {});
    insertRow('other.md', 'watcher-event', 'watcher', { hash: 'xyz', size: 200 });

    const data = await callTool({ file_path: 'note.md' });
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].event).toBe('watcher-event');
    expect(data.rows[1].event).toBe('deferred-write-scheduled');
  });

  it('filters by event type', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {});
    insertRow('note.md', 'file-written', 'tool', { hash: 'abc' });

    const data = await callTool({ file_path: 'note.md', events: ['file-written'] });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].event).toBe('file-written');
  });

  it('filters by source', async () => {
    insertRow('note.md', 'file-written', 'tool', {});
    insertRow('note.md', 'watcher-event', 'watcher', {});

    const data = await callTool({ file_path: 'note.md', source: 'tool' });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].source).toBe('tool');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      insertRow('note.md', 'watcher-event', 'watcher', {});
    }

    const data = await callTool({ file_path: 'note.md', limit: 3 });
    expect(data.rows).toHaveLength(3);
    expect(data.truncated).toBe(true);
  });

  it('supports desc sort order', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {}, 1000);
    insertRow('note.md', 'file-written', 'tool', {}, 2000);

    const data = await callTool({ file_path: 'note.md', sort_order: 'desc' });
    expect(data.rows[0].event).toBe('file-written');
    expect(data.rows[1].event).toBe('watcher-event');
  });

  it('filters by since with relative time', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {}, Date.now() - 7200_000);
    insertRow('note.md', 'file-written', 'tool', {}, Date.now() - 1800_000);

    const data = await callTool({ file_path: 'note.md', since: '1h' });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].event).toBe('file-written');
  });

  it('returns all files when no file_path specified', async () => {
    insertRow('a.md', 'watcher-event', 'watcher', {});
    insertRow('b.md', 'file-written', 'tool', {});

    const data = await callTool({});
    expect(data.rows).toHaveLength(2);
  });

  it('parses details JSON in results', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', { hash: 'abc123', size: 1024 });

    const data = await callTool({ file_path: 'note.md' });
    expect(data.rows[0].details).toEqual({ hash: 'abc123', size: 1024 });
  });

  it('returns count and truncated flag', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {});
    insertRow('note.md', 'file-written', 'tool', {});

    const data = await callTool({ file_path: 'note.md' });
    expect(data.count).toBe(2);
    expect(data.truncated).toBe(false);
  });

  it('includes time as ISO string', async () => {
    insertRow('note.md', 'watcher-event', 'watcher', {}, 1000000);

    const data = await callTool({ file_path: 'note.md' });
    expect(data.rows[0].time).toBe(new Date(1000000).toISOString());
    expect(data.rows[0].timestamp).toBe(1000000);
  });
});
