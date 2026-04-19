import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerReadEmbedded } from '../../src/mcp/tools/read-embedded.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let tmpDir: string;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getReadEmbeddedHandler(extractionCache: ExtractionCache, vaultPath: string) {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerReadEmbedded(fakeServer, db, extractionCache, vaultPath);
  return capturedHandler!;
}

function createMockCsvExtractor(): Extractor {
  return {
    id: 'mock-csv',
    mediaType: 'text/csv',
    supportedExtensions: ['.csv'],
    async extract(_filePath: string): Promise<ExtractionResult> {
      return { text: 'col1,col2\nval1,val2' };
    },
  };
}

function seedNode(id: string, filePath: string) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, `Title ${id}`, '', `hash-${id}`, 1000, 2000);
}

beforeEach(() => {
  db = createTestDb();
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-engine-read-embedded-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('read-embedded', () => {
  it('extracts content by file_path', async () => {
    writeFileSync(join(tmpDir, 'data.csv'), 'col1,col2\nval1,val2');

    const registry = new ExtractorRegistry();
    registry.register(createMockCsvExtractor());
    const cache = new ExtractionCache(db, registry);

    const handler = getReadEmbeddedHandler(cache, tmpDir);
    const body = parseResult(await handler({ file_path: 'data.csv' }) as any) as any;

    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(body.data.text).toBe('col1,col2\nval1,val2');
    expect(body.data.media_type).toBe('text/csv');
    expect(body.data.extractor_id).toBe('mock-csv');
    expect(body.data.content_hash).toBeDefined();
    expect(typeof body.data.content_hash).toBe('string');
  });

  it('resolves filename to unique node match', async () => {
    seedNode('n1', 'subfolder/data.csv');

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpDir, 'subfolder'), { recursive: true });
    writeFileSync(join(tmpDir, 'subfolder', 'data.csv'), 'a,b\n1,2');

    const registry = new ExtractorRegistry();
    registry.register(createMockCsvExtractor());
    const cache = new ExtractionCache(db, registry);

    const handler = getReadEmbeddedHandler(cache, tmpDir);
    const body = parseResult(await handler({ filename: 'data.csv' }) as any) as any;

    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(body.data.text).toBe('col1,col2\nval1,val2');
    expect(body.data.extractor_id).toBe('mock-csv');
  });

  it('returns AMBIGUOUS_FILENAME when multiple nodes share the same basename', async () => {
    seedNode('n1', 'folderA/data.csv');
    seedNode('n2', 'folderB/data.csv');

    const registry = new ExtractorRegistry();
    registry.register(createMockCsvExtractor());
    const cache = new ExtractionCache(db, registry);

    const handler = getReadEmbeddedHandler(cache, tmpDir);
    const body = parseResult(await handler({ filename: 'data.csv' }) as any) as any;

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('AMBIGUOUS_FILENAME');
    expect(body.error.message).toMatch(/Multiple files match/);
    expect(Array.isArray(body.error.details.matches)).toBe(true);
    expect(body.error.details.matches).toHaveLength(2);
    expect(body.error.details.matches).toContain('folderA/data.csv');
    expect(body.error.details.matches).toContain('folderB/data.csv');
  });

  it('returns INVALID_PARAMS when neither file_path nor filename is provided', async () => {
    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);

    const handler = getReadEmbeddedHandler(cache, tmpDir);
    const body = parseResult(await handler({}) as any) as any;

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
    expect(body.error.message).toMatch(/file_path or filename/);
  });

  it('returns INVALID_PARAMS when both file_path and filename are provided', async () => {
    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);

    const handler = getReadEmbeddedHandler(cache, tmpDir);
    const body = parseResult(await handler({ file_path: 'x.csv', filename: 'x.csv' }) as any) as any;

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
    expect(body.error.message).toMatch(/only one/);
  });

  it('returns EXTRACTOR_UNAVAILABLE for missing API key extractor', async () => {
    writeFileSync(join(tmpDir, 'audio.m4a'), Buffer.from('fake'));

    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    const cache = new ExtractionCache(db, registry);

    const handler = getReadEmbeddedHandler(cache, tmpDir);
    const body = parseResult(await handler({ file_path: 'audio.m4a' }) as any) as any;

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('EXTRACTOR_UNAVAILABLE');
    expect(body.error.message).toMatch(/EXTRACTOR_UNAVAILABLE/);
  });
});
