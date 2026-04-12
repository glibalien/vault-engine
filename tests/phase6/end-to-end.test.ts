import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { assemble } from '../../src/extraction/assembler.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let dir: string;

// Helper to make mock extractors
function makeExtractor(
  id: string,
  mediaType: string,
  extensions: string[],
  fn?: (fp: string) => Promise<ExtractionResult>,
): Extractor {
  return {
    id,
    mediaType,
    supportedExtensions: extensions,
    extract:
      fn ??
      (async (fp) => {
        const { readFileSync } = await import('node:fs');
        return { text: readFileSync(fp, 'utf-8') };
      }),
  };
}

// Helper to seed a node into the DB
function seedNode(
  id: string,
  filePath: string,
  title: string | null,
  body: string | null,
  types?: string[],
  fields?: Record<string, string | number | string[]>,
): void {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, filePath, title, body, null, null, null);

  if (types && types.length > 0) {
    const stmt = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
    for (const t of types) {
      stmt.run(id, t);
    }
  }

  if (fields) {
    const stmt = db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [name, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        stmt.run(id, name, null, null, null, JSON.stringify(value));
      } else if (typeof value === 'number') {
        stmt.run(id, name, null, value, null, null);
      } else {
        stmt.run(id, name, value, null, null, null);
      }
    }
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  dir = mkdtempSync(join(tmpdir(), 'phase6-e2e-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Phase 6 end-to-end: full extraction stack', () => {
  it('full meeting node scenario — all 3 embeds extracted with correct mediaType/text', async () => {
    // Create the meeting node body referencing audio, image, and markdown
    const body = '![[recording.m4a]]\n![[whiteboard.png]]\n![[action-items.md]]';
    seedNode('meeting-1', 'meeting.md', 'Team Meeting', body, ['meeting'], {
      people_involved: ['Alice', 'Bob'],
    });

    // Seed the markdown embed as a node so the resolver can find it
    seedNode('action-1', 'action-items.md', 'action-items', 'Fix bug\nWrite tests');

    // Create files on disk
    writeFileSync(join(dir, 'recording.m4a'), 'fake audio bytes');
    writeFileSync(join(dir, 'whiteboard.png'), 'fake png bytes');
    writeFileSync(join(dir, 'action-items.md'), 'Fix bug\nWrite tests');

    // Build registry with mock extractors
    const registry = new ExtractorRegistry();

    // Mock audio extractor — returns diarized transcript
    registry.register(
      makeExtractor('deepgram-mock', 'audio', ['.m4a'], async () => ({
        text: 'Alice: We need to ship phase 6. Bob: Agreed.',
        metadata: { speakers: ['Alice', 'Bob'] },
      })),
    );

    // Mock image extractor — returns description
    registry.register(
      makeExtractor('vision-mock', 'image', ['.png'], async () => ({
        text: 'Whiteboard diagram showing system architecture',
      })),
    );

    // Real markdown extractor
    const { MarkdownExtractor } = await import('../../src/extraction/extractors/markdown.js');
    registry.register(new MarkdownExtractor());

    const cache = new ExtractionCache(db, registry);
    const result = await assemble(db, 'meeting-1', cache, dir);

    // Node metadata
    expect(result.node.title).toBe('Team Meeting');
    expect(result.node.types).toContain('meeting');
    expect(result.node.fields['people_involved']).toEqual(['Alice', 'Bob']);

    // All 3 embeds present
    expect(result.embeds).toHaveLength(3);
    expect(result.errors).toHaveLength(0);

    const audioEmbed = result.embeds.find((e) => e.reference === 'recording.m4a');
    expect(audioEmbed).toBeDefined();
    expect(audioEmbed!.mediaType).toBe('audio');
    expect(audioEmbed!.text).toContain('Alice');

    const imageEmbed = result.embeds.find((e) => e.reference === 'whiteboard.png');
    expect(imageEmbed).toBeDefined();
    expect(imageEmbed!.mediaType).toBe('image');
    expect(imageEmbed!.text).toContain('Whiteboard');

    const mdEmbed = result.embeds.find((e) => e.reference === 'action-items.md');
    expect(mdEmbed).toBeDefined();
    expect(mdEmbed!.mediaType).toBe('markdown');
    expect(mdEmbed!.text).toContain('Fix bug');
  });

  it('graceful degradation — missing API key shows EXTRACTOR_UNAVAILABLE, markdown still works', async () => {
    const body = '![[audio.m4a]]\n![[notes.md]]';
    seedNode('node-degrade', 'main.md', 'Degraded Node', body);

    // Seed markdown node for resolver
    seedNode('notes-node', 'notes.md', 'notes', 'Meeting notes content');

    // Create files on disk
    writeFileSync(join(dir, 'audio.m4a'), 'fake audio');
    writeFileSync(join(dir, 'notes.md'), 'Meeting notes content');

    const registry = new ExtractorRegistry();

    // Audio is unavailable — missing API key
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');

    // Markdown works fine
    const { MarkdownExtractor } = await import('../../src/extraction/extractors/markdown.js');
    registry.register(new MarkdownExtractor());

    const cache = new ExtractionCache(db, registry);
    const result = await assemble(db, 'node-degrade', cache, dir);

    // Markdown embed succeeds
    const mdEmbed = result.embeds.find((e) => e.reference === 'notes.md');
    expect(mdEmbed).toBeDefined();
    expect(mdEmbed!.mediaType).toBe('markdown');
    expect(mdEmbed!.text).toContain('Meeting notes content');

    // Audio embed fails with EXTRACTOR_UNAVAILABLE
    expect(result.errors).toHaveLength(1);
    const audioError = result.errors.find((e) => e.reference === 'audio.m4a');
    expect(audioError).toBeDefined();
    expect(audioError!.error).toContain('EXTRACTOR_UNAVAILABLE');
    expect(audioError!.error).toContain('DEEPGRAM_API_KEY');
  });

  it('cache hit — second assemble call does not re-extract', async () => {
    const body = '![[doc.md]]';
    seedNode('node-cache', 'cached.md', 'Cached Node', body);
    seedNode('doc-node', 'doc.md', 'doc', 'Document body text');

    writeFileSync(join(dir, 'doc.md'), 'Document body text');

    let extractCount = 0;
    const registry = new ExtractorRegistry();
    registry.register(
      makeExtractor('counting-md', 'markdown', ['.md'], async (fp) => {
        extractCount++;
        const { readFileSync } = await import('node:fs');
        return { text: readFileSync(fp, 'utf-8') };
      }),
    );

    const cache = new ExtractionCache(db, registry);

    // First call — extracts
    const first = await assemble(db, 'node-cache', cache, dir);
    expect(first.embeds).toHaveLength(1);
    expect(extractCount).toBe(1);

    // Second call — should hit cache
    const second = await assemble(db, 'node-cache', cache, dir);
    expect(second.embeds).toHaveLength(1);
    expect(extractCount).toBe(1); // Still 1 — no re-extraction
  });

  it('extraction_cache table populated correctly after assemble', async () => {
    const body = '![[file.md]]';
    seedNode('node-db', 'main.md', 'DB Check Node', body);
    seedNode('file-node', 'file.md', 'file', 'Cached file content');

    writeFileSync(join(dir, 'file.md'), 'Cached file content');

    const registry = new ExtractorRegistry();
    registry.register(
      makeExtractor('md-extractor', 'markdown', ['.md'], async () => ({
        text: 'Cached file content',
      })),
    );

    const cache = new ExtractionCache(db, registry);
    await assemble(db, 'node-db', cache, dir);

    // Query the extraction_cache table
    const rows = db
      .prepare('SELECT * FROM extraction_cache')
      .all() as {
        content_hash: string;
        file_path: string;
        media_type: string;
        extractor_id: string;
        extracted_text: string;
        metadata_json: string | null;
        extracted_at: string;
      }[];

    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.media_type).toBe('markdown');
    expect(row.extractor_id).toBe('md-extractor');
    expect(row.extracted_text).toBe('Cached file content');

    // extracted_at should be a valid ISO 8601 timestamp
    expect(row.extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const parsed = new Date(row.extracted_at);
    expect(isNaN(parsed.getTime())).toBe(false);

    // content_hash should be a 64-char hex string
    expect(row.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
