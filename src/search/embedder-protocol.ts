// src/search/embedder-protocol.ts

/** Parent → child: embed a text string */
export interface EmbedRequest {
  type: 'embed';
  requestId: string;
  text: string;
  prefix: 'search_document' | 'search_query';
}

/** Parent → child: shut down gracefully */
export interface ShutdownRequest {
  type: 'shutdown';
}

export type WorkerRequest = EmbedRequest | ShutdownRequest;

/** Child → parent: model is loaded and ready */
export interface ReadyMessage {
  type: 'ready';
}

/** Child → parent: embedding result. Returns one vector per chunk. */
export interface EmbedResponse {
  type: 'embed-result';
  requestId: string;
  vectors: number[][]; // Float32 values serialized as JSON arrays, one per chunk
}

/** Child → parent: embedding error */
export interface EmbedError {
  type: 'embed-error';
  requestId: string;
  error: string;
}

export type WorkerMessage = ReadyMessage | EmbedResponse | EmbedError;
