import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import type { EmbeddingQueueItem, SearchIndexStatus } from './types.js';
import type { Embedder } from './embedder.js';
import { resolveEmbedRef } from '../extraction/resolve.js';
import type { ExtractionCache } from '../extraction/cache.js';
import { parseEmbedReferences } from '../extraction/assembler.js';

export interface EmbeddingIndexer {
  enqueue(item: EmbeddingQueueItem): void;
  processOne(): Promise<boolean>;
  processAll(): Promise<number>;
  assembleContent(nodeId: string): string;
  contentHash(nodeId: string): string;
  getStatus(): SearchIndexStatus;
  removeNode(nodeId: string): void;
  clearAll(): void;
  queueSize(): number;
}

interface NodeRow {
  title: string | null;
  body: string | null;
}

interface FieldRow {
  field_name: string;
  value_text: string;
}

interface CountRow {
  cnt: number;
}

export interface EmbeddingIndexerDeps {
  extractionCache?: ExtractionCache;
  vaultPath?: string;
}

export function createEmbeddingIndexer(
  db: Database.Database,
  embedder: Embedder,
  deps?: EmbeddingIndexerDeps
): EmbeddingIndexer {
  // Prepared statements created once in closure
  const stmtGetNode = db.prepare<[string], NodeRow>(
    'SELECT title, body FROM nodes WHERE id = ?'
  );

  const stmtGetStringFields = db.prepare<[string], FieldRow>(
    'SELECT field_name, value_text FROM node_fields WHERE node_id = ? AND value_text IS NOT NULL'
  );

  // extraction_ref IS ? (not = ?) handles NULL comparison correctly in SQL
  const stmtGetAnyHashForGroup = db.prepare<[string, string, string | null], { source_hash: string }>(
    `SELECT source_hash FROM embedding_meta
     WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?
     LIMIT 1`
  );

  const stmtDeleteVecByGroup = db.prepare<[string, string, string | null], void>(
    `DELETE FROM embedding_vec WHERE id IN (
       SELECT id FROM embedding_meta
       WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?
     )`
  );

  const stmtDeleteMetaByGroup = db.prepare<[string, string, string | null], void>(
    `DELETE FROM embedding_meta
     WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?`
  );

  const stmtInsertMeta = db.prepare(
    `INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const stmtInsertVec = db.prepare<[bigint, Uint8Array], void>(
    'INSERT INTO embedding_vec (id, vector) VALUES (?, ?)'
  );

  const stmtDeleteVecByNode = db.prepare<[string], void>(
    `DELETE FROM embedding_vec WHERE id IN (
       SELECT id FROM embedding_meta WHERE node_id = ?
     )`
  );

  const stmtDeleteMetaByNode = db.prepare<[string], void>(
    'DELETE FROM embedding_meta WHERE node_id = ?'
  );

  const stmtClearVec = db.prepare<[], void>('DELETE FROM embedding_vec');
  const stmtClearMeta = db.prepare<[], void>('DELETE FROM embedding_meta');

  // Atomic delete-then-insert of an entire chunk group. Wrapping this in a
  // transaction prevents partial state (e.g. mid-loop insert failure) that
  // would otherwise be indistinguishable from a fully-indexed group on retry,
  // because the hash check succeeds once any row for the group exists.
  const writeGroup = db.transaction((
    nodeId: string,
    sourceType: string,
    extractionRef: string | null,
    hash: string,
    vectors: Float32Array[],
    now: string,
  ) => {
    stmtDeleteVecByGroup.run(nodeId, sourceType, extractionRef);
    stmtDeleteMetaByGroup.run(nodeId, sourceType, extractionRef);
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const res = stmtInsertMeta.run(nodeId, sourceType, hash, i, extractionRef, now);
      stmtInsertVec.run(BigInt(res.lastInsertRowid), bytes);
    }
  });

  const stmtCountNodes = db.prepare<[], CountRow>('SELECT COUNT(*) as cnt FROM nodes');
  const stmtCountIndexed = db.prepare<[], CountRow>(
    "SELECT COUNT(DISTINCT node_id) as cnt FROM embedding_meta WHERE source_type = 'node'"
  );

  const stmtExtractionCacheExists = db.prepare<[], { cnt: number }>(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
  );

  const stmtCountExtractions = db.prepare<[], CountRow>(
    'SELECT COUNT(*) as cnt FROM extraction_cache'
  );

  const stmtCountExtractionsIndexed = db.prepare<[], CountRow>(
    "SELECT COUNT(DISTINCT node_id) as cnt FROM embedding_meta WHERE source_type = 'extraction'"
  );

  // In-memory queue
  const queue: EmbeddingQueueItem[] = [];
  let processing = false;

  function itemKey(item: EmbeddingQueueItem): string {
    return `${item.node_id}::${item.source_type}::${item.extraction_ref ?? ''}`;
  }

  function isLikelyMarkdownRef(ref: string): boolean {
    const dot = ref.lastIndexOf('.');
    if (dot === -1) return true; // no extension → treat as md
    return ref.slice(dot).toLowerCase() === '.md';
  }

  function assembleContent(nodeId: string): string {
    const node = stmtGetNode.get(nodeId);
    if (!node) return '';

    const parts: string[] = [];
    if (node.title) parts.push(node.title);
    if (node.body) parts.push(node.body);

    const fields = stmtGetStringFields.all(nodeId);
    for (const field of fields) {
      parts.push(field.value_text);
    }

    return parts.join('\n\n');
  }

  function contentHash(nodeId: string): string {
    const content = assembleContent(nodeId);
    return createHash('sha256').update(content).digest('hex');
  }

  function enqueue(item: EmbeddingQueueItem): void {
    const key = itemKey(item);
    if (!queue.some(q => itemKey(q) === key)) {
      queue.push(item);
    }

    if (item.source_type === 'node' && deps?.extractionCache && deps?.vaultPath) {
      const row = stmtGetNode.get(item.node_id);
      if (row && row.body) {
        const refs = parseEmbedReferences(row.body);
        for (const ref of refs) {
          if (isLikelyMarkdownRef(ref)) continue;
          const extractionItem: EmbeddingQueueItem = {
            node_id: item.node_id,
            source_type: 'extraction',
            extraction_ref: ref,
          };
          const extKey = itemKey(extractionItem);
          if (!queue.some(q => itemKey(q) === extKey)) {
            queue.push(extractionItem);
          }
        }
      }
    }
  }

  async function processOne(): Promise<boolean> {
    const item = queue.shift();
    if (!item) return false;

    processing = true;
    try {
      if (item.source_type === 'node') {
        const extractionRef = item.extraction_ref ?? null;
        const content = assembleContent(item.node_id);
        const hash = createHash('sha256').update(content).digest('hex');
        const existing = stmtGetAnyHashForGroup.get(item.node_id, item.source_type, extractionRef);
        if (existing && existing.source_hash === hash) return true;

        const vectors = await embedder.embedDocument(content);
        const now = new Date().toISOString();

        writeGroup(item.node_id, item.source_type, extractionRef, hash, vectors, now);
      }

      if (item.source_type === 'extraction') {
        if (!deps?.extractionCache || !deps?.vaultPath || !item.extraction_ref) {
          return true;
        }

        // resolveEmbedRef may throw on path traversal (safeVaultPath guard). Treat
        // traversal attempts the same as unresolvable refs — silently no-op.
        let resolved: Awaited<ReturnType<typeof resolveEmbedRef>> = null;
        try {
          resolved = await resolveEmbedRef(db, deps.vaultPath, item.extraction_ref);
        } catch {
          return true;
        }
        if (!resolved || resolved.isMarkdown) return true;

        const extraction = await deps.extractionCache.getExtraction(resolved.filePath);
        const text = extraction.text ?? '';
        if (text.length === 0) return true;

        const hash = createHash('sha256').update(text).digest('hex');
        const extractionRef = item.extraction_ref;
        const existing = stmtGetAnyHashForGroup.get(item.node_id, 'extraction', extractionRef);
        if (existing && existing.source_hash === hash) return true;

        const vectors = await embedder.embedDocument(text);
        const now = new Date().toISOString();
        writeGroup(item.node_id, 'extraction', extractionRef, hash, vectors, now);
      }

      return true;
    } catch (err) {
      const retries = (item.retries ?? 0) + 1;
      if (retries < 3) {
        console.warn(`[embedding-indexer] embed failed for ${item.node_id} (attempt ${retries}), requeueing:`, err);
        queue.push({ ...item, retries });
      } else {
        console.error(`[embedding-indexer] embed failed for ${item.node_id} after 3 attempts, dropping:`, err);
      }
      return false;
    } finally {
      processing = false;
    }
  }

  async function processAll(): Promise<number> {
    let count = 0;
    while (queue.length > 0) {
      const processed = await processOne();
      if (processed) count++;
    }
    return count;
  }

  function getStatus(): SearchIndexStatus {
    const nodesTotal = (stmtCountNodes.get() as CountRow).cnt;
    const nodesIndexed = (stmtCountIndexed.get() as CountRow).cnt;
    const extractionCacheExists = ((stmtExtractionCacheExists.get() as { cnt: number }).cnt) > 0;

    let extractionsTotal = 0;
    let extractionsIndexed = 0;

    if (extractionCacheExists) {
      extractionsTotal = (stmtCountExtractions.get() as CountRow).cnt;
      extractionsIndexed = (stmtCountExtractionsIndexed.get() as CountRow).cnt;
    }

    const status = !embedder.isReady() ? 'disabled' as const
      : queue.length > 0 || processing ? 'indexing' as const
      : 'ready' as const;

    return {
      status,
      nodes_total: nodesTotal,
      nodes_indexed: nodesIndexed,
      extractions_total: extractionsTotal,
      extractions_indexed: extractionsIndexed,
      pending: queue.length,
    };
  }

  function removeNode(nodeId: string): void {
    // Delete vec rows FIRST (they reference meta IDs via subquery), then meta rows
    stmtDeleteVecByNode.run(nodeId);
    stmtDeleteMetaByNode.run(nodeId);
  }

  function clearAll(): void {
    stmtClearVec.run();
    stmtClearMeta.run();
    queue.length = 0;
  }

  function queueSize(): number {
    return queue.length;
  }

  return {
    enqueue,
    processOne,
    processAll,
    assembleContent,
    contentHash,
    getStatus,
    removeNode,
    clearAll,
    queueSize,
  };
}
