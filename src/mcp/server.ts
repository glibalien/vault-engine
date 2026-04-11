import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerAllTools } from './tools/index.js';

export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });
  registerAllTools(server, db);
  return server;
}
