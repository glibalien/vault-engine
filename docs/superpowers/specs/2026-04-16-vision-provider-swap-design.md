# Vision Provider Swap — Design Spec

**Date:** 2026-04-16
**Status:** Approved (pending written review)
**Origin:** Conversation about Claude vision cost vs. Gemini 2.5 Flash

## Summary

Replace Claude vision as the default image and scanned-PDF extractor with Gemini 2.5 Flash. Expose a `VISION_PROVIDER` env var so users can still opt into Claude vision. Also fix a latent bug where the current setup registers both `UnpdfExtractor` and `ClaudeVisionPdfExtractor` for `.pdf`, causing Claude to overwrite unpdf as primary — which disables the existing sparse-text fallback path entirely.

## Motivation

- **Cost.** Claude vision (Sonnet) is roughly 10× the per-token cost of Gemini 2.5 Flash for equivalent OCR/vision quality on documents.
- **Latent bug.** `ExtractionCache` already implements `setPdfFallback()` with a `<50 avg chars/page` threshold. Today's wiring never exercises it: `ClaudeVisionPdfExtractor` is registered via `registry.register()` in `setup.ts`, which overwrites the unpdf registration for `.pdf` (last write wins in the `byExtension` map). All PDFs — including pure-text ones — currently go to Claude vision.

## Current State (for reference)

- `src/extraction/setup.ts` registers `UnpdfExtractor` and both Claude vision extractors into the registry. The `.pdf` registration by Claude overwrites unpdf.
- `src/index.ts:76-78` also calls `extractionCache.setPdfFallback(new ClaudeVisionPdfExtractor(...))`. Dead code — the fallback never triggers because Claude is already the primary.
- `ExtractionCache.getExtraction()` checks `avgCharsPerPage` in the primary extractor's metadata to decide whether to fall back. Only `UnpdfExtractor` emits that field.
- `extraction_cache` table is keyed by SHA-256 of file bytes. Extractor id is stored but not part of the key.

## Configuration

### New env vars

| Var | Values | Default | Purpose |
|-----|--------|---------|---------|
| `VISION_PROVIDER` | `gemini` \| `claude` | `gemini` | Selects provider for image extraction and PDF fallback |
| `GEMINI_API_KEY` | string | — | Required when `VISION_PROVIDER=gemini` |

`ANTHROPIC_API_KEY` (existing) is required when `VISION_PROVIDER=claude`.

### Missing-key behavior

If `VISION_PROVIDER` selects a provider whose API key is missing:

- Log a clear warning at startup: `[extraction] VISION_PROVIDER=<X> but <X>_API_KEY is unset; vision extraction disabled`.
- Call `registry.registerUnavailable(...)` for the image extensions (so `getExtraction()` throws `EXTRACTOR_UNAVAILABLE` with the missing-key name). Also call it for `.pdf` with the vision PDF extractor id — this is nop for routing (unpdf is already registered for `.pdf`) but surfaces the disabled fallback in `getStatus()` output.
- Do **not** wire `setPdfFallback()`. Text PDFs still work via unpdf; scanned PDFs simply return whatever sparse text unpdf produced.
- Images throw `EXTRACTOR_UNAVAILABLE` at extraction time.

`VISION_PROVIDER` missing, empty, or whitespace: treated as `gemini` (default).

Unrecognized `VISION_PROVIDER` value (anything other than `gemini`/`claude`, case-insensitive): hard error at startup with the list of valid values.

## Architecture

### Extractor responsibilities (unchanged)

- `UnpdfExtractor` remains the **only** primary `.pdf` extractor. It emits `avgCharsPerPage` metadata.
- Vision PDF extractors (Gemini or Claude) are **only** attached via `setPdfFallback()`. They are never registered into the `byExtension` map.
- Image extractors register into `byExtension` for `.png/.jpg/.jpeg/.gif/.webp`. Only one image provider is active at a time (per `VISION_PROVIDER`).

### New file: `src/extraction/extractors/gemini-vision.ts`

Two classes mirroring `claude-vision.ts`:

- `GeminiVisionImageExtractor`
  - `id = 'gemini-vision-image'`
  - `mediaType = 'image'`
  - `supportedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp']`
- `GeminiVisionPdfExtractor`
  - `id = 'gemini-vision-pdf'`
  - `mediaType = 'pdf'`
  - `supportedExtensions = ['.pdf']`

Both accept `apiKey: string` in the constructor, use the `@google/genai` SDK, and call `models.generateContent` with model `gemini-2.5-flash`. Prompts are the same strings as the Claude versions. Returned `ExtractionResult` has shape `{ text }` (no metadata needed — not the primary PDF extractor, so `avgCharsPerPage` does not apply).

### Refactor: `src/extraction/setup.ts`

Rename `buildExtractorRegistry(env)` → `buildExtractors(env)` and change its return type:

```ts
interface BuiltExtractors {
  registry: ExtractorRegistry;
  pdfFallback: Extractor | null;
}
```

Logic:

1. Always register `MarkdownExtractor`, `OfficeExtractor`, `UnpdfExtractor` into `registry`.
2. Register Deepgram (unchanged).
3. Read `VISION_PROVIDER` (default `gemini`). Validate it is in `{gemini, claude}`; otherwise throw.
4. Based on provider:
   - **gemini**: if `GEMINI_API_KEY` present → register `GeminiVisionImageExtractor`, set `pdfFallback = new GeminiVisionPdfExtractor(...)`. Else → `registerUnavailable` for image extensions and `.pdf` with `GEMINI_API_KEY`, return `pdfFallback: null`.
   - **claude**: same pattern with `ClaudeVisionImageExtractor` / `ClaudeVisionPdfExtractor` and `ANTHROPIC_API_KEY`.
5. **Never** register the vision PDF extractor in the `byExtension` map. (This is the bug fix.)

### Wiring in `src/index.ts`

Replace lines 74–78 with:

```ts
const { registry, pdfFallback } = buildExtractors(process.env as Record<string, string | undefined>);
const extractionCache = new ExtractionCache(db, registry);
if (pdfFallback !== null) {
  extractionCache.setPdfFallback(pdfFallback);
}
```

Remove the `ClaudeVisionPdfExtractor` import here.

### Dependency

Add `@google/genai` to `package.json` dependencies. Pin to a recent minor. No removal of `@anthropic-ai/sdk` — still used for Claude vision and potentially other things.

### Cache behavior (explicit non-change)

`extraction_cache` rows are keyed by content hash. Switching providers does not invalidate cached rows — same file → same cached text, regardless of which extractor produced it. Users who want a fresh extraction can `DELETE FROM extraction_cache` manually. The row's `extractor_id` column records provenance for debugging.

## Error Handling

- Gemini API errors bubble up as thrown exceptions from `extract()`. The surrounding `ExtractionCache.getExtraction()` does not catch them; callers (indexer, `read-embedded`) handle them as extraction failures. Matches current Claude vision behavior.
- Fallback chain does not retry on Gemini failure. If Gemini throws on a sparse-text PDF, the extraction fails; no secondary fallback to Claude. Keeps the control flow simple and matches user intent ("Claude as opt-in fallback" means opt-in via env var, not automatic provider cascade).

## Testing

**Unit tests** (`tests/extraction/setup.test.ts`, new file):

- `VISION_PROVIDER=gemini` + `GEMINI_API_KEY` → image extractors registered, `pdfFallback` is `GeminiVisionPdfExtractor`.
- `VISION_PROVIDER=gemini` + no key → image extensions marked unavailable with `GEMINI_API_KEY`, `pdfFallback` is `null`.
- `VISION_PROVIDER=claude` + `ANTHROPIC_API_KEY` → image extractors registered, `pdfFallback` is `ClaudeVisionPdfExtractor`.
- `VISION_PROVIDER=claude` + no key → image extensions marked unavailable with `ANTHROPIC_API_KEY`, `pdfFallback` is `null`.
- `VISION_PROVIDER` missing → treated as `gemini` (default).
- `VISION_PROVIDER=bogus` → throws at build time.
- In all cases: `.pdf` is served by `UnpdfExtractor` (not by any vision extractor).

**Manual smoke tests** (not automated — require real API calls and sample files):

- Text PDF → unpdf path, no vision API call.
- Scanned/image-only PDF → unpdf returns sparse text → Gemini fallback triggers.
- Image file (`.png`) → direct Gemini image extraction.
- Repeat above with `VISION_PROVIDER=claude` to confirm the switch.

## Out of Scope

- Per-page mixed-content PDFs (some pages text, some scanned). Current threshold is whole-document average. Revisit if users hit it.
- Cost tracking / per-extraction metrics.
- Automatic cache invalidation on provider switch.
- Removing `@anthropic-ai/sdk` dependency.
- Alternate Gemini models (Pro, etc.). Flash only.

## Migration Notes

- No DB migration required.
- Existing users set `ANTHROPIC_API_KEY` only: after this change, default `VISION_PROVIDER=gemini` means vision stops working until they either (a) set `GEMINI_API_KEY`, or (b) set `VISION_PROVIDER=claude`. Release note must flag this.
- `.env.example` (if present) and `vault-engine-new.service.example` get new vars documented.

## File Manifest

**New:**
- `src/extraction/extractors/gemini-vision.ts`
- `tests/extraction/setup.test.ts`

**Modified:**
- `src/extraction/setup.ts` — rename function, new return shape, bug fix, provider branching
- `src/index.ts` — new call site for `buildExtractors()`
- `package.json` + `package-lock.json` — add `@google/genai`
- `.env.example` — document `VISION_PROVIDER` and `GEMINI_API_KEY`
- `vault-engine-new.service.example` — same
- `CLAUDE.md` — add one-line note about `VISION_PROVIDER`

**Untouched but relevant:**
- `src/extraction/cache.ts` — already supports the fallback mechanism
- `src/extraction/extractors/claude-vision.ts` — still used when `VISION_PROVIDER=claude`
- `src/extraction/extractors/unpdf.ts` — remains the only `.pdf` primary
