import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/connection.js';
import { createSchema } from './db/schema.js';
import { upgradeToPhase2, upgradeToPhase3 } from './db/migrate.js';
import { createServer } from './mcp/server.js';
import { parseArgs } from './transport/args.js';
import { startHttpTransport } from './transport/http.js';
import { createAuthSchema } from './auth/schema.js';
import { validateAuthEnv } from './auth/env.js';
import { fullIndex } from './indexer/indexer.js';
import { startWatcher } from './sync/watcher.js';
import { startReconciler } from './sync/reconciler.js';
import { IndexMutex } from './sync/mutex.js';
import { WriteLockManager } from './sync/write-lock.js';

const args = parseArgs(process.argv.slice(2));

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}

const dbPath = args.dbPath ?? process.env.DB_PATH ?? resolve(vaultPath, '.vault-engine', 'vault.db');
const db = openDatabase(dbPath);
createSchema(db);
upgradeToPhase2(db);
upgradeToPhase3(db);

console.log(`Indexing vault at ${vaultPath}...`);
const indexStart = Date.now();
await fullIndex(vaultPath, db);
console.log(`Indexing complete in ${Date.now() - indexStart}ms`);

const mutex = new IndexMutex();
const writeLock = new WriteLockManager();
const watcher = startWatcher(vaultPath, db, mutex, writeLock);
const reconciler = startReconciler(vaultPath, db, mutex);

const serverFactory = () => createServer(db, { writeLock, vaultPath });

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

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  reconciler.stop();
  await watcher.close();
  db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  reconciler.stop();
  await watcher.close();
  db.close();
  process.exit(0);
});
