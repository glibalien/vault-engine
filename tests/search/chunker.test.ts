import { describe, it, expect } from 'vitest';
import { chunkForEmbedding } from '../../src/search/chunker.js';

// Approx 4 chars/token — matches Nomic's real ratio closely enough for tests.
const approxTokenize = (s: string): number => Math.ceil(s.length / 4);

describe('chunkForEmbedding', () => {
  it('returns a single chunk when under the token budget', () => {
    const text = 'Hello world.';
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toEqual(['Hello world.']);
  });

  it('splits on markdown headings when text exceeds budget', () => {
    const text = [
      '## Section A',
      'Alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha.',
      '',
      '## Section B',
      'Beta beta beta beta beta beta beta beta beta beta beta beta beta beta.',
      '',
      '## Section C',
      'Gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma.',
    ].join('\n');
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 30, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]).toContain('Section A');
    expect(chunks[1]).toContain('Section B');
    expect(chunks[2]).toContain('Section C');
  });

  it('splits on paragraphs when a section is still too large', () => {
    const big = 'p' + 'aragraph '.repeat(50);
    const text = `${big}\n\n${big}\n\n${big}`;
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 120, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(130);
    }
  });

  it('splits on sentences when a paragraph is still too large', () => {
    const sentence = 'This is a sentence with some words in it.';
    const paragraph = Array(30).fill(sentence).join(' ');
    const chunks = chunkForEmbedding(paragraph, approxTokenize, { maxTokens: 50, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(60);
    }
  });

  it('hard-splits with overlap when even a sentence exceeds the budget', () => {
    const noBoundaries = 'x'.repeat(4000);
    const chunks = chunkForEmbedding(noBoundaries, approxTokenize, { maxTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(220);
    }
    const tail = chunks[0].slice(-40);
    const head = chunks[1].slice(0, 120);
    expect(head).toContain(tail.slice(-20));
  });

  it('packs small adjacent sections up to the budget', () => {
    const parts = Array.from({ length: 10 }, (_, i) => `## H${i}\nshort body for section ${i}.`);
    const text = parts.join('\n\n');
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 200, overlapTokens: 0 });
    expect(chunks.length).toBeLessThan(5);
  });

  it('returns empty array for empty input', () => {
    expect(chunkForEmbedding('', approxTokenize, { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });
});
