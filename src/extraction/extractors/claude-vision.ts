import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Extractor, ExtractionResult } from '../types.js';

const IMAGE_MEDIA_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> =
  {
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

export class ClaudeVisionImageExtractor implements Extractor {
  readonly id = 'claude-vision-image';
  readonly mediaType = 'image';
  readonly supportedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) {
      throw new Error(`Unsupported image format: ${ext}`);
    }

    const buffer = await readFile(filePath);
    const data = buffer.toString('base64');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data },
            },
            { type: 'text', text: IMAGE_PROMPT },
          ],
        },
      ],
    });

    const text =
      response.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('') ?? '';

    return { text };
  }
}

export class ClaudeVisionPdfExtractor implements Extractor {
  readonly id = 'claude-vision-pdf';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const data = buffer.toString('base64');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data },
            },
            { type: 'text', text: PDF_PROMPT },
          ],
        },
      ],
    });

    const text =
      response.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('') ?? '';

    return { text };
  }
}
