import { describe, it, expect } from 'vitest';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';

function makeExtractor(id: string, mediaType: string, extensions: string[]): Extractor {
  return {
    id,
    mediaType,
    supportedExtensions: extensions,
    extract: async (_filePath: string): Promise<ExtractionResult> => ({ text: `result from ${id}` }),
  };
}

describe('ExtractorRegistry', () => {
  it('registers and retrieves extractor by extension', () => {
    const registry = new ExtractorRegistry();
    const extractor = makeExtractor('deepgram-nova-3', 'audio', ['.m4a', '.mp3']);
    registry.register(extractor);

    expect(registry.getForExtension('.m4a')).toBe(extractor);
    expect(registry.getForExtension('.mp3')).toBe(extractor);
  });

  it('returns null for unregistered extension', () => {
    const registry = new ExtractorRegistry();
    expect(registry.getForExtension('.pdf')).toBeNull();
  });

  it('last registration wins for same extension', () => {
    const registry = new ExtractorRegistry();
    const first = makeExtractor('extractor-a', 'audio', ['.m4a']);
    const second = makeExtractor('extractor-b', 'audio', ['.m4a']);
    registry.register(first);
    registry.register(second);

    expect(registry.getForExtension('.m4a')).toBe(second);
  });

  it('lists all registered extractors', () => {
    const registry = new ExtractorRegistry();
    const audio = makeExtractor('deepgram-nova-3', 'audio', ['.m4a', '.mp3']);
    const image = makeExtractor('vision-extractor', 'image', ['.jpg', '.png']);
    registry.register(audio);
    registry.register(image);

    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(audio);
    expect(all).toContain(image);
  });

  it('reports unavailable extractors with reason containing the missing key name', () => {
    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a', '.mp3'], 'DEEPGRAM_API_KEY');

    const reason = registry.getUnavailableReason('.m4a');
    expect(reason).not.toBeNull();
    expect(reason).toContain('DEEPGRAM_API_KEY');
  });

  it('unavailable reason is null for registered (active) extensions', () => {
    const registry = new ExtractorRegistry();
    const extractor = makeExtractor('deepgram-nova-3', 'audio', ['.m4a', '.mp3']);
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a', '.mp3'], 'DEEPGRAM_API_KEY');
    registry.register(extractor);

    expect(registry.getUnavailableReason('.m4a')).toBeNull();
  });

  it('unavailable reason is null for unknown extensions', () => {
    const registry = new ExtractorRegistry();
    expect(registry.getUnavailableReason('.xyz')).toBeNull();
  });

  it('does not mark extensions unavailable if an active extractor already covers them', () => {
    const registry = new ExtractorRegistry();
    const extractor = makeExtractor('extractor-a', 'audio', ['.m4a']);
    registry.register(extractor);
    registry.registerUnavailable('extractor-b', 'audio', ['.m4a'], 'SOME_API_KEY');

    // Active extractor covers .m4a, so unavailable should not override
    expect(registry.getUnavailableReason('.m4a')).toBeNull();
    expect(registry.getForExtension('.m4a')).toBe(extractor);
  });

  it('getStatus returns active and unavailable lists', () => {
    const registry = new ExtractorRegistry();
    const audio = makeExtractor('deepgram-nova-3', 'audio', ['.m4a', '.mp3']);
    registry.register(audio);
    registry.registerUnavailable('vision-extractor', 'image', ['.jpg', '.png'], 'VISION_API_KEY');

    const status = registry.getStatus();

    expect(status.active).toHaveLength(1);
    expect(status.active[0]).toEqual({
      id: 'deepgram-nova-3',
      mediaType: 'audio',
      extensions: ['.m4a', '.mp3'],
    });

    expect(status.unavailable).toHaveLength(1);
    expect(status.unavailable[0]).toEqual({
      id: 'vision-extractor',
      mediaType: 'image',
      extensions: ['.jpg', '.png'],
      missingKey: 'VISION_API_KEY',
    });
  });

  it('getStatus active list deduplicates extractors registered for multiple extensions', () => {
    const registry = new ExtractorRegistry();
    const audio = makeExtractor('deepgram-nova-3', 'audio', ['.m4a', '.mp3', '.wav']);
    registry.register(audio);

    const status = registry.getStatus();
    expect(status.active).toHaveLength(1);
  });
});
