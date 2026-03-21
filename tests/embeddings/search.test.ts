import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadVecExtension, createVecTable } from '../../src/embeddings/vec.js';
import { semanticSearch, getPendingEmbeddingCount } from '../../src/embeddings/search.js';

function setupTestData(db: Database.Database) {
  // Insert 3 nodes
  const insertNode = db.prepare(
    'INSERT INTO nodes (id, file_path, node_type, content_text, title, depth) VALUES (?, ?, ?, ?, ?, 0)'
  );
  insertNode.run('meetings/q1.md', 'meetings/q1.md', 'file', 'Q1 planning meeting notes', 'Q1 Planning');
  insertNode.run('tasks/review.md', 'tasks/review.md', 'file', 'Code review task', 'Review');
  insertNode.run('notes/infra.md', 'notes/infra.md', 'file', 'Infrastructure notes', 'Infra');

  // Insert types
  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  insertType.run('meetings/q1.md', 'meeting');
  insertType.run('tasks/review.md', 'task');
  insertType.run('notes/infra.md', 'note');

  // Insert fields
  const insertField = db.prepare(
    'INSERT INTO fields (node_id, key, value_text, value_type) VALUES (?, ?, ?, ?)'
  );
  insertField.run('tasks/review.md', 'status', 'todo', 'string');
  insertField.run('tasks/review.md', 'priority', 'high', 'string');
  insertField.run('notes/infra.md', 'category', 'devops', 'string');

  // Insert chunks
  const insertChunk = db.prepare(
    'INSERT INTO chunks (id, node_id, chunk_index, heading, content, token_count) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertChunk.run('meetings/q1.md#full', 'meetings/q1.md', 0, null, 'Q1 planning meeting notes', 10);
  insertChunk.run('tasks/review.md#section:0', 'tasks/review.md', 0, 'Overview', 'Code review overview', 8);
  insertChunk.run('tasks/review.md#section:1', 'tasks/review.md', 1, 'Details', 'Review implementation details', 10);
  insertChunk.run('notes/infra.md#full', 'notes/infra.md', 0, null, 'Infrastructure notes content', 10);

  // Insert vectors into vec_chunks
  // Directional embeddings so distance-based ranking is deterministic:
  //   notes/infra.md     → [0.9, 0.1, 0.0] (closest to query [1,0,0])
  //   tasks/review.md:0  → [0.7, 0.3, 0.0]
  //   tasks/review.md:1  → [0.3, 0.7, 0.0]
  //   meetings/q1.md     → [0.0, 0.0, 1.0] (furthest)
  const insertVec = db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');
  insertVec.run('notes/infra.md#full', Buffer.from(new Float32Array([0.9, 0.1, 0.0]).buffer));
  insertVec.run('tasks/review.md#section:0', Buffer.from(new Float32Array([0.7, 0.3, 0.0]).buffer));
  insertVec.run('tasks/review.md#section:1', Buffer.from(new Float32Array([0.3, 0.7, 0.0]).buffer));
  insertVec.run('meetings/q1.md#full', Buffer.from(new Float32Array([0.0, 0.0, 1.0]).buffer));
}

describe('semanticSearch', () => {
  let db: Database.Database;
  const queryVec = Buffer.from(new Float32Array([1.0, 0.0, 0.0]).buffer);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadVecExtension(db);
    createVecTable(db, 3);
    setupTestData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns nodes ranked by vector similarity', () => {
    const results = semanticSearch(db, queryVec, {});

    expect(results.length).toBeGreaterThanOrEqual(3);
    // notes/infra.md should be first (closest to [1,0,0])
    expect(results[0].id).toBe('notes/infra.md');
    // meetings/q1.md should be last (furthest from [1,0,0])
    expect(results[results.length - 1].id).toBe('meetings/q1.md');
    // Scores should be in descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('deduplicates by node_id keeping best chunk', () => {
    const results = semanticSearch(db, queryVec, {});

    // tasks/review.md has two chunks but should appear only once
    const taskResults = results.filter(r => r.id === 'tasks/review.md');
    expect(taskResults).toHaveLength(1);

    // Total unique nodes = 3
    expect(results).toHaveLength(3);
  });

  it('filters by schema_type', () => {
    const results = semanticSearch(db, queryVec, { schema_type: 'task' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('tasks/review.md');
    expect(results[0].types).toContain('task');
  });

  it('filters by field equality', () => {
    const results = semanticSearch(db, queryVec, {
      filters: [{ field: 'status', operator: 'eq', value: 'todo' }],
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('tasks/review.md');
    expect(results[0].fields.status).toBe('todo');
  });

  it('includes matching chunk when include_chunks=true', () => {
    const results = semanticSearch(db, queryVec, { include_chunks: true });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.matchingChunk).toBeDefined();
      expect(result.matchingChunk!.content).toBeDefined();
    }

    // The infra note chunk has no heading
    const infraResult = results.find(r => r.id === 'notes/infra.md')!;
    expect(infraResult.matchingChunk!.heading).toBeNull();
    expect(infraResult.matchingChunk!.content).toBe('Infrastructure notes content');

    // The task's best chunk (section:0) has heading 'Overview'
    const taskResult = results.find(r => r.id === 'tasks/review.md')!;
    expect(taskResult.matchingChunk!.heading).toBe('Overview');
  });

  it('omits matchingChunk when include_chunks=false', () => {
    const results = semanticSearch(db, queryVec, { include_chunks: false });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.matchingChunk).toBeUndefined();
    }
  });

  it('respects limit parameter', () => {
    const results = semanticSearch(db, queryVec, { limit: 2 });

    expect(results).toHaveLength(2);
    // Should still be the top 2 by similarity
    expect(results[0].id).toBe('notes/infra.md');
  });

  it('returns empty array when no vectors exist', () => {
    // Clear vec_chunks
    db.exec('DELETE FROM vec_chunks');

    const results = semanticSearch(db, queryVec, {});
    expect(results).toEqual([]);
  });
});

describe('getPendingEmbeddingCount', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns count of unprocessed entries', () => {
    // Insert a node and chunks for FK constraints
    db.prepare(
      'INSERT INTO nodes (id, file_path, node_type, content_text, title, depth) VALUES (?, ?, ?, ?, ?, 0)'
    ).run('test.md', 'test.md', 'file', 'content', 'Test');

    db.prepare(
      'INSERT INTO chunks (id, node_id, chunk_index, content, token_count) VALUES (?, ?, 0, ?, 10)'
    ).run('test.md#a', 'test.md', 'content a');
    db.prepare(
      'INSERT INTO chunks (id, node_id, chunk_index, content, token_count) VALUES (?, ?, 1, ?, 10)'
    ).run('test.md#b', 'test.md', 'content b');
    db.prepare(
      'INSERT INTO chunks (id, node_id, chunk_index, content, token_count) VALUES (?, ?, 2, ?, 10)'
    ).run('test.md#c', 'test.md', 'content c');

    // Insert queue entries with different statuses
    db.prepare("INSERT INTO embedding_queue (chunk_id, status) VALUES (?, 'pending')").run('test.md#a');
    db.prepare("INSERT INTO embedding_queue (chunk_id, status) VALUES (?, 'processing')").run('test.md#b');
    db.prepare("INSERT INTO embedding_queue (chunk_id, status) VALUES (?, 'failed')").run('test.md#c');

    const count = getPendingEmbeddingCount(db);
    // 'pending' + 'processing' = 2, 'failed' is excluded
    expect(count).toBe(2);
  });

  it('returns 0 when queue is empty', () => {
    const count = getPendingEmbeddingCount(db);
    expect(count).toBe(0);
  });
});
