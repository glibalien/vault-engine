import { describe, it, expect } from 'vitest';
import { buildExtractors } from '../../src/extraction/setup.js';

describe('buildExtractors', () => {
  describe('always-on local extractors', () => {
    it('registers markdown, office, and unpdf with no env vars', () => {
      const { registry } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.active.map(e => e.id).sort()).toContain('markdown-read');
      expect(status.active.map(e => e.id).sort()).toContain('office-doc');
      expect(status.active.map(e => e.id).sort()).toContain('unpdf-text');
    });

    it('serves .pdf from unpdf (not any vision extractor)', () => {
      const { registry } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });
  });

  describe('deepgram', () => {
    it('registers when DEEPGRAM_API_KEY is set', () => {
      const { registry } = buildExtractors({ DEEPGRAM_API_KEY: 'dk_test' });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    });

    it('marks unavailable when DEEPGRAM_API_KEY is unset', () => {
      const { registry } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    });
  });

  describe('VISION_PROVIDER=gemini (default)', () => {
    it('with GEMINI_API_KEY: image extractor active, pdfFallback is gemini', () => {
      const { registry, pdfFallback } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'gemini-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('without GEMINI_API_KEY: image marked unavailable, pdfFallback is null', () => {
      const { registry, pdfFallback } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'gemini-vision-image')).toBe(true);
      expect(status.unavailable.some(e => e.id === 'gemini-vision-pdf')).toBe(true);
      expect(pdfFallback).toBeNull();
    });

    it('empty-string VISION_PROVIDER treated as gemini', () => {
      const { pdfFallback } = buildExtractors({ VISION_PROVIDER: '', GEMINI_API_KEY: 'g_test' });
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('whitespace VISION_PROVIDER treated as gemini', () => {
      const { pdfFallback } = buildExtractors({ VISION_PROVIDER: '   ', GEMINI_API_KEY: 'g_test' });
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });
  });

  describe('VISION_PROVIDER=claude', () => {
    it('with ANTHROPIC_API_KEY: image extractor active, pdfFallback is claude', () => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'claude-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('claude-vision-pdf');
    });

    it('without ANTHROPIC_API_KEY: image marked unavailable, pdfFallback is null', () => {
      const { registry, pdfFallback } = buildExtractors({ VISION_PROVIDER: 'claude' });
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'claude-vision-image')).toBe(true);
      expect(status.unavailable.some(e => e.id === 'claude-vision-pdf')).toBe(true);
      expect(pdfFallback).toBeNull();
    });

    it('is case-insensitive', () => {
      const { pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'CLAUDE',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      expect(pdfFallback?.id).toBe('claude-vision-pdf');
    });
  });

  describe('invalid VISION_PROVIDER', () => {
    it('throws for unknown provider', () => {
      expect(() => buildExtractors({ VISION_PROVIDER: 'bogus' })).toThrow(
        /VISION_PROVIDER/,
      );
    });
  });

  describe('latent-bug regression', () => {
    it('never registers gemini-vision-pdf into byExtension for .pdf', () => {
      const { registry } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).not.toBe('gemini-vision-pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });

    it('never registers claude-vision-pdf into byExtension for .pdf', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).not.toBe('claude-vision-pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });
  });
});
