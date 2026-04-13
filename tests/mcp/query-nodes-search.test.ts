import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';

// Fake embedder with deterministic vectors
function createFakeEmbedder(): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array> {
      const arr = new Float32Array(256);
      const seed = text.length;
      for (let i = 0; i < 256; i++) {
        arr[i] = (seed % 100) / 100 + i * 0.001;
      }
      return arr;
    },
    async embedQuery(text: string): Promise<Float32Array> {
      const arr = new Float32Array(256);
      const seed = text.length;
      for (let i = 0; i < 256; i++) {
        arr[i] = (seed % 100) / 100 + i * 0.001;
      }
      return arr;
    },
    isReady(): boolean {
      return true;
    },
  };
}

function insertNode(
  db: Database.Database,
  id: string,
  title: string,
  body: string | null = null,
  types: string[] = [],
): void {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)',
  ).run(id, `/${id}.md`, title, body);

  db.prepare(
    'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)',
  ).run(id, title, body);

  for (const t of types) {
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, t);
  }
}

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

let db: Database.Database;
let indexer: EmbeddingIndexer;
let embedder: Embedder;
let handler: (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(idx?: EmbeddingIndexer, emb?: Embedder) {
  let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
      capturedHandler = h;
    },
  };
  registerQueryNodes(fakeServer as unknown as McpServer, db, idx, emb);
  return capturedHandler!;
}

beforeEach(async () => {
  db = createTestDb();
  embedder = createFakeEmbedder();
  indexer = createEmbeddingIndexer(db, embedder);
});

describe('query-nodes with query param (hybrid search)', () => {
  it('returns scored results when query is provided', async () => {
    insertNode(db, 'n1', 'Machine Learning Fundamentals', 'Introduction to neural networks');
    insertNode(db, 'n2', 'Gardening Tips', 'How to grow tomatoes');

    // Embed nodes
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning' });
    const parsed = parseResult(result);

    expect(Array.isArray(parsed.nodes)).toBe(true);
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(nodes.length).toBeGreaterThan(0);

    // n1 should be in results (FTS match on 'machine learning')
    const n1 = nodes.find(n => n.id === 'n1');
    expect(n1).toBeDefined();
    expect(typeof n1!.score).toBe('number');
    expect((n1!.score as number)).toBeGreaterThan(0);
    expect(Array.isArray(n1!.match_sources)).toBe(true);
  });

  it('falls back to standard query when no query param is provided', async () => {
    insertNode(db, 'n1', 'Alpha Node', null, ['article']);
    insertNode(db, 'n2', 'Beta Node', null, ['article']);
    insertNode(db, 'n3', 'Gamma Node', null, ['task']);

    handler = captureHandler(indexer, embedder);
    const result = await handler({ types: ['article'] });
    const parsed = parseResult(result);

    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    const ids = nodes.map(n => n.id).sort();
    expect(ids).toEqual(['n1', 'n2']);

    // No score fields in standard path
    expect(nodes[0].score).toBeUndefined();
  });

  it('combines query with type filter (structured pre-filter)', async () => {
    insertNode(db, 'n1', 'Machine Learning Article', 'Neural nets', ['article']);
    insertNode(db, 'n2', 'Machine Learning Task', 'Train model', ['task']);
    insertNode(db, 'n3', 'Gardening Article', 'Grow tomatoes', ['article']);

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    indexer.enqueue({ node_id: 'n3', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning', types: ['article'] });
    const parsed = parseResult(result);

    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    const ids = nodes.map(n => n.id);

    // n2 (task type) should be excluded by the type filter pre-filter
    expect(ids).not.toContain('n2');
    // n1 (article + machine learning match) should be present
    expect(ids).toContain('n1');
  });

  it('returns total reflecting number of search hits (not db total)', async () => {
    insertNode(db, 'n1', 'Machine Learning Deep', 'Neural net fundamentals');
    insertNode(db, 'n2', 'Unrelated Cooking', 'Recipes for pasta');

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    indexer.enqueue({ node_id: 'n2', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning' });
    const parsed = parseResult(result);

    // total should match how many search hits came back
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(typeof parsed.total).toBe('number');
    expect(parsed.total).toBe(nodes.length + (parsed.offset as number | undefined ?? 0));
  });

  it('falls back to standard path when embedder is not provided', async () => {
    insertNode(db, 'n1', 'Node One', null);
    insertNode(db, 'n2', 'Node Two', null);

    // Register without embedder
    handler = captureHandler(undefined, undefined);
    const result = await handler({ query: 'anything' });
    const parsed = parseResult(result);

    // Standard path — returns all nodes (no filter)
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(2);
    expect(nodes[0].score).toBeUndefined();
  });

  it('returns include_fields data in search path', async () => {
    insertNode(db, 'n1', 'Machine Learning Article', 'Deep learning content', ['article']);
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('n1', 'status', 'published', null, null, null, 'frontmatter');

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    handler = captureHandler(indexer, embedder);
    const result = await handler({ query: 'machine learning', include_fields: ['status'] });
    const parsed = parseResult(result);

    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    const n1 = nodes.find(n => n.id === 'n1');
    expect(n1).toBeDefined();
    expect(n1!.fields).toBeDefined();
    const fields = n1!.fields as Record<string, unknown>;
    expect(fields.status).toBe('published');
  });
});
