# Vision Provider Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemini 2.5 Flash the default vision provider via a new `VISION_PROVIDER` env var, keep Claude vision as opt-in, and fix the latent bug where the existing sparse-text PDF fallback never triggers.

**Architecture:** One env knob (`VISION_PROVIDER=gemini|claude`, default `gemini`) selects the provider for both image extraction and PDF fallback. Vision PDF extractors are attached only via `setPdfFallback()` — never registered into `byExtension` — so unpdf stays as the `.pdf` primary and the existing `<50 chars/page` fallback path actually fires. Missing API key for the selected provider gracefully disables vision; text PDFs keep working via unpdf.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, `@google/genai` SDK, existing `@anthropic-ai/sdk`, existing `unpdf`.

**Spec:** `docs/superpowers/specs/2026-04-16-vision-provider-swap-design.md`

---

### Task 1: Add `@google/genai` dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the SDK**

Run from repo root:
```bash
npm install @google/genai
```

Expected: `package.json` dependency block gets a new `"@google/genai": "^<version>"` line, `package-lock.json` updates.

- [ ] **Step 2: Verify the install**

Run:
```bash
node -e "import('@google/genai').then(m => console.log(Object.keys(m).sort().slice(0,5)))"
```

Expected: prints an array beginning with entries like `[ 'GoogleGenAI', ... ]` (no error). If this fails with "Cannot find module", the install didn't land — retry step 1.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @google/genai dependency for vision provider swap"
```

---

### Task 2: Create `GeminiVisionImageExtractor` and `GeminiVisionPdfExtractor`

**Files:**
- Create: `src/extraction/extractors/gemini-vision.ts`
- Create: `tests/extraction/extractors/gemini-vision.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/extraction/extractors/gemini-vision.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  GeminiVisionImageExtractor,
  GeminiVisionPdfExtractor,
} from '../../../src/extraction/extractors/gemini-vision.js';

describe('GeminiVisionImageExtractor', () => {
  const extractor = new GeminiVisionImageExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('gemini-vision-image');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('image');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  });

  it('exposes an extract function', () => {
    expect(typeof extractor.extract).toBe('function');
  });
});

describe('GeminiVisionPdfExtractor', () => {
  const extractor = new GeminiVisionPdfExtractor('test-api-key');

  it('has correct id', () => {
    expect(extractor.id).toBe('gemini-vision-pdf');
  });

  it('has correct mediaType', () => {
    expect(extractor.mediaType).toBe('pdf');
  });

  it('has correct supportedExtensions', () => {
    expect(extractor.supportedExtensions).toEqual(['.pdf']);
  });

  it('exposes an extract function', () => {
    expect(typeof extractor.extract).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test -- tests/extraction/extractors/gemini-vision.test.ts
```

Expected: FAIL with an error about the module `src/extraction/extractors/gemini-vision.js` not existing.

- [ ] **Step 3: Implement the extractors**

Create `src/extraction/extractors/gemini-vision.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { Extractor, ExtractionResult } from '../types.js';

const MODEL = 'gemini-2.5-flash';

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_PROMPT =
  'Extract all text from this image. If it contains handwriting, transcribe it. If it contains a diagram or photo, describe what you see. Return only the extracted content, no commentary.';

const PDF_PROMPT =
  'Extract all text from this scanned PDF document. Transcribe any handwriting. Return only the extracted content, no commentary.';

function extractText(response: { text?: string | null }): string {
  return response.text ?? '';
}

export class GeminiVisionImageExtractor implements Extractor {
  readonly id = 'gemini-vision-image';
  readonly mediaType = 'image';
  readonly supportedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[ext];
    if (!mimeType) {
      throw new Error(`Unsupported image format: ${ext}`);
    }

    const buffer = await readFile(filePath);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:gemini-vision] sending ${sizeMB}MB ${ext} image to Gemini vision`);
    const data = buffer.toString('base64');

    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data } },
            { text: IMAGE_PROMPT },
          ],
        },
      ],
    });

    const text = extractText(response);
    console.log(`[extraction:gemini-vision] image extraction complete: ${text.length} chars`);
    return { text };
  }
}

export class GeminiVisionPdfExtractor implements Extractor {
  readonly id = 'gemini-vision-pdf';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:gemini-vision] sending ${sizeMB}MB scanned PDF to Gemini vision`);
    const data = buffer.toString('base64');

    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data } },
            { text: PDF_PROMPT },
          ],
        },
      ],
    });

    const text = extractText(response);
    console.log(`[extraction:gemini-vision] scanned PDF extraction complete: ${text.length} chars`);
    return { text };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npm test -- tests/extraction/extractors/gemini-vision.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run build
```

Expected: clean exit. If `GoogleGenAI` API types don't match the `inlineData` shape used above, consult the `@google/genai` type defs in `node_modules/@google/genai/dist/` and adjust. The SDK's preferred shape for inline parts is `{ inlineData: { mimeType, data } }` where `data` is a base64 string — if the installed version requires a different property name (e.g. `inline_data`), adapt and note it in a code comment.

- [ ] **Step 6: Commit**

```bash
git add src/extraction/extractors/gemini-vision.ts tests/extraction/extractors/gemini-vision.test.ts
git commit -m "feat(extraction): add Gemini 2.5 Flash vision extractors"
```

---

### Task 3: Refactor `setup.ts` — rename function, add provider branching, fix the latent PDF-fallback bug

**Files:**
- Modify: `src/extraction/setup.ts` (full rewrite of the exported function)
- Modify: `tests/extraction/setup.test.ts` (full rewrite)

Background: the current `setup.ts` registers `ClaudeVisionPdfExtractor` via `registry.register()`, which overwrites `UnpdfExtractor` for `.pdf` in the `byExtension` map. Result: the `setPdfFallback()` mechanism in `ExtractionCache` never triggers because Claude is already the primary. The fix: vision PDF extractors are never put in the registry; they are returned separately so the caller can wire them as the fallback.

- [ ] **Step 1: Rewrite the tests (TDD — these will fail until the refactor lands)**

Replace the entire contents of `tests/extraction/setup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildExtractors } from '../../src/extraction/setup.js';

describe('buildExtractors', () => {
  describe('always-on local extractors', () => {
    it('registers markdown, office, and unpdf with no env vars', () => {
      const { registry } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.active.map(e => e.id).sort()).toContain('markdown-read');
      expect(status.active.map(e => e.id).sort()).toContain('office-doc');
      expect(status.active.map(e => e.id).sort()).toContain('unpdf-text');
    });

    it('serves .pdf from unpdf (not any vision extractor)', () => {
      const { registry } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });
  });

  describe('deepgram', () => {
    it('registers when DEEPGRAM_API_KEY is set', () => {
      const { registry } = buildExtractors({ DEEPGRAM_API_KEY: 'dk_test' });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    });

    it('marks unavailable when DEEPGRAM_API_KEY is unset', () => {
      const { registry } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    });
  });

  describe('VISION_PROVIDER=gemini (default)', () => {
    it('with GEMINI_API_KEY: image extractor active, pdfFallback is gemini', () => {
      const { registry, pdfFallback } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'gemini-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('without GEMINI_API_KEY: image marked unavailable, pdfFallback is null', () => {
      const { registry, pdfFallback } = buildExtractors({});
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'gemini-vision-image')).toBe(true);
      expect(status.unavailable.some(e => e.id === 'gemini-vision-pdf')).toBe(true);
      expect(pdfFallback).toBeNull();
    });

    it('empty-string VISION_PROVIDER treated as gemini', () => {
      const { pdfFallback } = buildExtractors({ VISION_PROVIDER: '', GEMINI_API_KEY: 'g_test' });
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });

    it('whitespace VISION_PROVIDER treated as gemini', () => {
      const { pdfFallback } = buildExtractors({ VISION_PROVIDER: '   ', GEMINI_API_KEY: 'g_test' });
      expect(pdfFallback?.id).toBe('gemini-vision-pdf');
    });
  });

  describe('VISION_PROVIDER=claude', () => {
    it('with ANTHROPIC_API_KEY: image extractor active, pdfFallback is claude', () => {
      const { registry, pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      const status = registry.getStatus();
      expect(status.active.some(e => e.id === 'claude-vision-image')).toBe(true);
      expect(pdfFallback?.id).toBe('claude-vision-pdf');
    });

    it('without ANTHROPIC_API_KEY: image marked unavailable, pdfFallback is null', () => {
      const { registry, pdfFallback } = buildExtractors({ VISION_PROVIDER: 'claude' });
      const status = registry.getStatus();
      expect(status.unavailable.some(e => e.id === 'claude-vision-image')).toBe(true);
      expect(status.unavailable.some(e => e.id === 'claude-vision-pdf')).toBe(true);
      expect(pdfFallback).toBeNull();
    });

    it('is case-insensitive', () => {
      const { pdfFallback } = buildExtractors({
        VISION_PROVIDER: 'CLAUDE',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      expect(pdfFallback?.id).toBe('claude-vision-pdf');
    });
  });

  describe('invalid VISION_PROVIDER', () => {
    it('throws for unknown provider', () => {
      expect(() => buildExtractors({ VISION_PROVIDER: 'bogus' })).toThrow(
        /VISION_PROVIDER/,
      );
    });
  });

  describe('latent-bug regression', () => {
    it('never registers gemini-vision-pdf into byExtension for .pdf', () => {
      const { registry } = buildExtractors({ GEMINI_API_KEY: 'g_test' });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).not.toBe('gemini-vision-pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });

    it('never registers claude-vision-pdf into byExtension for .pdf', () => {
      const { registry } = buildExtractors({
        VISION_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'sk_test',
      });
      const pdfExtractor = registry.getForExtension('.pdf');
      expect(pdfExtractor?.id).not.toBe('claude-vision-pdf');
      expect(pdfExtractor?.id).toBe('unpdf-text');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npm test -- tests/extraction/setup.test.ts
```

Expected: FAIL. Most tests fail with something like `buildExtractors is not a function` (still exported as `buildExtractorRegistry`). The bug-regression tests would fail against the current implementation because today's code registers the vision PDF extractor for `.pdf`.

- [ ] **Step 3: Rewrite `src/extraction/setup.ts`**

Replace the entire file contents:

```ts
import type { Extractor } from './types.js';
import { ExtractorRegistry } from './registry.js';
import { MarkdownExtractor } from './extractors/markdown.js';
import { OfficeExtractor } from './extractors/office.js';
import { UnpdfExtractor } from './extractors/unpdf.js';
import { DeepgramExtractor } from './extractors/deepgram.js';
import {
  ClaudeVisionImageExtractor,
  ClaudeVisionPdfExtractor,
} from './extractors/claude-vision.js';
import {
  GeminiVisionImageExtractor,
  GeminiVisionPdfExtractor,
} from './extractors/gemini-vision.js';

export interface BuiltExtractors {
  registry: ExtractorRegistry;
  pdfFallback: Extractor | null;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
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
      registry.registerUnavailable('gemini-vision-image', 'image', IMAGE_EXTS, 'GEMINI_API_KEY');
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
      registry.registerUnavailable('claude-vision-image', 'image', IMAGE_EXTS, 'ANTHROPIC_API_KEY');
      registry.registerUnavailable('claude-vision-pdf', 'pdf', ['.pdf'], 'ANTHROPIC_API_KEY');
    }
  }

  return { registry, pdfFallback };
}
```

Note: this intentionally drops the `buildExtractorRegistry` export. Any other import site will fail to compile in Task 4, which is where the caller gets updated.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npm test -- tests/extraction/setup.test.ts
```

Expected: PASS (all ~15 tests in the rewritten file).

- [ ] **Step 5: Commit**

```bash
git add src/extraction/setup.ts tests/extraction/setup.test.ts
git commit -m "refactor(extraction): buildExtractors with VISION_PROVIDER knob, fix latent PDF fallback bug

UnpdfExtractor was being overwritten by ClaudeVisionPdfExtractor in the
byExtension map (last-write-wins), disabling the setPdfFallback() sparse-
text detour entirely. Vision PDF extractors are now only ever returned as
the pdfFallback, never registered for .pdf."
```

---

### Task 4: Update `src/index.ts` wiring

**Files:**
- Modify: `src/index.ts` (lines 24–25 imports, 74–78 wiring)

- [ ] **Step 1: Update imports**

Find the existing imports in `src/index.ts`:

```ts
import { buildExtractorRegistry } from './extraction/setup.js';
import { ExtractionCache } from './extraction/cache.js';
```

…and ensure any import of `ClaudeVisionPdfExtractor` is removed. Replace the setup import with:

```ts
import { buildExtractors } from './extraction/setup.js';
import { ExtractionCache } from './extraction/cache.js';
```

Remove any line like `import { ClaudeVisionPdfExtractor } from './extraction/extractors/claude-vision.js';` — it is no longer used here.

- [ ] **Step 2: Update the wiring block**

Replace lines 74–78 (the current block):

```ts
const extractorRegistry = buildExtractorRegistry(process.env as Record<string, string | undefined>);
const extractionCache = new ExtractionCache(db, extractorRegistry);
if (process.env.ANTHROPIC_API_KEY) {
  extractionCache.setPdfFallback(new ClaudeVisionPdfExtractor(process.env.ANTHROPIC_API_KEY));
}
```

…with:

```ts
const { registry: extractorRegistry, pdfFallback } = buildExtractors(
  process.env as Record<string, string | undefined>,
);
const extractionCache = new ExtractionCache(db, extractorRegistry);
if (pdfFallback !== null) {
  extractionCache.setPdfFallback(pdfFallback);
}
```

- [ ] **Step 3: Typecheck the whole project**

Run:
```bash
npm run build
```

Expected: clean exit, no TS errors. If something else imports `buildExtractorRegistry`, update that site to `buildExtractors` returning the `{ registry, pdfFallback }` shape. Check for stragglers:

```bash
grep -rn "buildExtractorRegistry" src tests
```

Expected: zero matches.

- [ ] **Step 4: Run the full test suite**

Run:
```bash
npm test
```

Expected: all tests pass. If any unrelated test that previously relied on `ClaudeVisionPdfExtractor` being the `.pdf` primary breaks, investigate — it was likely asserting the buggy behavior and should be updated.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(extraction): wire VISION_PROVIDER-selected pdf fallback in index.ts"
```

---

### Task 5: Documentation — env files, service file, CLAUDE.md

**Files:**
- Modify: `.env.example`
- Modify: `vault-engine-new.service.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `.env.example`**

Current contents:
```
OAUTH_OWNER_PASSWORD=your-password-here
OAUTH_ISSUER_URL=https://your-tunnel-hostname.example.com
DEEPGRAM_API_KEY=
ANTHROPIC_API_KEY=
NORMALIZE_CRON=
NORMALIZE_QUIESCENCE_MINUTES=60
```

Replace with:
```
OAUTH_OWNER_PASSWORD=your-password-here
OAUTH_ISSUER_URL=https://your-tunnel-hostname.example.com
DEEPGRAM_API_KEY=
# Vision provider for image and scanned-PDF extraction: gemini (default) or claude
VISION_PROVIDER=gemini
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
NORMALIZE_CRON=
NORMALIZE_QUIESCENCE_MINUTES=60
```

- [ ] **Step 2: Update `vault-engine-new.service.example`**

The service file references `.env` via `EnvironmentFile`, so the new vars load automatically. No edit needed to the `.service` file itself — but if the file contains any inline `Environment=` lines referencing the old vision vars, update accordingly. (Current file has none, per inspection — skip the edit if nothing matches.)

- [ ] **Step 3: Update `CLAUDE.md`**

In the `## Conventions` bullet list, add this bullet (alphabetical/topical placement near the extraction-related bullets is fine — near the "Subprocess-isolated embedder" bullet works):

```markdown
- **Vision provider selection.** `VISION_PROVIDER=gemini|claude` (default `gemini`) selects the vision model for image extraction and PDF fallback. Requires `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` respectively. `UnpdfExtractor` is always the `.pdf` primary; the chosen vision extractor is attached only via `setPdfFallback()` and triggers when `avgCharsPerPage < 50`. Missing key for the selected provider → warning + vision disabled (text PDFs still work).
```

- [ ] **Step 4: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document VISION_PROVIDER env var and GEMINI_API_KEY"
```

(If the service file needed changes, include it in the `git add`.)

---

### Task 6: Manual smoke verification

This is not automated — requires real files and optionally real API keys. Do not claim the feature is shipped until these pass.

**Files:** none (verification only)

- [ ] **Step 1: Confirm unpdf handles text PDFs without touching vision**

Pick a text-based PDF from the vault (e.g. any PDF where you can select the text in a viewer). Start the server with `VISION_PROVIDER=gemini` and `GEMINI_API_KEY` set, trigger extraction (e.g. via `read-embedded` MCP tool or by embedding a note referencing it), and confirm the logs show:

```
[extraction:unpdf] N pages, M avg chars/page, ...
[extraction] extracted: <name> via unpdf-text → ...
```

…and **no** `[extraction:gemini-vision]` line. If Gemini ran, unpdf's metadata is not reporting `avgCharsPerPage ≥ 50` — inspect the file.

- [ ] **Step 2: Confirm fallback triggers on a scanned/image-only PDF**

Either find a scanned PDF in the vault or generate one (print an image to PDF). Clear the cache row for it first: `sqlite3 <db-path> "DELETE FROM extraction_cache WHERE file_path LIKE '%<filename>%';"`. Re-trigger extraction. Logs should show:

```
[extraction:unpdf] N pages, <50 avg chars/page, ...
[extraction] PDF sparse text (<N> chars/page) → falling back to gemini-vision-pdf
[extraction:gemini-vision] sending <X>MB scanned PDF to Gemini vision
```

- [ ] **Step 3: Confirm image extraction uses Gemini**

Extract a `.png` or `.jpg` from the vault. Logs should show `[extraction:gemini-vision] sending ... image`. No Claude log lines.

- [ ] **Step 4: Confirm Claude opt-in works**

Stop the server, change `.env` to `VISION_PROVIDER=claude`, restart. Re-run a scanned-PDF extraction (after clearing its cache row). Logs should show `[extraction:claude-vision]` instead of `[extraction:gemini-vision]`.

- [ ] **Step 5: Confirm missing-key degradation**

Stop the server, set `VISION_PROVIDER=gemini` and unset/blank `GEMINI_API_KEY`, restart. Startup log should contain:

```
[extraction] VISION_PROVIDER=gemini but GEMINI_API_KEY is unset; vision extraction disabled
```

Text PDF extraction still works. Attempting image extraction surfaces `EXTRACTOR_UNAVAILABLE: Extractor 'gemini-vision-image' requires API key: GEMINI_API_KEY`.

- [ ] **Step 6: Restore working config and commit a note if anything required a fix**

No code commit here unless smoke tests surfaced a bug. Report back.

---

## Post-Implementation Checklist

- [ ] All automated tests pass (`npm test`)
- [ ] TypeScript build is clean (`npm run build`)
- [ ] All six smoke-test steps above passed
- [ ] Release note flags the default provider switch so users relying on `ANTHROPIC_API_KEY` alone know to either add `GEMINI_API_KEY` or set `VISION_PROVIDER=claude`
