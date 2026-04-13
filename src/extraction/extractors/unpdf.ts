import { readFile } from 'node:fs/promises';
import type { Extractor, ExtractionResult } from '../types.js';

export class UnpdfExtractor implements Extractor {
  readonly id = 'unpdf-text';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const buffer = await readFile(filePath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const avgCharsPerPage = Math.round(text.length / Math.max(totalPages, 1));
    console.log(`[extraction:unpdf] ${totalPages} pages, ${avgCharsPerPage} avg chars/page, ${text.length} chars total`);
    return {
      text,
      metadata: { totalPages, avgCharsPerPage },
    };
  }
}
