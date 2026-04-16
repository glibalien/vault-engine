import { describe, it, expect } from 'vitest';
import type { Embedder } from '../../src/search/embedder.js';

describe('Embedder interface', () => {
  it('type-checks a conforming implementation', () => {
    // This is a compile-time check — if the interface changes, this test
    // will fail to compile, alerting us to update all implementations.
    const fake: Embedder = {
      async embedDocument(text: string) { return [new Float32Array(256)]; },
      async embedQuery(text: string) { return new Float32Array(256); },
      isReady() { return true; },
    };
    expect(fake.isReady()).toBe(true);
  });
});
