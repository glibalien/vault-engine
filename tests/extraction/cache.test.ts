import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';
import type Database from 'better-sqlite3';

function makeExtractor(
  id: string,
  mediaType: string,
  extensions: string[],
  extractFn?: (filePath: string) => Promise<ExtractionResult>,
): Extractor {
  return {
    id,
    mediaType,
    supportedExtensions: extensions,
    extract: extractFn ?? (async (_filePath: string) => ({ text: `result from ${id}` })),
  };
}

describe('ExtractionCache', () => {
  let db: Database.Database;
  let registry: ExtractorRegistry;
  let cache: ExtractionCache;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    registry = new ExtractorRegistry();
    cache = new ExtractionCache(db, registry);
    tmpDir = mkdtempSync(join(tmpdir(), 'cache-test-'));
  });

  it('extracts and caches on first call (DB row exists after)', async () => {
    let extractCount = 0;
    const extractor = makeExtractor('test-extractor', 'text', ['.txt'], async (_fp) => {
      extractCount++;
      return { text: 'hello world' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'file contents');

    const result = await cache.getExtraction(filePath);

    expect(result.text).toBe('hello world');
    expect(result.mediaType).toBe('text');
    expect(result.extractorId).toBe('test-extractor');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extractCount).toBe(1);

    // Verify DB row exists
    const row = db.prepare('SELECT * FROM extraction_cache WHERE content_hash = ?').get(result.contentHash);
    expect(row).not.toBeNull();
  });

  it('returns cached result on second call (extractCount stays at 1)', async () => {
    let extractCount = 0;
    const extractor = makeExtractor('test-extractor', 'text', ['.txt'], async (_fp) => {
      extractCount++;
      return { text: 'cached text' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'same contents');

    const first = await cache.getExtraction(filePath);
    const second = await cache.getExtraction(filePath);

    expect(extractCount).toBe(1);
    expect(first.text).toBe(second.text);
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('re-extracts when file content changes (different hash)', async () => {
    let extractCount = 0;
    const extractor = makeExtractor('test-extractor', 'text', ['.txt'], async (_fp) => {
      extractCount++;
      return { text: `extraction ${extractCount}` };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'original content');

    const first = await cache.getExtraction(filePath);
    expect(extractCount).toBe(1);

    writeFileSync(filePath, 'changed content');

    const second = await cache.getExtraction(filePath);
    expect(extractCount).toBe(2);
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('throws EXTRACTOR_UNAVAILABLE for extension with registered unavailable extractor', async () => {
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');

    const filePath = join(tmpDir, 'audio.m4a');
    writeFileSync(filePath, 'fake audio');

    await expect(cache.getExtraction(filePath)).rejects.toThrow('EXTRACTOR_UNAVAILABLE:');
    await expect(cache.getExtraction(filePath)).rejects.toThrow('DEEPGRAM_API_KEY');
  });

  it('throws "No extractor" for completely unknown extension', async () => {
    const filePath = join(tmpDir, 'data.xyz');
    writeFileSync(filePath, 'some data');

    await expect(cache.getExtraction(filePath)).rejects.toThrow('No extractor registered for');
  });

  it('does not cache failures (first call throws, second call retries and succeeds)', async () => {
    let callCount = 0;
    const extractor = makeExtractor('flaky-extractor', 'text', ['.txt'], async (_fp) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Extraction failed');
      }
      return { text: 'success on retry' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'file data');

    await expect(cache.getExtraction(filePath)).rejects.toThrow('Extraction failed');

    // Second call should retry (not use cache)
    const result = await cache.getExtraction(filePath);
    expect(result.text).toBe('success on retry');
    expect(callCount).toBe(2);
  });

  it('stores metadata as JSON and round-trips through DB', async () => {
    const metadata = { duration: 123.45, language: 'en', confidence: 0.97 };
    const extractor = makeExtractor('meta-extractor', 'audio', ['.mp3'], async (_fp) => ({
      text: 'audio content',
      metadata,
    }));
    registry.register(extractor);

    const filePath = join(tmpDir, 'audio.mp3');
    writeFileSync(filePath, 'fake mp3 data');

    // First call — extracts and caches
    const first = await cache.getExtraction(filePath);
    expect(first.metadata).toEqual(metadata);

    // Second call — reads from cache
    const second = await cache.getExtraction(filePath);
    expect(second.metadata).toEqual(metadata);
  });

  it('PDF fallback: uses vision when text extraction yields avgCharsPerPage < 50', async () => {
    let textExtractCount = 0;
    let visionExtractCount = 0;

    const pdfExtractor = makeExtractor('pdf-text', 'document', ['.pdf'], async (_fp) => {
      textExtractCount++;
      return { text: 'scan', metadata: { avgCharsPerPage: 10 } };
    });
    const visionExtractor = makeExtractor('claude-vision', 'document', ['.pdf'], async (_fp) => {
      visionExtractCount++;
      return { text: 'full OCR text from vision', metadata: { avgCharsPerPage: 500 } };
    });

    registry.register(pdfExtractor);
    cache.setPdfFallback(visionExtractor);

    const filePath = join(tmpDir, 'scanned.pdf');
    writeFileSync(filePath, 'fake pdf bytes');

    const result = await cache.getExtraction(filePath);

    expect(result.text).toBe('full OCR text from vision');
    expect(result.extractorId).toBe('claude-vision');
    expect(textExtractCount).toBe(1);
    expect(visionExtractCount).toBe(1);
  });

  it('PDF fallback: uses text result when avgCharsPerPage >= 50', async () => {
    let textExtractCount = 0;
    let visionExtractCount = 0;

    const pdfExtractor = makeExtractor('pdf-text', 'document', ['.pdf'], async (_fp) => {
      textExtractCount++;
      return { text: 'plenty of text content here', metadata: { avgCharsPerPage: 100 } };
    });
    const visionExtractor = makeExtractor('claude-vision', 'document', ['.pdf'], async (_fp) => {
      visionExtractCount++;
      return { text: 'vision fallback', metadata: { avgCharsPerPage: 500 } };
    });

    registry.register(pdfExtractor);
    cache.setPdfFallback(visionExtractor);

    const filePath = join(tmpDir, 'text.pdf');
    writeFileSync(filePath, 'fake pdf bytes');

    const result = await cache.getExtraction(filePath);

    expect(result.text).toBe('plenty of text content here');
    expect(result.extractorId).toBe('pdf-text');
    expect(textExtractCount).toBe(1);
    expect(visionExtractCount).toBe(0);
  });
});
