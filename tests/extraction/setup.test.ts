import { describe, it, expect } from 'vitest';
import { buildExtractorRegistry } from '../../src/extraction/setup.js';

describe('buildExtractorRegistry', () => {
  it('registers local extractors with no env vars', () => {
    const registry = buildExtractorRegistry({});
    const status = registry.getStatus();
    expect(status.active.map(e => e.id).sort()).toEqual(['markdown-read', 'office-doc', 'unpdf-text']);
    expect(status.unavailable.map(e => e.id).sort()).toEqual(['claude-vision-image', 'claude-vision-pdf', 'deepgram-nova-3']);
  });

  it('registers deepgram when DEEPGRAM_API_KEY is set', () => {
    const registry = buildExtractorRegistry({ DEEPGRAM_API_KEY: 'dk_test' });
    const status = registry.getStatus();
    expect(status.active.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    expect(status.unavailable.some(e => e.id === 'deepgram-nova-3')).toBe(false);
  });

  it('registers claude vision when ANTHROPIC_API_KEY is set', () => {
    const registry = buildExtractorRegistry({ ANTHROPIC_API_KEY: 'sk-test' });
    const status = registry.getStatus();
    expect(status.active.some(e => e.id === 'claude-vision-image')).toBe(true);
    expect(status.active.some(e => e.id === 'claude-vision-pdf')).toBe(true);
  });
});
