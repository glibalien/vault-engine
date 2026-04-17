import { describe, it, expect } from 'vitest';
import {
  GeminiVisionImageExtractor,
  GeminiVisionPdfExtractor,
} from '../../../src/extraction/extractors/gemini-vision.js';

describe('GeminiVisionImageExtractor', () => {
  const extractor = new GeminiVisionImageExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('gemini-vision-image');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('image');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  });

  it('exposes an extract function', () => {
    expect(typeof extractor.extract).toBe('function');
  });
});

describe('GeminiVisionPdfExtractor', () => {
  const extractor = new GeminiVisionPdfExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('gemini-vision-pdf');
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
