import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '../helpers/db.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type Database from 'better-sqlite3';

// Fake embedder that tracks calls and returns deterministic vectors
function createFakeEmbedder(): Embedder & { callCount: number; lastText: string | null } {
  let callCount = 0;
  let lastText: string | null = null;

  return {
    get callCount() { return callCount; },
    get lastText() { return lastText; },
    async embedDocument(text: string): Promise<Float32Array[]> {
      callCount++;
      lastText = text;
      // Return deterministic vector based on text length
      const arr = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        arr[i] = (text.length % 100) / 100 + i * 0.001;
      }
      return [arr];
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return new Float32Array(256).fill(0.5);
    },
    isReady(): boolean {
      return true;
    },
  };
}

function createMultiChunkEmbedder(chunkCount: number): Embedder & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async embedDocument(text: string): Promise<Float32Array[]> {
      callCount++;
      return Array.from({ length: chunkCount }, (_, i) => {
        const arr = new Float32Array(256);
        for (let j = 0; j < 256; j++) {
          arr[j] = (i * 0.01) + j * 0.001;
        }
        return arr;
      });
    },
    async embedQuery(): Promise<Float32Array> { return new Float32Array(256).fill(0.5); },
    isReady(): boolean { return true; },
  };
}

function insertNode(
  db: Database.Database,
  id: string,
  title: string,
  body: string | null = null
): void {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)'
  ).run(id, `/${id}.md`, title, body);

  // Insert into FTS
  db.prepare(
    'INSERT INTO nodes_fts (rowid, title, body) VALUES ((SELECT rowid FROM nodes WHERE id = ?), ?, ?)'
  ).run(id, title, body);
}

function insertStringField(
  db: Database.Database,
  nodeId: string,
  fieldName: string,
  value: string
): void {
  db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)'
  ).run(nodeId, fieldName, value);
}

describe('EmbeddingIndexer', () => {
  let db: Database.Database;
  let fakeEmbedder: ReturnType<typeof createFakeEmbedder>;
  let indexer: EmbeddingIndexer;

  beforeEach(() => {
    db = createTestDb();
    fakeEmbedder = createFakeEmbedder();
    indexer = createEmbeddingIndexer(db, fakeEmbedder);
  });

  describe('assembleContent', () => {
    it('returns title only when no body or fields', () => {
      insertNode(db, 'n1', 'My Title');
      const content = indexer.assembleContent('n1');
      expect(content).toBe('My Title');
    });

    it('returns title + body joined with double newline', () => {
      insertNode(db, 'n1', 'My Title', 'Body text here');
      const content = indexer.assembleContent('n1');
      expect(content).toBe('My Title\n\nBody text here');
    });

    it('includes string field values', () => {
      insertNode(db, 'n1', 'My Title', 'Body text');
      insertStringField(db, 'n1', 'description', 'A description');
      insertStringField(db, 'n1', 'summary', 'A summary');
      const content = indexer.assembleContent('n1');
      expect(content).toContain('My Title');
      expect(content).toContain('Body text');
      expect(content).toContain('A description');
      expect(content).toContain('A summary');
    });

    it('filters out null value_text fields', () => {
      insertNode(db, 'n1', 'My Title');
      // Insert a field with only value_number (no value_text)
      db.prepare(
        'INSERT INTO node_fields (node_id, field_name, value_number) VALUES (?, ?, ?)'
      ).run('n1', 'count', 42);
      const content = indexer.assembleContent('n1');
      expect(content).toBe('My Title');
    });
  });

  describe('contentHash', () => {
    it('returns a SHA-256 hex string', () => {
      insertNode(db, 'n1', 'Hello');
      const hash = indexer.contentHash('n1');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when content changes', () => {
      insertNode(db, 'n1', 'Hello');
      const hash1 = indexer.contentHash('n1');

      db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('Hello Changed', 'n1');
      const hash2 = indexer.contentHash('n1');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('enqueue', () => {
    it('increases queue size', () => {
      insertNode(db, 'n1', 'Node 1');
      expect(indexer.queueSize()).toBe(0);
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      expect(indexer.queueSize()).toBe(1);
    });

    it('deduplicates identical items', () => {
      insertNode(db, 'n1', 'Node 1');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      expect(indexer.queueSize()).toBe(1);
    });

    it('allows same node with different source_type', () => {
      insertNode(db, 'n1', 'Node 1');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      indexer.enqueue({ node_id: 'n1', source_type: 'extraction', extraction_ref: 'ref-1' });
      expect(indexer.queueSize()).toBe(2);
    });
  });

  describe('processOne', () => {
    it('returns false when queue is empty', async () => {
      const result = await indexer.processOne();
      expect(result).toBe(false);
    });

    it('returns true and embeds a node', async () => {
      insertNode(db, 'n1', 'Hello World', 'Some body text');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });

      const result = await indexer.processOne();

      expect(result).toBe(true);
      expect(fakeEmbedder.callCount).toBe(1);
      expect(indexer.queueSize()).toBe(0);
    });

    it('writes to embedding_meta and embedding_vec', async () => {
      insertNode(db, 'n1', 'Hello World', 'Some body text');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      const meta = db.prepare(
        "SELECT * FROM embedding_meta WHERE node_id = 'n1'"
      ).get() as { id: number; source_hash: string; source_type: string } | undefined;
      expect(meta).toBeDefined();
      expect(meta!.source_type).toBe('node');

      const vec = db.prepare(
        'SELECT id FROM embedding_vec WHERE id = ?'
      ).get(meta!.id) as { id: number } | undefined;
      expect(vec).toBeDefined();
    });

    it('skips re-embedding when source_hash matches', async () => {
      insertNode(db, 'n1', 'Hello World');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      expect(fakeEmbedder.callCount).toBe(1);

      // Queue again (same content)
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      // Should not have called embedder again
      expect(fakeEmbedder.callCount).toBe(1);
    });

    it('re-embeds when content changes', async () => {
      insertNode(db, 'n1', 'Hello World');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();
      expect(fakeEmbedder.callCount).toBe(1);

      // Change content
      db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('New Title', 'n1');

      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      expect(fakeEmbedder.callCount).toBe(2);
    });

    it('updates existing meta row when content changes', async () => {
      insertNode(db, 'n1', 'Hello World');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      const meta1 = db.prepare(
        "SELECT source_hash FROM embedding_meta WHERE node_id = 'n1'"
      ).get() as { source_hash: string };
      const hash1 = meta1.source_hash;

      db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('Changed Title', 'n1');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      const meta2 = db.prepare(
        "SELECT source_hash FROM embedding_meta WHERE node_id = 'n1'"
      ).get() as { source_hash: string };
      expect(meta2.source_hash).not.toBe(hash1);

      // Should still be only one row
      const count = db.prepare(
        "SELECT COUNT(*) as cnt FROM embedding_meta WHERE node_id = 'n1'"
      ).get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe('processAll', () => {
    it('drains the queue and returns count', async () => {
      insertNode(db, 'n1', 'Node 1');
      insertNode(db, 'n2', 'Node 2');
      insertNode(db, 'n3', 'Node 3');

      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      indexer.enqueue({ node_id: 'n2', source_type: 'node' });
      indexer.enqueue({ node_id: 'n3', source_type: 'node' });

      const count = await indexer.processAll();

      expect(count).toBe(3);
      expect(indexer.queueSize()).toBe(0);
      expect(fakeEmbedder.callCount).toBe(3);
    });
  });

  describe('getStatus', () => {
    it('returns zero counts for empty db', () => {
      const status = indexer.getStatus();
      expect(status.nodes_total).toBe(0);
      expect(status.nodes_indexed).toBe(0);
      expect(status.pending).toBe(0);
    });

    it('reports correct node counts after indexing', async () => {
      insertNode(db, 'n1', 'Node 1');
      insertNode(db, 'n2', 'Node 2');

      const statusBefore = indexer.getStatus();
      expect(statusBefore.nodes_total).toBe(2);
      expect(statusBefore.nodes_indexed).toBe(0);

      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      indexer.enqueue({ node_id: 'n2', source_type: 'node' });

      const statusQueued = indexer.getStatus();
      expect(statusQueued.pending).toBe(2);

      await indexer.processAll();

      const statusAfter = indexer.getStatus();
      expect(statusAfter.nodes_total).toBe(2);
      expect(statusAfter.nodes_indexed).toBe(2);
      expect(statusAfter.pending).toBe(0);
    });

    it('reports extraction_cache presence', () => {
      const status = indexer.getStatus();
      // extraction_cache table exists in schema
      expect(typeof status.extractions_total).toBe('number');
    });
  });

  describe('removeNode', () => {
    it('removes embedding_meta and embedding_vec rows', async () => {
      insertNode(db, 'n1', 'Hello World');
      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      await indexer.processOne();

      // Verify row exists
      const meta = db.prepare(
        "SELECT id FROM embedding_meta WHERE node_id = 'n1'"
      ).get() as { id: number } | undefined;
      expect(meta).toBeDefined();

      indexer.removeNode('n1');

      const metaAfter = db.prepare(
        "SELECT id FROM embedding_meta WHERE node_id = 'n1'"
      ).get();
      expect(metaAfter).toBeUndefined();

      const vecAfter = db.prepare(
        'SELECT id FROM embedding_vec WHERE id = ?'
      ).get(meta!.id);
      expect(vecAfter).toBeUndefined();
    });
  });

  describe('embedding error recovery', () => {
    function createFailingEmbedder(failCount: number): Embedder & { callCount: number } {
      let callCount = 0;

      return {
        get callCount() { return callCount; },
        async embedDocument(text: string): Promise<Float32Array[]> {
          callCount++;
          if (callCount <= failCount) {
            throw new Error(`Simulated embedding failure (call ${callCount})`);
          }
          const arr = new Float32Array(256);
          for (let i = 0; i < 256; i++) {
            arr[i] = (text.length % 100) / 100 + i * 0.001;
          }
          return [arr];
        },
        async embedQuery(_text: string): Promise<Float32Array> {
          return new Float32Array(256).fill(0.5);
        },
        isReady(): boolean {
          return true;
        },
      };
    }

    it('requeues item on embedding failure', async () => {
      const failingEmbedder = createFailingEmbedder(1);
      const failingIndexer = createEmbeddingIndexer(db, failingEmbedder);

      insertNode(db, 'n1', 'Hello World', 'Some body text');
      failingIndexer.enqueue({ node_id: 'n1', source_type: 'node' });

      // First processOne should fail and requeue
      const result1 = await failingIndexer.processOne();
      expect(result1).toBe(false);
      expect(failingIndexer.queueSize()).toBe(1);

      // Second processOne should succeed
      const result2 = await failingIndexer.processOne();
      expect(result2).toBe(true);
      expect(failingIndexer.queueSize()).toBe(0);
    });

    it('drops item after 3 failures', async () => {
      const alwaysFailingEmbedder = createFailingEmbedder(Infinity);
      const failingIndexer = createEmbeddingIndexer(db, alwaysFailingEmbedder);

      insertNode(db, 'n1', 'Hello World', 'Some body text');
      failingIndexer.enqueue({ node_id: 'n1', source_type: 'node' });

      await failingIndexer.processOne();
      await failingIndexer.processOne();
      await failingIndexer.processOne();

      expect(failingIndexer.queueSize()).toBe(0);
      expect(alwaysFailingEmbedder.callCount).toBe(3);
    });
  });

  describe('multi-chunk storage', () => {
    it('stores N meta+vec rows when embedder returns N vectors', async () => {
      db = createTestDb();
      const multi = createMultiChunkEmbedder(3);
      const idx = createEmbeddingIndexer(db, multi);
      insertNode(db, 'n1', 'Title', 'body');
      idx.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx.processAll();

      const rows = db.prepare(
        "SELECT chunk_index FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'node' ORDER BY chunk_index"
      ).all() as { chunk_index: number }[];
      expect(rows.map(r => r.chunk_index)).toEqual([0, 1, 2]);

      const vecCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = 'n1')"
      ).get() as { cnt: number }).cnt;
      expect(vecCount).toBe(3);
    });

    it('skips re-embedding when hash is unchanged', async () => {
      db = createTestDb();
      const multi = createMultiChunkEmbedder(3);
      const idx = createEmbeddingIndexer(db, multi);
      insertNode(db, 'n1', 'Title', 'body');
      idx.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx.processAll();

      idx.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx.processAll();
      expect(multi.callCount).toBe(1);
    });

    it('rolls back partial writes when embedder returns malformed vectors', async () => {
      db = createTestDb();
      // Embedder where the 2nd "vector" is null — will throw inside the insert loop
      const faulty: Embedder = {
        async embedDocument() {
          const good = new Float32Array(256).fill(0.1);
          return [good, null as unknown as Float32Array, good];
        },
        async embedQuery() { return new Float32Array(256); },
        isReady: () => true,
      };
      const idx = createEmbeddingIndexer(db, faulty);
      insertNode(db, 'n1', 'Title', 'body');
      idx.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx.processAll();

      // After the failure the entire group should be absent (transaction rolled back)
      const cnt = (db.prepare(
        "SELECT COUNT(*) as cnt FROM embedding_meta WHERE node_id = 'n1'"
      ).get() as { cnt: number }).cnt;
      expect(cnt).toBe(0);
    });

    it('replaces old rows when content changes from N=3 chunks to N=1', async () => {
      db = createTestDb();
      const three = createMultiChunkEmbedder(3);
      const idx1 = createEmbeddingIndexer(db, three);
      insertNode(db, 'n1', 'Title', 'body v1');
      idx1.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx1.processAll();

      db.prepare('UPDATE nodes SET body = ? WHERE id = ?').run('body v2', 'n1');
      const one = createMultiChunkEmbedder(1);
      const idx2 = createEmbeddingIndexer(db, one);
      idx2.enqueue({ node_id: 'n1', source_type: 'node' });
      await idx2.processAll();

      const rows = db.prepare(
        "SELECT chunk_index FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'node' ORDER BY chunk_index"
      ).all() as { chunk_index: number }[];
      expect(rows.map(r => r.chunk_index)).toEqual([0]);
      const vecCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = 'n1')"
      ).get() as { cnt: number }).cnt;
      expect(vecCount).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('clears all embedding data and queue', async () => {
      insertNode(db, 'n1', 'Node 1');
      insertNode(db, 'n2', 'Node 2');

      indexer.enqueue({ node_id: 'n1', source_type: 'node' });
      indexer.enqueue({ node_id: 'n2', source_type: 'node' });
      await indexer.processAll();

      // Verify data exists
      const countBefore = db.prepare('SELECT COUNT(*) as cnt FROM embedding_meta').get() as { cnt: number };
      expect(countBefore.cnt).toBe(2);

      indexer.clearAll();

      const countAfter = db.prepare('SELECT COUNT(*) as cnt FROM embedding_meta').get() as { cnt: number };
      expect(countAfter.cnt).toBe(0);

      const vecCount = db.prepare('SELECT COUNT(*) as cnt FROM embedding_vec').get() as { cnt: number };
      expect(vecCount.cnt).toBe(0);

      expect(indexer.queueSize()).toBe(0);
    });
  });
});

function createFakeCache(byPath: Record<string, string>) {
  return {
    async getExtraction(filePath: string) {
      const text = byPath[filePath];
      if (!text) throw new Error(`no fake extraction for ${filePath}`);
      return { text, mediaType: 'audio' as const };
    },
  };
}

describe('extraction embedding', () => {
  let db: Database.Database;
  let fakeEmbedder: ReturnType<typeof createFakeEmbedder>;
  let vaultDir: string;

  beforeEach(() => {
    db = createTestDb();
    fakeEmbedder = createFakeEmbedder();
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-idx-ext-'));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('enqueuing a node discovers non-markdown embeds and enqueues extractions', async () => {
    writeFileSync(join(vaultDir, 'audio.m4a'), 'fake audio bytes');
    const cache = createFakeCache({ [join(vaultDir, 'audio.m4a')]: 'transcript here' });
    const idx = createEmbeddingIndexer(db, fakeEmbedder, { extractionCache: cache as any, vaultPath: vaultDir });

    insertNode(db, 'n1', 'With Audio', 'See transcript: ![[audio.m4a]]');
    idx.enqueue({ node_id: 'n1', source_type: 'node' });

    expect(idx.queueSize()).toBe(2);
    await idx.processAll();

    const extRows = db.prepare(
      "SELECT extraction_ref FROM embedding_meta WHERE node_id = 'n1' AND source_type = 'extraction'"
    ).all() as { extraction_ref: string }[];
    expect(extRows.length).toBe(1);
    expect(extRows[0].extraction_ref).toBe('audio.m4a');
  });

  it('does NOT enqueue extraction items for markdown embeds', async () => {
    insertNode(db, 'n2', 'Other Note', 'stuff');
    const cache = createFakeCache({});
    const idx = createEmbeddingIndexer(db, fakeEmbedder, { extractionCache: cache as any, vaultPath: vaultDir });

    insertNode(db, 'n1', 'Parent', 'See: ![[Other Note]]');
    idx.enqueue({ node_id: 'n1', source_type: 'node' });

    expect(idx.queueSize()).toBe(1);
  });

  it('extraction item is skipped on second run when text hash unchanged', async () => {
    writeFileSync(join(vaultDir, 'audio.m4a'), 'x');
    const cache = createFakeCache({ [join(vaultDir, 'audio.m4a')]: 'stable text' });
    const idx = createEmbeddingIndexer(db, fakeEmbedder, { extractionCache: cache as any, vaultPath: vaultDir });
    insertNode(db, 'n1', 'With Audio', '![[audio.m4a]]');

    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();
    const firstCalls = fakeEmbedder.callCount;

    idx.enqueue({ node_id: 'n1', source_type: 'node' });
    await idx.processAll();
    expect(fakeEmbedder.callCount).toBe(firstCalls);
  });
});
