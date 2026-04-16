import { describe, it, expect, afterEach } from 'vitest';
import { createSubprocessEmbedder } from '../../src/search/embedder-host.js';
import { resolve } from 'node:path';

// These tests use the real worker, which needs the model files.
// They are integration tests — skip in CI if model not available.
// For unit-level coverage, the indexer tests already mock the Embedder interface.

const modelsDir = resolve(
  process.env.VAULT_PATH ?? resolve(import.meta.dirname, '..', '..', '..', 'Documents', 'archbrain'),
  '.vault-engine',
  'models',
);

// The worker must be the compiled JS (not TS) — vitest runs source files directly,
// so import.meta.dirname in embedder-host.ts resolves to src/search/, not dist/.
// We override workerPath to point at the pre-built dist artifact.
const workerPath = resolve(import.meta.dirname, '..', '..', 'dist', 'search', 'embedder-worker.js');

// Quick check if model files exist
import { existsSync } from 'node:fs';
const modelAvailable = existsSync(resolve(modelsDir, 'nomic-ai'));
const describeIfModel = modelAvailable ? describe : describe.skip;

describeIfModel('SubprocessEmbedder (integration)', () => {
  let embedder: ReturnType<typeof createSubprocessEmbedder> | null = null;

  afterEach(async () => {
    if (embedder) {
      await embedder.shutdown();
      embedder = null;
    }
  });

  it('embeds a document via subprocess', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const vectors = await embedder.embedDocument('Hello world');
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBe(1);
    const [vec] = vectors;
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(256);
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeGreaterThan(0);
  }, 30_000);

  it('embeds a query via subprocess', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const vec = await embedder.embedQuery('find meetings');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(256);
  }, 30_000);

  it('handles concurrent requests', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const [a, b, c] = await Promise.all([
      embedder.embedDocument('first'),
      embedder.embedDocument('second'),
      embedder.embedQuery('third'),
    ]);
    expect(a[0].length).toBe(256);
    expect(b[0].length).toBe(256);
    expect(c.length).toBe(256); // embedQuery still returns a single Float32Array
  }, 30_000);

  it('respawns after shutdown', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    const v1 = await embedder.embedDocument('before shutdown');
    expect(v1[0].length).toBe(256);

    await embedder.shutdown();

    // Should respawn transparently on next request
    const v2 = await embedder.embedDocument('after shutdown');
    expect(v2[0].length).toBe(256);
  }, 60_000);

  it('isReady() returns true before and after spawning', () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    expect(embedder.isReady()).toBe(true);
  });

  it('idle timeout kills child process', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 1_000 }); // 1s timeout
    await embedder.embedDocument('trigger spawn');

    // Wait for idle timeout + buffer
    await new Promise(r => setTimeout(r, 2_000));

    // Next request should still work (respawns)
    const vectors = await embedder.embedDocument('after idle');
    expect(vectors[0].length).toBe(256);
  }, 60_000);

  it('chunks long documents into multiple vectors', async () => {
    embedder = createSubprocessEmbedder({ modelsDir, workerPath, idleTimeoutMs: 60_000 });
    // ~45K chars ≈ ~11K tokens → must chunk (Nomic limit 8192).
    const longText = Array.from({ length: 300 }, (_, i) =>
      `## Section ${i}\nThis is paragraph ${i}. ` + 'word '.repeat(30)
    ).join('\n\n');
    const vectors = await embedder.embedDocument(longText);
    expect(vectors.length).toBeGreaterThan(1);
    for (const v of vectors) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(256);
      const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
      expect(magnitude).toBeGreaterThan(0);
    }
  }, 60_000);
});
