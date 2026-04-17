import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { Extractor, ExtractionResult } from '../types.js';

const MODEL = 'gemini-2.5-flash';

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_PROMPT =
  'Extract all text from this image. If it contains handwriting, transcribe it. If it contains a diagram or photo, describe what you see. Return only the extracted content, no commentary.';

const PDF_PROMPT =
  'Extract all text from this scanned PDF document. Transcribe any handwriting. Return only the extracted content, no commentary.';

function extractText(response: { text?: string | null }): string {
  return response.text ?? '';
}

export class GeminiVisionImageExtractor implements Extractor {
  readonly id = 'gemini-vision-image';
  readonly mediaType = 'image';
  readonly supportedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[ext];
    if (!mimeType) {
      throw new Error(`Unsupported image format: ${ext}`);
    }

    const buffer = await readFile(filePath);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:gemini-vision] sending ${sizeMB}MB ${ext} image to Gemini vision`);
    const data = buffer.toString('base64');

    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data } },
            { text: IMAGE_PROMPT },
          ],
        },
      ],
    });

    const text = extractText(response);
    console.log(`[extraction:gemini-vision] image extraction complete: ${text.length} chars`);
    return { text };
  }
}

export class GeminiVisionPdfExtractor implements Extractor {
  readonly id = 'gemini-vision-pdf';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:gemini-vision] sending ${sizeMB}MB scanned PDF to Gemini vision`);
    const data = buffer.toString('base64');

    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data } },
            { text: PDF_PROMPT },
          ],
        },
      ],
    });

    const text = extractText(response);
    console.log(`[extraction:gemini-vision] scanned PDF extraction complete: ${text.length} chars`);
    return { text };
  }
}
