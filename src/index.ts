// vault-engine entry point
import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, createSchema } from './db/index.js';
import { createServer } from './mcp/server.js';
import { loadSchemas } from './schema/index.js';
import { loadVecExtension, createVecTable, getVecDimensions, dropVecTable, createProvider, startEmbeddingWorker } from './embeddings/index.js';
import type { EmbeddingConfig } from './embeddings/types.js';

const dbPath = process.argv[2] ?? resolve(process.cwd(), '.vault-engine', 'vault.db');
const vaultPath = process.argv[3] ?? resolve(dirname(dbPath), '..');

const db = openDatabase(dbPath);
createSchema(db);
loadSchemas(db, vaultPath);

// Load embedding config from .vault-engine/config.json if it exists
let embeddingConfig: EmbeddingConfig | undefined;
const configPath = join(dirname(dbPath), 'config.json');
if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.embeddings) {
      embeddingConfig = config.embeddings as EmbeddingConfig;
    }
  } catch {
    console.error('[vault-engine] failed to read config.json');
  }
}

// Set up sqlite-vec and embedding worker if configured
if (embeddingConfig) {
  loadVecExtension(db);
  const provider = createProvider(embeddingConfig);

  // Handle dimension mismatch
  const existingDims = getVecDimensions(db);
  if (existingDims !== null && existingDims !== provider.dimensions) {
    console.error(`[vault-engine] embedding dimensions changed (${existingDims} → ${provider.dimensions}), rebuilding vec table`);
    dropVecTable(db);
    // Re-queue all chunks
    db.transaction(() => {
      db.prepare('DELETE FROM embedding_queue').run();
      const chunks = db.prepare('SELECT id FROM chunks').all() as Array<{ id: string }>;
      const insertQueue = db.prepare('INSERT INTO embedding_queue (chunk_id) VALUES (?)');
      for (const chunk of chunks) {
        insertQueue.run(chunk.id);
      }
    })();
  }

  createVecTable(db, provider.dimensions);
  startEmbeddingWorker(db, provider, { batchSize: embeddingConfig.batchSize });
}

const server = createServer(db, vaultPath, embeddingConfig ? { embeddingConfig } : undefined);
const transport = new StdioServerTransport();
await server.connect(transport);
