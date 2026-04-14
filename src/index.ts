import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/connection.js';
import { createSchema } from './db/schema.js';
import { upgradeToPhase2, upgradeToPhase3, upgradeToPhase4, upgradeToPhase6 } from './db/migrate.js';
import { createServer } from './mcp/server.js';
import { parseArgs } from './transport/args.js';
import { startHttpTransport } from './transport/http.js';
import { createAuthSchema } from './auth/schema.js';
import { validateAuthEnv } from './auth/env.js';
import { fullIndex } from './indexer/indexer.js';
import { setExcludeDirs } from './indexer/ignore.js';
import { startWatcher } from './sync/watcher.js';
import { startReconciler } from './sync/reconciler.js';
import { startNormalizer, runNormalizerSweep } from './sync/normalizer.js';
import { IndexMutex } from './sync/mutex.js';
import { WriteLockManager } from './sync/write-lock.js';
import { SyncLogger } from './sync/sync-logger.js';
import { startupSchemaRender } from './schema/render.js';
import { buildExtractorRegistry } from './extraction/setup.js';
import { ExtractionCache } from './extraction/cache.js';
import { ClaudeVisionPdfExtractor } from './extraction/extractors/claude-vision.js';
import { createEmbedder, type Embedder } from './search/embedder.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from './search/indexer.js';

const args = parseArgs(process.argv.slice(2));

const vaultPath = process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('VAULT_PATH environment variable is required');
  process.exit(1);
}

const dbPath = args.dbPath ?? process.env.DB_PATH ?? resolve(vaultPath, '.vault-engine', 'vault-new.db');
const db = openDatabase(dbPath);
createSchema(db);
upgradeToPhase2(db);
upgradeToPhase3(db);
upgradeToPhase4(db);
upgradeToPhase6(db);

const excludeDirs = (process.env.VAULT_EXCLUDE_DIRS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (excludeDirs.length > 0) {
  setExcludeDirs(excludeDirs);
  console.log(`Excluding directories: ${excludeDirs.join(', ')}`);
}

console.log(`Indexing vault at ${vaultPath}...`);
const indexStart = Date.now();
await fullIndex(vaultPath, db);
console.log(`Indexing complete in ${Date.now() - indexStart}ms`);

startupSchemaRender(db, vaultPath);

// --- One-shot normalize mode ---
if (args.normalize) {
  const writeLock = new WriteLockManager();
  const syncLogger = new SyncLogger(db);
  const stats = runNormalizerSweep(vaultPath, db, writeLock, syncLogger, {
    dryRun: args.dryRun,
  });
  db.close();
  process.exit(stats.errored > 0 ? 1 : 0);
}

// --- Phase 4: Embedding indexer ---
let embeddingIndexer: EmbeddingIndexer | undefined;
let embedderRef: Embedder | undefined;

const modelsDir = resolve(vaultPath, '.vault-engine', 'models');
console.log('Loading embedding model...');
try {
  const embedder = await createEmbedder({ modelsDir });
  embedderRef = embedder;
  embeddingIndexer = createEmbeddingIndexer(db, embedder);

  if (args.reindexSearch) {
    console.log('Reindex requested — clearing search index...');
    embeddingIndexer.clearAll();
  }

  const allNodes = db.prepare('SELECT id FROM nodes').all() as Array<{ id: string }>;
  for (const node of allNodes) {
    embeddingIndexer.enqueue({ node_id: node.id, source_type: 'node' });
  }

  const backgroundProcess = async () => {
    const count = await embeddingIndexer!.processAll();
    if (count > 0) {
      console.log(`Embedded ${count} items`);
    }
  };
  backgroundProcess().catch(err => console.error('Embedding error:', err instanceof Error ? err.message : err));

  console.log(`Embedding model loaded, ${allNodes.length} nodes queued`);
} catch (err) {
  console.error('Failed to load embedding model — search disabled:', err instanceof Error ? err.message : err);
}

const mutex = new IndexMutex();
const writeLock = new WriteLockManager();
const syncLogger = new SyncLogger(db);
const watcher = startWatcher(vaultPath, db, mutex, writeLock, syncLogger, embeddingIndexer);
const reconciler = startReconciler(vaultPath, db, mutex, writeLock, syncLogger);
const normalizer = startNormalizer(vaultPath, db, writeLock, syncLogger, {
  cronExpression: process.env.NORMALIZE_CRON ?? '',
  quiescenceMinutes: parseInt(process.env.NORMALIZE_QUIESCENCE_MINUTES ?? '60', 10) || 60,
});

const extractorRegistry = buildExtractorRegistry(process.env as Record<string, string | undefined>);
const extractionCache = new ExtractionCache(db, extractorRegistry);
if (process.env.ANTHROPIC_API_KEY) {
  extractionCache.setPdfFallback(new ClaudeVisionPdfExtractor(process.env.ANTHROPIC_API_KEY));
}

const serverFactory = () => createServer(db, { writeLock, syncLogger, vaultPath, extractorRegistry, extractionCache, embeddingIndexer, embedder: embedderRef });

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

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  reconciler.stop();
  normalizer.stop();
  await mutex.onIdle();
  await watcher.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
