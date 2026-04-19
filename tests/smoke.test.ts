import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpApp } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/connection.js';
import { createSchema } from '../src/db/schema.js';
import { addUndoTables } from '../src/db/migrate.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import request from 'supertest';

function parseSseData(text: string): unknown {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error('No SSE data line found in response');
}

describe('Phase 0 smoke test', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
    const dbPath = join(tmpDir, '.vault-engine', 'vault.db');
    db = openDatabase(dbPath);
    createSchema(db);
    addUndoTables(db);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('vault-stats returns Phase 0 stub via MCP over HTTP', async () => {
    // No auth config — smoke test validates the MCP tool, not the OAuth layer
    const app = createHttpApp(() => createServer(db));

    const mcpHeaders = {
      Accept: 'application/json, text/event-stream',
    };

    // Initialize a session
    const initRes = await request(app)
      .post('/mcp')
      .set(mcpHeaders)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    // Call vault-stats
    const toolRes = await request(app)
      .post('/mcp')
      .set('mcp-session-id', sessionId)
      .set(mcpHeaders)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'vault-stats', arguments: {} },
      });

    expect(toolRes.status).toBe(200);

    // Response is SSE — parse the data line
    const body = parseSseData(toolRes.text) as { result: { content: Array<{ type: string; text: string }> } };
    const content = body.result.content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');

    const envelope = JSON.parse(content[0].text);
    expect(envelope.ok).toBe(true);
    const parsed = envelope.data;
    expect(parsed.node_count).toBe(0);
    expect(parsed.type_counts).toEqual([]);
    expect(parsed.schema_count).toBe(0);
  });

  it('.vault-engine/ directory is created by openDatabase', () => {
    const vaultEngineDir = join(tmpDir, '.vault-engine');
    const { existsSync } = require('node:fs');
    expect(existsSync(vaultEngineDir)).toBe(true);
    expect(existsSync(join(vaultEngineDir, 'vault.db'))).toBe(true);
  });
});
