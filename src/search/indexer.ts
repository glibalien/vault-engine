import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import type { EmbeddingQueueItem, SearchIndexStatus } from './types.js';
import type { Embedder } from './embedder.js';

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

interface MetaRow {
  id: number;
  source_hash: string;
}

interface CountRow {
  cnt: number;
}

export function createEmbeddingIndexer(
  db: Database.Database,
  embedder: Embedder
): EmbeddingIndexer {
  // Prepared statements created once in closure
  const stmtGetNode = db.prepare<[string], NodeRow>(
    'SELECT title, body FROM nodes WHERE id = ?'
  );

  const stmtGetStringFields = db.prepare<[string], FieldRow>(
    'SELECT field_name, value_text FROM node_fields WHERE node_id = ? AND value_text IS NOT NULL'
  );

  // extraction_ref IS ? (not = ?) handles NULL comparison correctly in SQL
  const stmtGetExistingMeta = db.prepare<[string, string, string | null], MetaRow>(
    `SELECT id, source_hash FROM embedding_meta
     WHERE node_id = ? AND source_type = ? AND extraction_ref IS ?`
  );

  const stmtInsertMeta = db.prepare(
    `INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const stmtUpdateMeta = db.prepare<[string, string, number], void>(
    `UPDATE embedding_meta SET source_hash = ?, embedded_at = ? WHERE id = ?`
  );

  const stmtInsertVec = db.prepare<[bigint, Uint8Array], void>(
    'INSERT INTO embedding_vec (id, vector) VALUES (?, ?)'
  );

  const stmtUpdateVec = db.prepare<[Uint8Array, number], void>(
    'UPDATE embedding_vec SET vector = ? WHERE id = ?'
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
    const alreadyQueued = queue.some(q => itemKey(q) === key);
    if (!alreadyQueued) {
      queue.push(item);
    }
  }

  async function processOne(): Promise<boolean> {
    const item = queue.shift();
    if (!item) return false;

    processing = true;
    try {
      if (item.source_type === 'node') {
        const hash = contentHash(item.node_id);
        const extractionRef = item.extraction_ref ?? null;

        const existing = stmtGetExistingMeta.get(item.node_id, item.source_type, extractionRef);

        if (existing && existing.source_hash === hash) {
          // Content unchanged — skip embedding
          return true;
        }

        // Embed the content
        const content = assembleContent(item.node_id);
        const [vector] = await embedder.embedDocument(content);
        const vectorBytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        const now = new Date().toISOString();

        if (existing) {
          // Update existing rows
          stmtUpdateMeta.run(hash, now, existing.id);
          stmtUpdateVec.run(vectorBytes, existing.id);
        } else {
          // Insert new rows — use lastInsertRowid for the vec ID
          const insertResult = stmtInsertMeta.run(item.node_id, item.source_type, hash, 0, extractionRef, now);
          // sqlite-vec vec0 requires BigInt for explicit primary key values
          const metaId = BigInt(insertResult.lastInsertRowid);
          stmtInsertVec.run(metaId, vectorBytes);
        }
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
