import type { Extractor } from './types.js';
import { ExtractorRegistry } from './registry.js';
import { MarkdownExtractor } from './extractors/markdown.js';
import { OfficeExtractor } from './extractors/office.js';
import { UnpdfExtractor } from './extractors/unpdf.js';
import { DeepgramExtractor } from './extractors/deepgram.js';
import {
  ClaudeVisionImageExtractor,
  ClaudeVisionPdfExtractor,
  CLAUDE_IMAGE_EXTENSIONS,
} from './extractors/claude-vision.js';
import {
  GeminiVisionImageExtractor,
  GeminiVisionPdfExtractor,
  GEMINI_IMAGE_EXTENSIONS,
} from './extractors/gemini-vision.js';

export interface BuiltExtractors {
  registry: ExtractorRegistry;
  pdfFallback: Extractor | null;
}

type VisionProvider = 'gemini' | 'claude';

function resolveVisionProvider(raw: string | undefined): VisionProvider {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'gemini') return 'gemini';
  if (trimmed === 'claude') return 'claude';
  throw new Error(
    `Invalid VISION_PROVIDER=${JSON.stringify(raw)}; expected 'gemini' or 'claude'`,
  );
}

export function buildExtractors(env: Record<string, string | undefined>): BuiltExtractors {
  const registry = new ExtractorRegistry();

  // Always-on local extractors
  registry.register(new MarkdownExtractor());
  registry.register(new OfficeExtractor());
  registry.register(new UnpdfExtractor());

  // Deepgram audio
  const deepgramKey = env.DEEPGRAM_API_KEY;
  if (deepgramKey) {
    registry.register(new DeepgramExtractor(deepgramKey));
  } else {
    registry.registerUnavailable(
      'deepgram-nova-3',
      'audio',
      ['.m4a', '.mp3', '.wav', '.webm', '.ogg'],
      'DEEPGRAM_API_KEY',
    );
  }

  // Vision provider — selected by VISION_PROVIDER, defaulting to gemini
  const provider = resolveVisionProvider(env.VISION_PROVIDER);
  let pdfFallback: Extractor | null = null;

  if (provider === 'gemini') {
    const key = env.GEMINI_API_KEY;
    if (key) {
      registry.register(new GeminiVisionImageExtractor(key));
      pdfFallback = new GeminiVisionPdfExtractor(key);
    } else {
      console.warn(
        '[extraction] VISION_PROVIDER=gemini but GEMINI_API_KEY is unset; vision extraction disabled',
      );
      registry.registerUnavailable('gemini-vision-image', 'image', GEMINI_IMAGE_EXTENSIONS, 'GEMINI_API_KEY');
      registry.registerUnavailable('gemini-vision-pdf', 'pdf', ['.pdf'], 'GEMINI_API_KEY');
    }
  } else {
    const key = env.ANTHROPIC_API_KEY;
    if (key) {
      registry.register(new ClaudeVisionImageExtractor(key));
      pdfFallback = new ClaudeVisionPdfExtractor(key);
    } else {
      console.warn(
        '[extraction] VISION_PROVIDER=claude but ANTHROPIC_API_KEY is unset; vision extraction disabled',
      );
      registry.registerUnavailable('claude-vision-image', 'image', CLAUDE_IMAGE_EXTENSIONS, 'ANTHROPIC_API_KEY');
      registry.registerUnavailable('claude-vision-pdf', 'pdf', ['.pdf'], 'ANTHROPIC_API_KEY');
    }
  }

  return { registry, pdfFallback };
}
