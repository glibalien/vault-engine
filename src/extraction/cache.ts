import { readFileSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ExtractorRegistry } from './registry.js';
import type { Extractor, CachedExtraction } from './types.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface ExtractionCacheRow {
  content_hash: string;
  file_path: string;
  media_type: string;
  extractor_id: string;
  extracted_text: string;
  metadata_json: string | null;
  extracted_at: string;
}

export class ExtractionCache {
  private pdfFallback: Extractor | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ExtractorRegistry,
  ) {}

  setPdfFallback(extractor: Extractor): void {
    this.pdfFallback = extractor;
  }

  async getExtraction(filePath: string): Promise<CachedExtraction> {
    const ext = extname(filePath).toLowerCase();

    // Look up extractor
    const extractor = this.registry.getForExtension(ext);
    if (extractor === null) {
      const unavailableReason = this.registry.getUnavailableReason(ext);
      if (unavailableReason !== null) {
        throw new Error(`EXTRACTOR_UNAVAILABLE: ${unavailableReason}`);
      }
      throw new Error(`No extractor registered for ${ext}`);
    }

    // Hash the file
    const fileBuffer = readFileSync(filePath);
    const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

    // Check cache
    const cached = this.db
      .prepare('SELECT * FROM extraction_cache WHERE content_hash = ?')
      .get(contentHash) as ExtractionCacheRow | undefined;

    const name = basename(filePath);
    const fileSize = formatSize(fileBuffer.length);

    if (cached !== undefined) {
      console.log(`[extraction] cache hit: ${name} (${cached.extractor_id}, ${formatSize(cached.extracted_text.length)} text)`);
      return {
        text: cached.extracted_text,
        metadata: cached.metadata_json !== null ? JSON.parse(cached.metadata_json) : null,
        mediaType: cached.media_type,
        extractorId: cached.extractor_id,
        contentHash: cached.content_hash,
      };
    }

    // Cache miss — extract
    console.log(`[extraction] cache miss: ${name} (${fileSize}) → extracting with ${extractor.id}`);
    const startTime = Date.now();
    let result = await extractor.extract(filePath);
    let usedExtractor = extractor;
    const elapsed = Date.now() - startTime;

    // PDF fallback: if avgCharsPerPage < 50 and fallback is set
    if (
      ext === '.pdf' &&
      this.pdfFallback !== null &&
      typeof result.metadata === 'object' &&
      result.metadata !== null &&
      'avgCharsPerPage' in result.metadata &&
      typeof (result.metadata as Record<string, unknown>).avgCharsPerPage === 'number' &&
      ((result.metadata as Record<string, unknown>).avgCharsPerPage as number) < 50
    ) {
      console.log(`[extraction] PDF sparse text (${(result.metadata as Record<string, unknown>).avgCharsPerPage} chars/page) → falling back to ${this.pdfFallback.id}`);
      const fallbackStart = Date.now();
      result = await this.pdfFallback.extract(filePath);
      usedExtractor = this.pdfFallback;
      console.log(`[extraction] PDF fallback complete: ${name} → ${formatSize(result.text.length)} text in ${Date.now() - fallbackStart}ms`);
    }

    console.log(`[extraction] extracted: ${name} via ${usedExtractor.id} → ${formatSize(result.text.length)} text in ${elapsed}ms`);

    // Store in cache
    const metadataJson = result.metadata !== undefined ? JSON.stringify(result.metadata) : null;
    const extractedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO extraction_cache
          (content_hash, file_path, media_type, extractor_id, extracted_text, metadata_json, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(contentHash, filePath, usedExtractor.mediaType, usedExtractor.id, result.text, metadataJson, extractedAt);

    console.log(`[extraction] cached: ${name} (hash ${contentHash.slice(0, 8)}…)`);

    return {
      text: result.text,
      metadata: result.metadata ?? null,
      mediaType: usedExtractor.mediaType,
      extractorId: usedExtractor.id,
      contentHash,
    };
  }
}
