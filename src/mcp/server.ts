import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { WriteGate } from '../sync/write-gate.js';
import { registerAllTools } from './tools/index.js';

export interface ServerContext {
  db: Database.Database;
  writeLock?: WriteLockManager;
  writeGate?: WriteGate;
  vaultPath?: string;
}

export function createServer(db: Database.Database, ctx?: { writeLock?: WriteLockManager; writeGate?: WriteGate; vaultPath?: string }): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });
  registerAllTools(server, db, ctx);
  return server;
}
