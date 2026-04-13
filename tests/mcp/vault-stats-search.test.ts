import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';

function makeFakeEmbedder(): Embedder {
  return {
    async embedDocument(): Promise<Float32Array> {
      return new Float32Array(256).fill(0.1);
    },
    async embedQuery(): Promise<Float32Array> {
      return new Float32Array(256).fill(0.1);
    },
    isReady(): boolean {
      return true;
    },
  };
}

describe('vault-stats search_index', () => {
  let db: Database.Database;
  let handler: () => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    db = createTestDb();
    const embedder = makeFakeEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'test.md', 'Test', 'Body', 'h1')").run();
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    let captured: () => Promise<{ content: Array<{ type: string; text: string }> }>;
    const fakeServer = {
      tool: (
        _name: string,
        _desc: string,
        _schema: unknown,
        h: () => Promise<{ content: Array<{ type: string; text: string }> }>
      ) => {
        captured = h;
      },
    };
    registerVaultStats(fakeServer as any, db, undefined, indexer);
    handler = captured!;
  });

  it('includes search_index in vault-stats output', async () => {
    const result = await handler();
    const data = JSON.parse(result.content[0].text);
    expect(data.search_index).toBeDefined();
    expect(data.search_index.status).toBe('ready');
    expect(data.search_index.nodes_total).toBe(1);
    expect(data.search_index.nodes_indexed).toBe(1);
    expect(data.search_index.pending).toBe(0);
  });

  it('omits search_index when no embeddingIndexer', async () => {
    let captured2: () => Promise<{ content: Array<{ type: string; text: string }> }>;
    const fakeServer2 = {
      tool: (
        _name: string,
        _desc: string,
        _schema: unknown,
        h: () => Promise<{ content: Array<{ type: string; text: string }> }>
      ) => {
        captured2 = h;
      },
    };
    registerVaultStats(fakeServer2 as any, db);
    const result = await captured2!();
    const data = JSON.parse(result.content[0].text);
    expect(data.search_index).toBeUndefined();
  });
});
