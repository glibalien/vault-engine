import { describe, it, expect } from 'vitest';
import {
  ClaudeVisionImageExtractor,
  ClaudeVisionPdfExtractor,
} from '../../../src/extraction/extractors/claude-vision.js';

describe('ClaudeVisionImageExtractor', () => {
  const extractor = new ClaudeVisionImageExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('claude-vision-image');
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

describe('ClaudeVisionPdfExtractor', () => {
  const extractor = new ClaudeVisionPdfExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('claude-vision-pdf');
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
