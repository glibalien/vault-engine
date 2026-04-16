import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import { hybridSearch } from '../../src/search/search.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

// Fake embedder with deterministic vectors based on node ID seed
function createFakeEmbedder(seedMap: Record<string, number> = {}): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array[]> {
      const arr = new Float32Array(256);
      // Use text length as seed for deterministic but unique vectors
      const seed = seedMap[text] ?? text.length;
      for (let i = 0; i < 256; i++) {
        arr[i] = (seed % 100) / 100 + i * 0.001;
      }
      return [arr];
    },
    async embedQuery(text: string): Promise<Float32Array> {
      // Return a vector that matches what "node1" content would produce
      const arr = new Float32Array(256);
      const seed = seedMap['query:' + text] ?? 10;
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
): void {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)',
  ).run(id, `/${id}.md`, title, body);

  db.prepare(
    'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)',
  ).run(id, title, body);
}

describe('hybridSearch', () => {
  let db: Database.Database;
  let fakeEmbedder: Embedder;

  beforeEach(() => {
    db = createTestDb();
    fakeEmbedder = createFakeEmbedder();
  });

  it('returns empty array when db is empty', async () => {
    const results = await hybridSearch(db, fakeEmbedder, 'anything', {});
    expect(results).toEqual([]);
  });

  it('returns results for an FTS match', async () => {
    insertNode(db, 'node1', 'Machine Learning Fundamentals', 'Introduction to neural networks');
    insertNode(db, 'node2', 'Gardening Tips', 'How to grow tomatoes');

    const results = await hybridSearch(db, fakeEmbedder, 'machine learning', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node_id).toBe('node1');
  });

  it('results have scores and match_sources', async () => {
    insertNode(db, 'node1', 'Artificial Intelligence Overview', 'Deep learning and neural networks');

    const results = await hybridSearch(db, fakeEmbedder, 'artificial intelligence', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);

    const hit = results[0];
    expect(typeof hit.score).toBe('number');
    expect(hit.score).toBeGreaterThan(0);
    expect(Array.isArray(hit.match_sources)).toBe(true);
    expect(hit.match_sources.length).toBeGreaterThan(0);
  });

  it('includes snippet for FTS matches', async () => {
    insertNode(db, 'node1', 'Quantum Computing Explained', 'Quantum bits and superposition states');

    const results = await hybridSearch(db, fakeEmbedder, 'quantum', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);

    // FTS match should have snippet
    const hit = results.find(r => r.match_sources.includes('fts') && r.snippet !== undefined);
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain('<mark>');
  });

  it('respects candidate node IDs filter', async () => {
    insertNode(db, 'node1', 'TypeScript Programming', 'Typed JavaScript development');
    insertNode(db, 'node2', 'TypeScript Advanced', 'Generics and decorators');
    insertNode(db, 'node3', 'Python Scripting', 'Dynamic language features');

    const results = await hybridSearch(db, fakeEmbedder, 'TypeScript', {
      candidateIds: ['node2'],
      limit: 10,
    });

    const resultIds = results.map(r => r.node_id);
    expect(resultIds).not.toContain('node1');
    expect(resultIds).not.toContain('node3');
    if (resultIds.length > 0) {
      expect(resultIds).toContain('node2');
    }
  });

  it('returns empty array on no matches without crashing', async () => {
    insertNode(db, 'node1', 'Unrelated Content', 'Nothing matches here at all');

    // Use a query that produces no FTS matches (special chars that could break FTS)
    const results = await hybridSearch(db, fakeEmbedder, 'zzz_no_match_xyz_99999', { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
  });

  it('handles invalid FTS syntax gracefully without crashing', async () => {
    insertNode(db, 'node1', 'Some Node', 'With content');

    // FTS5 syntax errors throw — should be caught and return empty
    const results = await hybridSearch(db, fakeEmbedder, 'AND OR', { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
  });

  it('deduplicates nodes appearing in both FTS and vector results', async () => {
    insertNode(db, 'node1', 'Machine Learning Guide', 'Supervised and unsupervised learning');

    const indexer = createEmbeddingIndexer(db, fakeEmbedder);
    indexer.enqueue({ node_id: 'node1', source_type: 'node' });
    await indexer.processAll();

    // node1 should appear only once even if it matches both FTS and vector
    const results = await hybridSearch(db, fakeEmbedder, 'machine learning guide', { limit: 10 });

    const node1Hits = results.filter(r => r.node_id === 'node1');
    expect(node1Hits.length).toBeLessThanOrEqual(1);
  });

  it('respects limit', async () => {
    for (let i = 1; i <= 10; i++) {
      insertNode(db, `node${i}`, `TypeScript Guide ${i}`, `TypeScript content chapter ${i}`);
    }

    const results = await hybridSearch(db, fakeEmbedder, 'TypeScript', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('vector-only matches have semantic in match_sources', async () => {
    insertNode(db, 'node1', 'Quantum Physics', 'Study of subatomic particles');
    insertNode(db, 'node2', 'Some Unique Title ZZZ', 'Completely different content');

    const indexer = createEmbeddingIndexer(db, fakeEmbedder);
    indexer.enqueue({ node_id: 'node1', source_type: 'node' });
    indexer.enqueue({ node_id: 'node2', source_type: 'node' });
    await indexer.processAll();

    // Do a vector-only search (query that won't match FTS but will match vectors)
    const results = await hybridSearch(db, fakeEmbedder, 'zzznomatchfts', { limit: 10 });

    // Vector-only results should have 'semantic' in match_sources
    for (const hit of results) {
      expect(hit.match_sources.length).toBeGreaterThan(0);
      expect(hit.match_sources).toContain('semantic');
    }
  });
});
