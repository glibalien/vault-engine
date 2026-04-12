export interface Extractor {
  id: string;                    // e.g. 'deepgram-nova-3'
  mediaType: string;             // e.g. 'audio'
  supportedExtensions: string[]; // e.g. ['.m4a', '.mp3']
  extract(filePath: string): Promise<ExtractionResult>;
}

export interface ExtractionResult {
  text: string;
  metadata?: unknown;
}

export interface CachedExtraction {
  text: string;
  metadata: unknown;
  mediaType: string;
  extractorId: string;
  contentHash: string;
}

export interface EmbedEntry {
  reference: string;
  mediaType: string;
  text: string;
  source?: string;
}

export interface EmbedError {
  reference: string;
  error: string;
}

export interface AssembledNode {
  node: {
    title: string | null;
    types: string[];
    fields: Record<string, unknown>;
  };
  body: string | null;
  embeds: EmbedEntry[];
  errors: EmbedError[];
}
