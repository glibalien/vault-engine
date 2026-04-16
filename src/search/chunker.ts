// src/search/chunker.ts
//
// Pure, tokenizer-agnostic chunking for long documents. The caller supplies a
// token-counting callback; in production the Nomic tokenizer via the worker
// pipeline, in tests an approximation. No imports from the worker or model code.

export type Tokenize = (text: string) => number;

export interface ChunkOptions {
  /** Maximum tokens per chunk. Nomic v1.5 context window is 8192. */
  maxTokens: number;
  /** Tokens of overlap when hard-splitting content with no natural boundaries. */
  overlapTokens: number;
}

export function chunkForEmbedding(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  if (text.length === 0) return [];
  if (tokenize(text) <= options.maxTokens) return [text];

  const sections = splitByHeadings(text);
  const split = sections.flatMap(section => splitIfNeeded(section, tokenize, options));
  return pack(split, tokenize, options.maxTokens);
}

function splitByHeadings(text: string): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  const headingRe = /^#{1,6}\s/;
  for (const line of lines) {
    if (headingRe.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections;
}

function splitIfNeeded(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  if (tokenize(text) <= options.maxTokens) return [text];

  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    return paragraphs.flatMap(p => splitIfNeeded(p, tokenize, options));
  }

  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    return sentences.flatMap(s => splitIfNeeded(s, tokenize, options));
  }

  return hardSplit(text, tokenize, options);
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"(\d])/);
  return parts.filter(p => p.length > 0);
}

function hardSplit(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  const chunks: string[] = [];
  const approxCharsPerToken = Math.max(1, Math.ceil(text.length / Math.max(1, tokenize(text))));
  const charBudget = options.maxTokens * approxCharsPerToken;
  const overlapChars = options.overlapTokens * approxCharsPerToken;

  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + charBudget);
    while (end > start && tokenize(text.slice(start, end)) > options.maxTokens) {
      end -= Math.max(1, Math.floor(charBudget * 0.1));
    }
    if (end <= start) {
      end = Math.min(text.length, start + 1);
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

function pack(chunks: string[], tokenize: Tokenize, maxTokens: number): string[] {
  const packed: string[] = [];
  let buffer = '';
  for (const piece of chunks) {
    if (piece.length === 0) continue;
    if (buffer.length === 0) {
      buffer = piece;
      continue;
    }
    const candidate = `${buffer}\n\n${piece}`;
    if (tokenize(candidate) <= maxTokens) {
      buffer = candidate;
    } else {
      packed.push(buffer);
      buffer = piece;
    }
  }
  if (buffer.length > 0) packed.push(buffer);
  return packed;
}
