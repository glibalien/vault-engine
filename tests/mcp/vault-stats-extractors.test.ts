import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getVaultStatsHandler(registry?: ExtractorRegistry) {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerVaultStats(fakeServer, db, registry);
  return capturedHandler!;
}

function createMockExtractor(id: string, ext: string): Extractor {
  return {
    id,
    mediaType: 'text/plain',
    supportedExtensions: [ext],
    async extract(_filePath: string): Promise<ExtractionResult> {
      return { text: 'mock' };
    },
  };
}

beforeEach(() => {
  db = createTestDb();
});

describe('vault-stats extractor status', () => {
  it('includes extractors section when registry is provided', async () => {
    const registry = new ExtractorRegistry();
    registry.register(createMockExtractor('csv-extractor', '.csv'));
    registry.registerUnavailable('deepgram', 'audio', ['.m4a', '.mp3'], 'DEEPGRAM_API_KEY');

    const handler = getVaultStatsHandler(registry);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.extractors).toBeDefined();
    expect(Array.isArray(result.extractors.active)).toBe(true);
    expect(Array.isArray(result.extractors.unavailable)).toBe(true);

    expect(result.extractors.active).toHaveLength(1);
    expect(result.extractors.active[0].id).toBe('csv-extractor');

    expect(result.extractors.unavailable).toHaveLength(1);
    expect(result.extractors.unavailable[0].id).toBe('deepgram');
    expect(result.extractors.unavailable[0].missingKey).toBe('DEEPGRAM_API_KEY');
  });

  it('omits extractors property when registry is not provided (backward compat)', async () => {
    const handler = getVaultStatsHandler(undefined);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.extractors).toBeUndefined();
    // Core stats still present
    expect(result.node_count).toBe(0);
    expect(result.schema_count).toBe(0);
  });

  it('shows empty active and unavailable arrays when registry has no registrations', async () => {
    const registry = new ExtractorRegistry();

    const handler = getVaultStatsHandler(registry);
    const body = parseResult(await handler({}) as any) as any;
    expect(body.ok).toBe(true);
    const result = body.data;

    expect(result.extractors).toBeDefined();
    expect(result.extractors.active).toEqual([]);
    expect(result.extractors.unavailable).toEqual([]);
  });
});
