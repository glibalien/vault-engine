// src/search/embedder-host.ts
//
// Parent-side Embedder that manages a child process. Spawns on first use,
// kills after idle timeout. Implements the same Embedder interface so all
// consumers (indexer, search, watcher) work unchanged.

import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Embedder } from './embedder.js';
import type { WorkerRequest, WorkerMessage } from './embedder-protocol.js';

const DEFAULT_IDLE_MS = 5 * 60 * 1000; // 5 minutes

export interface SubprocessEmbedderOptions {
  modelsDir: string;
  idleTimeoutMs?: number;
  /** Override the worker script path. Defaults to embedder-worker.js next to this module. */
  workerPath?: string;
}

interface PendingRequest {
  resolve: (vector: Float32Array) => void;
  reject: (err: Error) => void;
}

export function createSubprocessEmbedder(options: SubprocessEmbedderOptions): Embedder & { shutdown(): Promise<void> } {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const workerPath = options.workerPath ?? resolve(import.meta.dirname ?? '.', 'embedder-worker.js');

  let child: ChildProcess | null = null;
  let readyPromise: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, PendingRequest>();

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      killChild();
    }, idleTimeoutMs);
  }

  function killChild(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (child) {
      const c = child;
      child = null;
      readyPromise = null;
      c.kill('SIGTERM');
      // Reject any pending requests
      for (const [id, req] of pending) {
        req.reject(new Error('Embedder child process terminated'));
        pending.delete(id);
      }
    }
  }

  function spawnChild(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      child = fork(workerPath, [options.modelsDir], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });

      child.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          resolveReady();
          return;
        }
        if (msg.type === 'embed-result') {
          const req = pending.get(msg.requestId);
          if (req) {
            pending.delete(msg.requestId);
            req.resolve(new Float32Array(msg.vector));
            resetIdleTimer();
          }
          return;
        }
        if (msg.type === 'embed-error') {
          const req = pending.get(msg.requestId);
          if (req) {
            pending.delete(msg.requestId);
            req.reject(new Error(msg.error));
            resetIdleTimer();
          }
          return;
        }
      });

      const thisChild = child;
      child.on('exit', (code) => {
        // Only act if this is still the active child (not a previously-killed one)
        if (child === thisChild) {
          child = null;
          readyPromise = null;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          for (const [id, req] of pending) {
            req.reject(new Error(`Embedder child exited with code ${code}`));
            pending.delete(id);
          }
        }
      });

      child.on('error', (err) => {
        rejectReady(err);
      });
    });

    return readyPromise;
  }

  function sendRequest(prefix: 'search_document' | 'search_query', text: string): Promise<Float32Array> {
    return new Promise<Float32Array>((resolveEmbed, rejectEmbed) => {
      const requestId = randomUUID();
      pending.set(requestId, { resolve: resolveEmbed, reject: rejectEmbed });

      spawnChild().then(() => {
        const msg: WorkerRequest = { type: 'embed', requestId, text, prefix };
        child!.send(msg);
      }).catch(err => {
        pending.delete(requestId);
        rejectEmbed(err);
      });
    });
  }

  return {
    async embedDocument(text: string): Promise<Float32Array> {
      return sendRequest('search_document', text);
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return sendRequest('search_query', text);
    },
    isReady(): boolean {
      return true;
    },
    async shutdown(): Promise<void> {
      killChild();
    },
  };
}
