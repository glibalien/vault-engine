import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let tmpDir: string;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getGetNodeHandler(extractionCache?: ExtractionCache, vaultPath?: string) {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerGetNode(fakeServer, db, extractionCache, vaultPath);
  return capturedHandler!;
}

function createMockAudioExtractor(): Extractor {
  return {
    id: 'mock-audio',
    mediaType: 'audio',
    supportedExtensions: ['.m4a', '.mp3'],
    async extract(_filePath: string): Promise<ExtractionResult> {
      return { text: 'Transcribed audio content' };
    },
  };
}

beforeEach(() => {
  db = createTestDb();
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedNode(id: string, filePath: string, title: string, body: string) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, 1000, 2000);
}

describe('get-node include_embeds', () => {
  it('includes embeds when include_embeds is true', async () => {
    seedNode('n1', 'notes/note.md', 'Test Note', 'Some text\n![[rec.m4a]]\nMore text');

    // Create the audio file in the temp dir (acts as vault root)
    writeFileSync(join(tmpDir, 'rec.m4a'), Buffer.from('fake audio data'));

    const registry = new ExtractorRegistry();
    registry.register(createMockAudioExtractor());
    const cache = new ExtractionCache(db, registry);

    const handler = getGetNodeHandler(cache, tmpDir);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;

    expect(result.embeds).toBeDefined();
    expect(Array.isArray(result.embeds)).toBe(true);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].reference).toBe('rec.m4a');
    expect(result.embeds[0].mediaType).toBe('audio');
    expect(result.embeds[0].text).toBe('Transcribed audio content');
    expect(result.embed_errors).toBeDefined();
    expect(result.embed_errors).toHaveLength(0);
  });

  it('defaults include_embeds to true and returns empty embeds for node with no embed refs', async () => {
    seedNode('n1', 'notes/note.md', 'Test Note', 'Plain body text with no embeds');

    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);

    const handler = getGetNodeHandler(cache, tmpDir);
    // No include_embeds param — should default to true
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;

    expect(result.embeds).toBeDefined();
    expect(result.embeds).toEqual([]);
    expect(result.embed_errors).toBeDefined();
    expect(result.embed_errors).toEqual([]);
  });

  it('omits embeds when include_embeds is false', async () => {
    seedNode('n1', 'notes/note.md', 'Test Note', 'Some text\n![[rec.m4a]]\nMore text');

    const registry = new ExtractorRegistry();
    registry.register(createMockAudioExtractor());
    const cache = new ExtractionCache(db, registry);

    const handler = getGetNodeHandler(cache, tmpDir);
    const result = parseResult(await handler({ node_id: 'n1', include_embeds: false }) as any) as any;

    expect(result.embeds).toBeUndefined();
    expect(result.embed_errors).toBeUndefined();
  });

  it('respects max_embeds parameter', async () => {
    // Create a node with 5 embed refs
    const body = [
      '![[audio1.m4a]]',
      '![[audio2.m4a]]',
      '![[audio3.m4a]]',
      '![[audio4.m4a]]',
      '![[audio5.m4a]]',
    ].join('\n');
    seedNode('n1', 'notes/note.md', 'Test Note', body);

    // Create all 5 audio files
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(tmpDir, `audio${i}.m4a`), Buffer.from(`fake audio ${i}`));
    }

    const registry = new ExtractorRegistry();
    registry.register(createMockAudioExtractor());
    const cache = new ExtractionCache(db, registry);

    const handler = getGetNodeHandler(cache, tmpDir);
    const result = parseResult(await handler({ node_id: 'n1', max_embeds: 2 }) as any) as any;

    expect(result.embeds).toHaveLength(2);
    // The remaining refs beyond the limit become errors (TRUNCATED)
    expect(result.embed_errors.length).toBeGreaterThan(0);
    const truncatedErrors = result.embed_errors.filter((e: any) => e.error === 'TRUNCATED');
    expect(truncatedErrors.length).toBeGreaterThan(0);
  });

  it('returns empty embeds when no cache is configured', async () => {
    seedNode('n1', 'notes/note.md', 'Test Note', 'Some text\n![[rec.m4a]]\nMore text');

    // No cache — handler called with only 2 args (backward-compatible)
    const handler = getGetNodeHandler(undefined, undefined);
    const result = parseResult(await handler({ node_id: 'n1' }) as any) as any;

    // include_embeds defaults to true but no cache => empty arrays
    expect(result.embeds).toEqual([]);
    expect(result.embed_errors).toEqual([]);
  });
});
