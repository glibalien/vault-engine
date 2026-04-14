export interface EmbeddingMeta {
  id: number;
  node_id: string;
  source_type: 'node' | 'extraction';
  source_hash: string;
  chunk_index: number;
  extraction_ref: string | null;
  embedded_at: string;
}

export interface EmbeddingQueueItem {
  node_id: string;
  source_type: 'node' | 'extraction';
  extraction_ref?: string;
  retries?: number;
}

export interface SearchHit {
  node_id: string;
  score: number;
  match_sources: Array<'fts' | 'semantic'>;
  matched_embed?: string;
  snippet?: string;
}

export interface SearchIndexStatus {
  status: 'ready' | 'indexing' | 'disabled';
  nodes_total: number;
  nodes_indexed: number;
  extractions_total: number;
  extractions_indexed: number;
  pending: number;
}
