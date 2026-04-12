export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR' | 'VALIDATION_FAILED' | 'UNKNOWN_TYPE' | 'EXTRACTOR_UNAVAILABLE' | 'AMBIGUOUS_FILENAME';

export function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function toolErrorResult(code: ErrorCode, message: string) {
  return toolResult({ error: message, code });
}
