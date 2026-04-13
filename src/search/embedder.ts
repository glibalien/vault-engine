import { pipeline, env } from '@huggingface/transformers';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const DIMENSIONS = 256;

export interface EmbedderOptions {
  modelsDir: string;
}

export interface Embedder {
  embedDocument(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
  isReady(): boolean;
}

export async function createEmbedder(options: EmbedderOptions): Promise<Embedder> {
  env.cacheDir = options.modelsDir;
  env.allowRemoteModels = true;

  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    revision: 'main',
  });

  // After successful download, prevent further network calls
  env.allowRemoteModels = false;

  async function embed(text: string): Promise<Float32Array> {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const full = output.data as Float32Array;
    if (full.length === DIMENSIONS) return full;
    return full.slice(0, DIMENSIONS);
  }

  return {
    async embedDocument(text: string): Promise<Float32Array> {
      return embed(`search_document: ${text}`);
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return embed(`search_query: ${text}`);
    },
    isReady(): boolean {
      return true;
    },
  };
}
