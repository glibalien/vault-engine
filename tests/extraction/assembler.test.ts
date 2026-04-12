import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';
import type Database from 'better-sqlite3';
import { parseEmbedReferences, assemble } from '../../src/extraction/assembler.js';

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

describe('parseEmbedReferences', () => {
  it('extracts ![[embed]] references', () => {
    const body = 'Some text ![[image.png]] more text ![[recording.m4a]]';
    expect(parseEmbedReferences(body)).toEqual(['image.png', 'recording.m4a']);
  });

  it('ignores regular [[wiki-links]]', () => {
    const body = 'See [[some note]] and ![[embed.png]]';
    expect(parseEmbedReferences(body)).toEqual(['embed.png']);
  });

  it('returns empty array for no embeds', () => {
    expect(parseEmbedReferences('plain text with no embeds')).toEqual([]);
    expect(parseEmbedReferences('')).toEqual([]);
  });

  it('handles aliases ![[file.png|300]]', () => {
    const body = '![[photo.png|300]] and ![[doc.pdf|my alias]]';
    expect(parseEmbedReferences(body)).toEqual(['photo.png', 'doc.pdf']);
  });
});

describe('assemble', () => {
  let db: Database.Database;
  let registry: ExtractorRegistry;
  let cache: ExtractionCache;
  let tmpDir: string;

  function seedNode(
    id: string,
    filePath: string,
    title: string | null,
    body: string | null,
    types?: string[],
  ): void {
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)',
    ).run(id, filePath, title, body);
    if (types) {
      const stmt = db.prepare(
        'INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)',
      );
      for (const t of types) {
        stmt.run(id, t);
      }
    }
  }

  beforeEach(() => {
    db = createTestDb();
    registry = new ExtractorRegistry();
    cache = new ExtractionCache(db, registry);
    tmpDir = mkdtempSync(join(tmpdir(), 'assembler-test-'));
  });

  it('assembles node with non-markdown embeds', async () => {
    seedNode('node-1', 'test.md', 'Test Node', 'Hello ![[recording.m4a]]');

    const audioFile = join(tmpDir, 'recording.m4a');
    writeFileSync(audioFile, 'fake audio data');

    registry.register(
      makeExtractor('audio-ext', 'audio', ['.m4a'], async () => ({
        text: 'transcribed audio',
      })),
    );

    const result = await assemble(db, 'node-1', cache, tmpDir);

    expect(result.node.title).toBe('Test Node');
    expect(result.body).toBe('Hello ![[recording.m4a]]');
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].reference).toBe('recording.m4a');
    expect(result.embeds[0].mediaType).toBe('audio');
    expect(result.embeds[0].text).toBe('transcribed audio');
    expect(result.errors).toHaveLength(0);
  });

  it('reports errors for failed extractions', async () => {
    seedNode(
      'node-2',
      'test2.md',
      'Test 2',
      '![[audio.m4a]]\n![[doc.md]]',
    );
    seedNode('doc-node', 'doc.md', 'doc', 'Document content');

    const audioFile = join(tmpDir, 'audio.m4a');
    writeFileSync(audioFile, 'fake audio');

    // Register audio as unavailable
    registry.registerUnavailable('deepgram', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');

    // Register markdown extractor
    registry.register(
      makeExtractor('md-ext', 'markdown', ['.md'], async () => ({
        text: 'markdown text',
      })),
    );

    // Create the markdown file on disk
    writeFileSync(join(tmpDir, 'doc.md'), 'Document content');

    const result = await assemble(db, 'node-2', cache, tmpDir);

    // Should have the markdown embed
    const mdEmbed = result.embeds.find((e) => e.reference === 'doc.md');
    expect(mdEmbed).toBeDefined();
    expect(mdEmbed!.mediaType).toBe('markdown');

    // Should have the audio error
    const audioError = result.errors.find((e) => e.reference === 'audio.m4a');
    expect(audioError).toBeDefined();
    expect(audioError!.error).toContain('EXTRACTOR_UNAVAILABLE');
  });

  it('handles recursive markdown embeds', async () => {
    seedNode(
      'node-a',
      'main.md',
      'Main Note',
      'Start ![[Sub-note]]',
      ['article'],
    );
    seedNode(
      'node-b',
      'notes/sub.md',
      'Sub-note',
      'Sub content ![[photo.png]]',
    );

    // Create files on disk
    writeFileSync(join(tmpDir, 'main.md'), 'Start ![[Sub-note]]');
    mkdirSync(join(tmpDir, 'notes'), { recursive: true });
    writeFileSync(join(tmpDir, 'notes', 'sub.md'), 'Sub content ![[photo.png]]');
    writeFileSync(join(tmpDir, 'photo.png'), 'fake png');

    // Register markdown extractor
    registry.register(
      makeExtractor('md-ext', 'markdown', ['.md'], async () => ({
        text: 'sub note markdown',
      })),
    );

    // Register image extractor
    registry.register(
      makeExtractor('img-ext', 'image', ['.png'], async () => ({
        text: 'image description',
      })),
    );

    const result = await assemble(db, 'node-a', cache, tmpDir);

    expect(result.embeds.length).toBe(2);

    const mdEmbed = result.embeds.find((e) => e.mediaType === 'markdown');
    expect(mdEmbed).toBeDefined();
    expect(mdEmbed!.reference).toBe('Sub-note');

    const imgEmbed = result.embeds.find((e) => e.mediaType === 'image');
    expect(imgEmbed).toBeDefined();
    expect(imgEmbed!.reference).toBe('photo.png');
    expect(imgEmbed!.source).toBe('Sub-note');
  });

  it('detects cycles without infinite loop', async () => {
    seedNode('node-a', 'a.md', 'Note A', 'Content ![[Note B]]');
    seedNode('node-b', 'b.md', 'Note B', 'Content ![[Note A]]');

    writeFileSync(join(tmpDir, 'a.md'), 'Content ![[Note B]]');
    writeFileSync(join(tmpDir, 'b.md'), 'Content ![[Note A]]');

    registry.register(
      makeExtractor('md-ext', 'markdown', ['.md'], async () => ({
        text: 'md text',
      })),
    );

    const result = await assemble(db, 'node-a', cache, tmpDir);

    // Should complete without hanging, and have at least one embed
    expect(result.embeds.length).toBeGreaterThanOrEqual(1);
    // Should not have infinite embeds
    expect(result.embeds.length).toBeLessThanOrEqual(2);
  });

  it('enforces maxEmbeds limit', async () => {
    seedNode(
      'node-many',
      'many.md',
      'Many Embeds',
      '![[a.png]] ![[b.png]] ![[c.png]] ![[d.png]] ![[e.png]]',
    );

    for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']) {
      writeFileSync(join(tmpDir, name), `fake ${name}`);
    }

    registry.register(
      makeExtractor('img-ext', 'image', ['.png'], async () => ({
        text: 'img text',
      })),
    );

    const result = await assemble(db, 'node-many', cache, tmpDir, {
      maxEmbeds: 3,
    });

    expect(result.embeds).toHaveLength(3);
    const truncatedError = result.errors.find((e) => e.error === 'TRUNCATED');
    expect(truncatedError).toBeDefined();
  });

  it('enforces file size limit', async () => {
    seedNode('node-big', 'big.md', 'Big File', '![[huge.bin]]');

    const hugeFile = join(tmpDir, 'huge.bin');
    // Write a file bigger than our limit
    writeFileSync(hugeFile, Buffer.alloc(2048));

    registry.register(
      makeExtractor('bin-ext', 'binary', ['.bin'], async () => ({
        text: 'bin text',
      })),
    );

    const result = await assemble(db, 'node-big', cache, tmpDir, {
      maxFileSizeBytes: 1024,
    });

    expect(result.embeds).toHaveLength(0);
    const sizeError = result.errors.find((e) =>
      e.error.includes('FILE_TOO_LARGE'),
    );
    expect(sizeError).toBeDefined();
    expect(sizeError!.reference).toBe('huge.bin');
  });
});
