import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import { hybridSearch } from '../../src/search/search.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

function makeFakeEmbedder(): Embedder {
  return {
    async embedDocument(text: string): Promise<Float32Array[]> {
      const vec = new Float32Array(256).fill(0);
      const words = text.toLowerCase().split(/\s+/);
      for (let i = 0; i < Math.min(words.length, 256); i++) {
        vec[i] = words[i].length / 20;
      }
      let norm = 0;
      for (let i = 0; i < 256; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < 256; i++) vec[i] /= norm;
      return [vec];
    },
    async embedQuery(text: string): Promise<Float32Array> {
      const [vec] = await this.embedDocument(text);
      return vec;
    },
    isReady(): boolean { return true; },
  };
}

function insertNode(db: Database.Database, id: string, title: string, body: string, fields?: Array<{ name: string; value: string }>): void {
  db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)").run(id, `${id}.md`, title, body, `hash-${id}`);
  const rowid = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(id) as { rowid: number }).rowid;
  db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (?, ?, ?)').run(rowid, title, body);
  if (fields) {
    for (const f of fields) {
      db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, 'frontmatter')").run(id, f.name, f.value);
    }
  }
}

describe('Phase 4 end-to-end', () => {
  let db: Database.Database;
  let embedder: Embedder;

  beforeEach(async () => {
    db = createTestDb();
    embedder = makeFakeEmbedder();
    const indexer = createEmbeddingIndexer(db, embedder);

    insertNode(db, 'meeting-1', 'Q3 Pricing Meeting', 'Discussed pricing strategy and competitor analysis', [
      { name: 'project', value: 'Revenue Growth' },
    ]);
    insertNode(db, 'meeting-2', 'Sprint Retrospective', 'Team reviewed velocity and blockers');
    insertNode(db, 'note-1', 'Budget Forecast', 'The pricing model needs adjustment for inflation');
    insertNode(db, 'task-1', 'Fix Login Bug', 'Authentication fails on mobile devices');

    for (const id of ['meeting-1', 'meeting-2', 'note-1', 'task-1']) {
      indexer.enqueue({ node_id: id, source_type: 'node' });
    }
    await indexer.processAll();
  });

  it('finds pricing-related nodes via hybrid search', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    const ids = results.map(r => r.node_id);
    expect(ids).toContain('meeting-1');
    expect(ids).toContain('note-1');
  });

  it('filters candidates by node ID list', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {
      candidateIds: ['meeting-1', 'meeting-2'],
    });
    const ids = results.map(r => r.node_id);
    expect(ids).not.toContain('note-1');
  });

  it('all results have scores and match_sources', async () => {
    const results = await hybridSearch(db, embedder, 'sprint', {});
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(r.match_sources.length).toBeGreaterThan(0);
    }
  });

  it('results are sorted by score descending', async () => {
    const results = await hybridSearch(db, embedder, 'pricing', {});
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('embedding indexer reports correct status', () => {
    const indexer = createEmbeddingIndexer(db, embedder);
    const status = indexer.getStatus();
    expect(status.nodes_total).toBe(4);
    expect(status.nodes_indexed).toBe(4);
    expect(status.status).toBe('ready');
  });
});
