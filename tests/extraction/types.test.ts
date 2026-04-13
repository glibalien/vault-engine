import { describe, it, expect } from 'vitest';
import type {
  Extractor,
  ExtractionResult,
  CachedExtraction,
  EmbedEntry,
  EmbedError,
  AssembledNode,
} from '../../src/extraction/types.js';

describe('ExtractionResult', () => {
  it('accepts text only', () => {
    const result: ExtractionResult = { text: 'hello world' };
    expect(result.text).toBe('hello world');
    expect(result.metadata).toBeUndefined();
  });

  it('accepts text with metadata', () => {
    const result: ExtractionResult = { text: 'hello', metadata: { confidence: 0.95 } };
    expect(result.metadata).toEqual({ confidence: 0.95 });
  });
});

describe('CachedExtraction', () => {
  it('holds all required fields', () => {
    const cached: CachedExtraction = {
      text: 'transcribed audio',
      metadata: { duration: 120 },
      mediaType: 'audio',
      extractorId: 'deepgram-nova-3',
      contentHash: 'abc123',
    };
    expect(cached.text).toBe('transcribed audio');
    expect(cached.mediaType).toBe('audio');
    expect(cached.extractorId).toBe('deepgram-nova-3');
    expect(cached.contentHash).toBe('abc123');
    expect(cached.metadata).toEqual({ duration: 120 });
  });

  it('accepts null metadata', () => {
    const cached: CachedExtraction = {
      text: 'text',
      metadata: null,
      mediaType: 'audio',
      extractorId: 'deepgram-nova-3',
      contentHash: 'def456',
    };
    expect(cached.metadata).toBeNull();
  });
});

describe('EmbedEntry', () => {
  it('accepts required fields', () => {
    const entry: EmbedEntry = {
      reference: '![[audio.m4a]]',
      mediaType: 'audio',
      text: 'extracted text',
    };
    expect(entry.reference).toBe('![[audio.m4a]]');
    expect(entry.mediaType).toBe('audio');
    expect(entry.text).toBe('extracted text');
    expect(entry.source).toBeUndefined();
  });

  it('accepts optional source', () => {
    const entry: EmbedEntry = {
      reference: '![[audio.m4a]]',
      mediaType: 'audio',
      text: 'extracted text',
      source: 'cache',
    };
    expect(entry.source).toBe('cache');
  });
});

describe('EmbedError', () => {
  it('holds reference and error message', () => {
    const err: EmbedError = {
      reference: '![[missing.mp3]]',
      error: 'File not found',
    };
    expect(err.reference).toBe('![[missing.mp3]]');
    expect(err.error).toBe('File not found');
  });
});

describe('AssembledNode', () => {
  it('holds full node structure with embeds and errors', () => {
    const assembled: AssembledNode = {
      node: {
        title: 'My Note',
        types: ['note', 'audio-note'],
        fields: { date: '2026-04-12' },
      },
      body: 'Some body text',
      embeds: [
        { reference: '![[audio.m4a]]', mediaType: 'audio', text: 'spoken words' },
      ],
      errors: [
        { reference: '![[broken.mp3]]', error: 'Extraction failed' },
      ],
    };
    expect(assembled.node.title).toBe('My Note');
    expect(assembled.node.types).toEqual(['note', 'audio-note']);
    expect(assembled.node.fields).toEqual({ date: '2026-04-12' });
    expect(assembled.body).toBe('Some body text');
    expect(assembled.embeds).toHaveLength(1);
    expect(assembled.errors).toHaveLength(1);
  });

  it('accepts null title and null body', () => {
    const assembled: AssembledNode = {
      node: { title: null, types: [], fields: {} },
      body: null,
      embeds: [],
      errors: [],
    };
    expect(assembled.node.title).toBeNull();
    expect(assembled.body).toBeNull();
  });

  it('accepts empty embeds and errors arrays', () => {
    const assembled: AssembledNode = {
      node: { title: 'Test', types: [], fields: {} },
      body: null,
      embeds: [],
      errors: [],
    };
    expect(assembled.embeds).toHaveLength(0);
    expect(assembled.errors).toHaveLength(0);
  });
});

describe('Extractor', () => {
  it('can be implemented as a plain object', async () => {
    const extractor: Extractor = {
      id: 'deepgram-nova-3',
      mediaType: 'audio',
      supportedExtensions: ['.m4a', '.mp3'],
      extract: async (_filePath: string): Promise<ExtractionResult> => ({
        text: 'mock transcription',
      }),
    };
    expect(extractor.id).toBe('deepgram-nova-3');
    expect(extractor.mediaType).toBe('audio');
    expect(extractor.supportedExtensions).toEqual(['.m4a', '.mp3']);
    const result = await extractor.extract('/tmp/test.m4a');
    expect(result.text).toBe('mock transcription');
  });
});
