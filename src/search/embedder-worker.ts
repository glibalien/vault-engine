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
// Nomic supports 8192 but ONNX Runtime's memory arena sizes to the largest
// tensor shape it's seen and doesn't shrink — one 8k-token embed alone bloated
// RSS by ~6GB. Cap well below the model window so peak arena stays bounded.
// Also better retrieval quality: mean-pooled long-context vectors blur topical
// specificity vs. smaller chunks.
const MAX_TOKENS = 2048;
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

  let lastRss = process.memoryUsage().rss;
  let embedsServed = 0;

  process.on('message', async (msg: WorkerRequest) => {
    if (msg.type === 'shutdown') {
      process.exit(0);
    }

    if (msg.type === 'embed') {
      try {
        const prefixed = `${msg.prefix}: ${msg.text}`;
        const totalTokens = tokenCount(prefixed);
        const vectors: number[][] = [];

        if (totalTokens <= MAX_TOKENS) {
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

        embedsServed++;
        const currentRss = process.memoryUsage().rss;
        const rssMb = (currentRss / 1024 / 1024).toFixed(0);
        const deltaMb = ((currentRss - lastRss) / 1024 / 1024).toFixed(1);
        lastRss = currentRss;
        console.log(
          `[embedder-worker] #${embedsServed} chars=${msg.text.length} tokens=${totalTokens} chunks=${vectors.length} rss=${rssMb}MB Δ=${deltaMb}MB`
        );

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
