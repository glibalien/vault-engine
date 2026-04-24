import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createHttpApp } from '../src/transport/http.js';
import { createServer } from '../src/mcp/server.js';
import { openDatabase } from '../src/db/connection.js';
import { createSchema } from '../src/db/schema.js';
import { addUndoTables } from '../src/db/migrate.js';
import { createAuthSchema } from '../src/auth/schema.js';

describe('HTTP OAuth discovery', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-auth-test-'));
    db = openDatabase(join(tmpDir, '.vault-engine', 'vault.db'));
    createSchema(db);
    addUndoTables(db);
    createAuthSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('advertises path-specific and legacy protected-resource metadata', async () => {
    const issuerUrl = new URL('https://vault.example.test');
    const app = createHttpApp(() => createServer(db), {
      db,
      ownerPassword: 'test-password',
      issuerUrl,
    });

    const unauthenticated = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toContain(
      'resource_metadata="https://vault.example.test/.well-known/oauth-protected-resource/mcp"',
    );

    const pathSpecific = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(pathSpecific.status).toBe(200);
    expect(pathSpecific.body).toMatchObject({
      resource: 'https://vault.example.test/mcp',
      authorization_servers: ['https://vault.example.test/'],
    });

    const legacy = await request(app).get('/.well-known/oauth-protected-resource');
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({
      resource: 'https://vault.example.test/',
      authorization_servers: ['https://vault.example.test/'],
    });
  });
});
