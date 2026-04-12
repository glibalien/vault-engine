import { readFile } from 'node:fs/promises';
import type { Extractor, ExtractionResult } from '../types.js';

export class MarkdownExtractor implements Extractor {
  readonly id = 'markdown-read';
  readonly mediaType = 'markdown';
  readonly supportedExtensions = ['.md'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const text = await readFile(filePath, 'utf-8');
    return { text };
  }
}
