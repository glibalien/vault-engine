import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { parseFile } from '../../src/parser/index.js';
import { indexFile } from '../../src/sync/indexer.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';
import { startEmbeddingWorker } from '../../src/embeddings/worker.js';
import { semanticSearch } from '../../src/embeddings/search.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

describe('embedding pipeline end-to-end', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
  });

  afterEach(() => {
    db.close();
  });

  it('indexes a file, embeds chunks, and returns semantic search results', async () => {
    // Create a mock provider that returns deterministic vectors
    const mockProvider: EmbeddingProvider = {
      dimensions: 3,
      modelName: 'mock',
      embed: async (texts: string[]) =>
        texts.map(t =>
          t.includes('infrastructure') ? [0.9, 0.1, 0.0] : [0.1, 0.1, 0.8]
        ),
    };

    // Index a file with headings — needs enough content to exceed 200-token threshold
    // so the chunker splits by section instead of returning a single full chunk.
    // ~171 words total ≈ 223 estimated tokens (171 * 1.3)
    const infraContent = 'We need to migrate the infrastructure to the new cloud provider. ' +
      'This involves moving all production databases, application servers, and networking ' +
      'configuration from the legacy data center to the cloud environment. The migration ' +
      'must be completed with zero downtime using a blue-green deployment strategy. ' +
      'Key infrastructure components include the primary PostgreSQL cluster, Redis cache ' +
      'layer, load balancers, and container orchestration platform. Each component requires ' +
      'its own migration runbook and rollback procedure. The team will conduct weekly progress ' +
      'reviews and maintain a detailed risk register throughout the project duration.';
    const timelineContent = 'The migration timeline spans Q2 and Q3 of this year. ' +
      'Phase one covers database replication and failover testing during April and May. ' +
      'Phase two handles application server migration with traffic shifting in June. ' +
      'Phase three addresses networking cutover and DNS propagation in July. ' +
      'Final validation and legacy decommissioning will occur in August. ' +
      'Each phase has dedicated testing windows and stakeholder sign-off requirements. ' +
      'The project manager will coordinate daily standups and weekly steering committee updates ' +
      'to ensure timely delivery of all milestones and dependencies.';
    const raw = [
      '---',
      'title: Migration Plan',
      'types: [note]',
      '---',
      '',
      '## Infrastructure',
      '',
      infraContent,
      '',
      '## Timeline',
      '',
      timelineContent,
    ].join('\n');
    const parsed = parseFile('plans/migration.md', raw);
    indexFile(db, parsed, 'plans/migration.md', '2025-03-10T00:00:00.000Z', raw);

    // Verify chunks were created — should split into 2 sections
    const chunks = db.prepare('SELECT * FROM chunks WHERE node_id = ?').all('plans/migration.md');
    expect(chunks.length).toBe(2);

    // Verify queue entries exist
    const queue = db.prepare('SELECT * FROM embedding_queue').all();
    expect(queue.length).toBe(chunks.length);

    // Start worker and wait for processing
    const worker = startEmbeddingWorker(db, mockProvider, { pollIntervalMs: 10 });
    await new Promise(r => setTimeout(r, 200));
    await worker.stop();

    // Verify embeddings were created
    const vecs = db.prepare('SELECT * FROM vec_chunks').all();
    expect(vecs.length).toBe(chunks.length);

    // Verify queue is drained
    const remaining = db.prepare('SELECT * FROM embedding_queue').all();
    expect(remaining).toHaveLength(0);

    // Search for infrastructure-related content
    const queryVec = Buffer.from(new Float32Array([1.0, 0.0, 0.0]).buffer);
    const results = semanticSearch(db, queryVec, { include_chunks: true });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('plans/migration.md');
    expect(results[0].title).toBe('Migration Plan');
    expect(results[0].matchingChunk).toBeDefined();
    // The infrastructure chunk should be the best match
    expect(results[0].matchingChunk!.content).toContain('infrastructure');
  });
});
