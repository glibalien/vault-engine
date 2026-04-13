import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarkdownExtractor } from '../../../src/extraction/extractors/markdown.js';

describe('MarkdownExtractor', () => {
  const extractor = new MarkdownExtractor();

  it('has correct id', () => {
    expect(extractor.id).toBe('markdown-read');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('markdown');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.md']);
  });

  it('reads file content', async () => {
    const dir = join(tmpdir(), 'markdown-extractor-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'test.md');
    const content = '# Hello\n\nThis is a test.\n';
    await writeFile(filePath, content, 'utf-8');

    try {
      const result = await extractor.extract(filePath);
      expect(result.text).toBe(content);
      expect(result.metadata).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('throws on missing file', async () => {
    await expect(
      extractor.extract('/nonexistent/path/file.md')
    ).rejects.toThrow();
  });
});
