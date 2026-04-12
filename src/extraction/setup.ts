import { ExtractorRegistry } from './registry.js';
import { MarkdownExtractor } from './extractors/markdown.js';
import { OfficeExtractor } from './extractors/office.js';
import { UnpdfExtractor } from './extractors/unpdf.js';
import { DeepgramExtractor } from './extractors/deepgram.js';
import { ClaudeVisionImageExtractor, ClaudeVisionPdfExtractor } from './extractors/claude-vision.js';

export function buildExtractorRegistry(env: Record<string, string | undefined>): ExtractorRegistry {
  const registry = new ExtractorRegistry();

  // Local extractors — always available
  registry.register(new MarkdownExtractor());
  registry.register(new OfficeExtractor());
  registry.register(new UnpdfExtractor());

  // Deepgram audio
  const deepgramKey = env.DEEPGRAM_API_KEY;
  if (deepgramKey) {
    registry.register(new DeepgramExtractor(deepgramKey));
  } else {
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a', '.mp3', '.wav', '.webm', '.ogg'], 'DEEPGRAM_API_KEY');
  }

  // Claude vision (image + scanned PDF)
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    registry.register(new ClaudeVisionImageExtractor(anthropicKey));
    registry.register(new ClaudeVisionPdfExtractor(anthropicKey));
  } else {
    registry.registerUnavailable('claude-vision-image', 'image', ['.png', '.jpg', '.jpeg', '.gif', '.webp'], 'ANTHROPIC_API_KEY');
    registry.registerUnavailable('claude-vision-pdf', 'pdf', ['.pdf'], 'ANTHROPIC_API_KEY');
  }

  return registry;
}
