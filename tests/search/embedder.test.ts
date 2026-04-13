import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbedder, type Embedder } from '../../src/search/embedder.js';

vi.mock('@huggingface/transformers', () => {
  const mockPipeline = vi.fn().mockResolvedValue(
    vi.fn().mockImplementation((text: string, options?: { pooling: string; normalize: boolean }) => {
      const data = new Float32Array(256).fill(0.1);
      return Promise.resolve({ data });
    })
  );
  return { pipeline: mockPipeline, env: { cacheDir: '', allowRemoteModels: true } };
});

describe('Embedder', () => {
  let embedder: Embedder;

  beforeEach(async () => {
    embedder = await createEmbedder({ modelsDir: '/tmp/test-models' });
  });

  it('embeds a document string with search_document: prefix', async () => {
    const result = await embedder.embedDocument('Hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(256);
  });

  it('embeds a query string with search_query: prefix', async () => {
    const result = await embedder.embedQuery('find meetings');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(256);
  });

  it('exposes isReady() as true after loading', () => {
    expect(embedder.isReady()).toBe(true);
  });
});
