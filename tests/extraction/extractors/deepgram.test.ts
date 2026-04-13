import { describe, it, expect } from 'vitest';
import {
  DeepgramExtractor,
  formatTimestamp,
  formatDiarizedTranscript,
  type DiarizedSegment,
} from '../../../src/extraction/extractors/deepgram.js';

describe('DeepgramExtractor', () => {
  const extractor = new DeepgramExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('deepgram-nova-3');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('audio');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.m4a', '.mp3', '.wav', '.webm', '.ogg']);
  });

  it('exposes an extract function', () => {
    expect(typeof extractor.extract).toBe('function');
  });
});

describe('formatTimestamp', () => {
  it('formats 0 seconds', () => {
    expect(formatTimestamp(0)).toBe('00:00:00');
  });

  it('formats 12.5 seconds', () => {
    expect(formatTimestamp(12.5)).toBe('00:00:12');
  });

  it('formats 65 seconds', () => {
    expect(formatTimestamp(65)).toBe('00:01:05');
  });

  it('formats 3723.4 seconds (1h 2m 3s)', () => {
    expect(formatTimestamp(3723.4)).toBe('01:02:03');
  });
});

describe('formatDiarizedTranscript', () => {
  it('returns empty string for empty segments', () => {
    expect(formatDiarizedTranscript([])).toBe('');
  });

  it('formats two segments correctly', () => {
    const segments: DiarizedSegment[] = [
      { speaker: 0, start: 0, end: 5, text: 'Hello there.' },
      { speaker: 1, start: 6, end: 12, text: 'How are you?' },
    ];
    const result = formatDiarizedTranscript(segments);
    expect(result).toBe(
      '[Speaker 1] 00:00:00\nHello there.\n\n[Speaker 2] 00:00:06\nHow are you?'
    );
  });

  it('formats segments with long timestamps', () => {
    const segments: DiarizedSegment[] = [
      { speaker: 0, start: 3723.4, end: 3730, text: 'Late in the recording.' },
    ];
    const result = formatDiarizedTranscript(segments);
    expect(result).toBe('[Speaker 1] 01:02:03\nLate in the recording.');
  });
});
