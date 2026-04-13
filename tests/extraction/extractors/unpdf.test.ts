import { describe, it, expect } from 'vitest';
import { UnpdfExtractor } from '../../../src/extraction/extractors/unpdf.js';

describe('UnpdfExtractor', () => {
  const extractor = new UnpdfExtractor();

  it('has correct id', () => {
    expect(extractor.id).toBe('unpdf-text');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('pdf');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.pdf']);
  });

  it('exposes an extract function', () => {
    expect(typeof extractor.extract).toBe('function');
  });
});
