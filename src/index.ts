import { resolve, dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/connection.js';
import { createServer } from './mcp/server.js';
import { parseArgs } from './transport/args.js';
import { startHttpTransport } from './transport/http.js';
import { createAuthSchema } from './auth/schema.js';
import { validateAuthEnv } from './auth/env.js';

const args = parseArgs(process.argv.slice(2));
const dbPath = args.dbPath ?? resolve(process.cwd(), '.vault-engine', 'vault.db');

const db = openDatabase(dbPath);

const serverFactory = () => createServer(db);

if (args.transport === 'stdio' || args.transport === 'both') {
  const server = serverFactory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (args.transport === 'http' || args.transport === 'both') {
  const authEnv = validateAuthEnv(process.env.OAUTH_OWNER_PASSWORD, process.env.OAUTH_ISSUER_URL);
  createAuthSchema(db);
  await startHttpTransport(serverFactory, args.port, {
    db,
    ownerPassword: authEnv.ownerPassword,
    issuerUrl: authEnv.issuerUrl,
  });
}
