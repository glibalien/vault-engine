// src/search/embedder-worker.ts
//
// Forked subprocess entry point. Loads the ONNX embedding model and serves
// embed requests over Node IPC. Tokenizes input; if longer than the model's
// context window, splits semantically via src/search/chunker.ts and embeds
// each chunk, returning vectors: number[][].

import { pipeline, env } from '@huggingface/transformers';
import { chunkForEmbedding } from './chunker.js';
import type { WorkerRequest, WorkerMessage } from './embedder-protocol.js';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const DIMENSIONS = 256;
const MAX_TOKENS = 8192;
const OVERLAP_TOKENS = 128;
// Headroom for the "search_document: " / "search_query: " prefix (~4 BPE tokens)
// plus the [CLS]/[SEP] specials re-added on re-tokenization. 32 tokens is
// comfortable for any prefix + pathological BPE splits.
const PREFIX_HEADROOM_TOKENS = 32;

async function main(): Promise<void> {
  const modelsDir = process.argv[2];
  if (!modelsDir) {
    console.error('[embedder-worker] modelsDir argument required');
    process.exit(1);
  }

  env.cacheDir = modelsDir;
  env.allowRemoteModels = true;

  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    revision: 'main',
  });

  env.allowRemoteModels = false;

  function tokenCount(text: string): number {
    const ids = extractor.tokenizer(text).input_ids as { dims?: number[] };
    const dims = ids.dims;
    if (!dims || dims.length < 2) {
      throw new Error(`Unexpected tokenizer output shape: ${JSON.stringify(dims)}`);
    }
    return dims[1];
  }

  async function embedOne(text: string): Promise<number[]> {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const full = output.data as Float32Array;
    const slice = full.length === DIMENSIONS ? full : full.slice(0, DIMENSIONS);
    return Array.from(slice);
  }

  function send(msg: WorkerMessage): void {
    if (process.send) process.send(msg);
  }

  send({ type: 'ready' });

  process.on('message', async (msg: WorkerRequest) => {
    if (msg.type === 'shutdown') {
      process.exit(0);
    }

    if (msg.type === 'embed') {
      try {
        const prefixed = `${msg.prefix}: ${msg.text}`;
        const vectors: number[][] = [];

        if (tokenCount(prefixed) <= MAX_TOKENS) {
          vectors.push(await embedOne(prefixed));
        } else {
          // Chunk unprefixed text, then re-apply the prefix per chunk.
          // Leave headroom for the prefix tokens.
          const chunks = chunkForEmbedding(
            msg.text,
            tokenCount,
            { maxTokens: MAX_TOKENS - PREFIX_HEADROOM_TOKENS, overlapTokens: OVERLAP_TOKENS },
          );
          for (const chunk of chunks) {
            vectors.push(await embedOne(`${msg.prefix}: ${chunk}`));
          }
        }

        send({ type: 'embed-result', requestId: msg.requestId, vectors });
      } catch (err) {
        send({
          type: 'embed-error',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  process.on('disconnect', () => process.exit(0));
}

main().catch(err => {
  console.error('[embedder-worker] Fatal:', err);
  process.exit(1);
});
