// src/search/embedder-worker.ts
//
// Child process entry point. Loads the ONNX embedding model and serves
// embed requests over Node IPC. Exits on 'shutdown' message or when
// the IPC channel disconnects (parent died).

import { pipeline, env } from '@huggingface/transformers';
import type { WorkerRequest, WorkerMessage } from './embedder-protocol.js';

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const DIMENSIONS = 256;

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

  // Model loaded — prevent further network calls
  env.allowRemoteModels = false;

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
        const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
        const full = output.data as Float32Array;
        const slice = full.length === DIMENSIONS ? full : full.slice(0, DIMENSIONS);
        send({
          type: 'embed-result',
          requestId: msg.requestId,
          vectors: [Array.from(slice)],
        });
      } catch (err) {
        send({
          type: 'embed-error',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // If parent disconnects IPC, exit cleanly
  process.on('disconnect', () => process.exit(0));
}

main().catch(err => {
  console.error('[embedder-worker] Fatal:', err);
  process.exit(1);
});
