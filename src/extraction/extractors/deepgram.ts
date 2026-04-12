import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Extractor, ExtractionResult } from '../types.js';

export interface DiarizedSegment {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDiarizedTranscript(segments: DiarizedSegment[]): string {
  if (segments.length === 0) return '';
  return segments
    .map(seg => `[Speaker ${seg.speaker + 1}] ${formatTimestamp(seg.start)}\n${seg.text}`)
    .join('\n\n');
}

const MIME_MAP: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
};

export class DeepgramExtractor implements Extractor {
  readonly id = 'deepgram-nova-3';
  readonly mediaType = 'audio';
  readonly supportedExtensions = ['.m4a', '.mp3', '.wav', '.webm', '.ogg'];

  constructor(private readonly apiKey: string) {}

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const mimetype = MIME_MAP[ext];
    if (!mimetype) {
      throw new Error(`Unsupported audio format: ${ext}`);
    }

    const { DeepgramClient } = await import('@deepgram/sdk');
    const deepgram = new DeepgramClient({ apiKey: this.apiKey });

    const buffer = await readFile(filePath);
    const uploadable = { data: buffer, contentType: mimetype };
    const result = await deepgram.listen.v1.media.transcribeFile(uploadable, {
      model: 'nova-3',
      smart_format: true,
      diarize: true,
    });

    // result is ListenV1Response | ListenV1AcceptedResponse
    const utterances =
      ('results' in result ? result.results?.utterances : undefined) ?? [];
    const segments: DiarizedSegment[] = utterances.map(u => ({
      speaker: u.speaker ?? 0,
      start: u.start ?? 0,
      end: u.end ?? 0,
      text: u.transcript ?? '',
    }));

    const text = formatDiarizedTranscript(segments);
    return {
      text,
      metadata: { segments },
    };
  }
}
