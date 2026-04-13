# Phase 6 — Content Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add content extraction for embedded files (`![[embed]]`) in vault nodes — audio transcription, image OCR, PDF text, office docs — cached by content hash and surfaced through `get-node` and a new `read-embedded` tool.

**Architecture:** Three-layer stack: extractors (per-media-type), cache (content-hash-keyed SQLite table), assembler (embed traversal + resolution). Extractors register at startup based on available API keys. `get-node` gains `include_embeds` param; new `read-embedded` tool extracts single files.

**Tech Stack:** better-sqlite3, Deepgram API (audio), @anthropic-ai/sdk (vision), unpdf (PDF), mammoth (docx), officeparser (pptx), xlsx/SheetJS (xlsx/csv), vitest

---

## File Structure

```
src/extraction/
  types.ts          — Extractor, ExtractionResult, AssembledNode, CachedExtraction interfaces
  registry.ts       — ExtractorRegistry class: extension-to-extractor map, startup key checks
  cache.ts          — ExtractionCache class: hash, lookup, store, PDF fallback orchestration
  assembler.ts      — assemble(): embed detection, resolver integration, recursive .md, cycle detection
  setup.ts          — buildExtractorRegistry(): env-var-aware startup wiring
  extractors/
    deepgram.ts     — DeepgramExtractor: audio transcription with diarization
    claude-vision.ts — ClaudeVisionImageExtractor + ClaudeVisionPdfExtractor
    unpdf.ts        — UnpdfExtractor: text-based PDF extraction
    office.ts       — OfficeExtractor: docx/pptx/xlsx/csv via mammoth/officeparser/SheetJS
    markdown.ts     — MarkdownExtractor: direct file read

src/mcp/tools/get-node.ts       — Extended: include_embeds, max_embeds params
src/mcp/tools/read-embedded.ts  — New tool
src/mcp/tools/vault-stats.ts    — Extended: extractor status section
src/mcp/tools/errors.ts         — Extended: new error codes
src/mcp/tools/index.ts          — Wire up read-embedded, pass vaultPath to get-node
src/mcp/server.ts               — ServerContext gains extractorRegistry + extractionCache
src/db/schema.ts                — extraction_cache table in createSchema
src/db/migrate.ts               — upgradeToPhase6() for existing databases
src/index.ts                    — Build registry at startup, pass to server context

tests/extraction/types.test.ts
tests/extraction/registry.test.ts
tests/extraction/cache.test.ts
tests/extraction/assembler.test.ts
tests/extraction/setup.test.ts
tests/extraction/extractors/markdown.test.ts
tests/extraction/extractors/office.test.ts
tests/extraction/extractors/unpdf.test.ts
tests/extraction/extractors/deepgram.test.ts
tests/extraction/extractors/claude-vision.test.ts
tests/mcp/get-node-embeds.test.ts
tests/mcp/read-embedded.test.ts
tests/mcp/vault-stats-extractors.test.ts
tests/phase6/end-to-end.test.ts
```

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new packages**

```bash
npm install unpdf mammoth officeparser xlsx @anthropic-ai/sdk @deepgram/sdk
```

- [ ] **Step 2: Verify build still passes**

```bash
npm run build
```

Expected: No errors (new deps don't affect existing code)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add Phase 6 extraction dependencies"
```

---

## Task 2: Types & Interfaces

**Files:**
- Create: `src/extraction/types.ts`
- Test: `tests/extraction/types.test.ts`

- [ ] **Step 1: Write the type-level test**

```typescript
// tests/extraction/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  Extractor,
  ExtractionResult,
  CachedExtraction,
  AssembledNode,
  EmbedEntry,
  EmbedError,
} from '../../src/extraction/types.js';

describe('extraction types', () => {
  it('ExtractionResult satisfies the interface', () => {
    const result: ExtractionResult = { text: 'hello' };
    expect(result.text).toBe('hello');
    expect(result.metadata).toBeUndefined();
  });

  it('ExtractionResult with metadata', () => {
    const result: ExtractionResult = {
      text: 'transcript',
      metadata: { speakers: 2, duration: 120 },
    };
    expect(result.metadata).toEqual({ speakers: 2, duration: 120 });
  });

  it('CachedExtraction includes cache metadata', () => {
    const cached: CachedExtraction = {
      text: 'extracted content',
      metadata: null,
      mediaType: 'audio',
      extractorId: 'deepgram-nova-3',
      contentHash: 'abc123',
    };
    expect(cached.extractorId).toBe('deepgram-nova-3');
  });

  it('AssembledNode has flat embeds array', () => {
    const assembled: AssembledNode = {
      node: { title: 'Test', types: ['meeting'], fields: {} },
      body: 'some body',
      embeds: [
        { reference: 'audio.m4a', mediaType: 'audio', text: 'transcript' },
        { reference: 'photo.png', mediaType: 'image', text: 'OCR text', source: 'notes.md' },
      ],
      errors: [],
    };
    expect(assembled.embeds).toHaveLength(2);
    expect(assembled.embeds[1].source).toBe('notes.md');
  });

  it('EmbedError captures reference and error message', () => {
    const err: EmbedError = { reference: 'missing.wav', error: 'EXTRACTOR_UNAVAILABLE: Audio extraction requires DEEPGRAM_API_KEY' };
    expect(err.error).toContain('EXTRACTOR_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/types.test.ts
```

Expected: FAIL — cannot resolve `../../src/extraction/types.js`

- [ ] **Step 3: Write the types**

```typescript
// src/extraction/types.ts

export interface Extractor {
  /** Unique ID, e.g. 'deepgram-nova-3' */
  id: string;
  /** Category, e.g. 'audio', 'image', 'pdf', 'office', 'markdown' */
  mediaType: string;
  /** File extensions this extractor handles, e.g. ['.m4a', '.mp3'] */
  supportedExtensions: string[];
  /** Extract text content from a file on disk */
  extract(filePath: string): Promise<ExtractionResult>;
}

export interface ExtractionResult {
  /** Human-readable extracted text */
  text: string;
  /** Extractor-specific structured data (e.g. diarization segments) */
  metadata?: unknown;
}

export interface CachedExtraction {
  text: string;
  metadata: unknown;
  mediaType: string;
  extractorId: string;
  contentHash: string;
}

export interface EmbedEntry {
  /** Original reference string from ![[reference]] */
  reference: string;
  /** Media type category */
  mediaType: string;
  /** Extracted text content */
  text: string;
  /** For recursive embeds: the parent embed that contained this */
  source?: string;
}

export interface EmbedError {
  reference: string;
  error: string;
}

export interface AssembledNode {
  node: {
    title: string | null;
    types: string[];
    fields: Record<string, unknown>;
  };
  body: string | null;
  embeds: EmbedEntry[];
  errors: EmbedError[];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/types.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/types.ts tests/extraction/types.test.ts
git commit -m "feat(phase6): add extraction type definitions"
```

---

## Task 3: DB Schema — `extraction_cache` Table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrate.ts`
- Test: `tests/db/schema.test.ts` (extend existing)

- [ ] **Step 1: Write test for extraction_cache table existence**

Add to `tests/db/schema.test.ts`:

```typescript
it('creates extraction_cache table', () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
  ).all() as { name: string }[];
  expect(tables).toHaveLength(1);
});

it('extraction_cache has expected columns', () => {
  const cols = (db.prepare('PRAGMA table_info(extraction_cache)').all() as { name: string }[])
    .map(c => c.name);
  expect(cols).toEqual([
    'content_hash', 'file_path', 'media_type', 'extractor_id',
    'extracted_text', 'metadata_json', 'extracted_at',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/db/schema.test.ts
```

Expected: FAIL — `extraction_cache` table doesn't exist

- [ ] **Step 3: Add extraction_cache to createSchema**

In `src/db/schema.ts`, add inside the `runSql(...)` template literal, before the closing `` `); ``:

```sql
    CREATE TABLE IF NOT EXISTS extraction_cache (
      content_hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      extractor_id TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      metadata_json TEXT,
      extracted_at TEXT NOT NULL
    );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/db/schema.test.ts
```

Expected: PASS

- [ ] **Step 5: Write migration test**

Add to `tests/db/schema.test.ts`:

```typescript
import { upgradeToPhase6 } from '../../src/db/migrate.js';

it('upgradeToPhase6 creates extraction_cache on existing DB', () => {
  const oldDb = new Database(':memory:');
  oldDb.pragma('journal_mode = WAL');
  oldDb.pragma('foreign_keys = ON');
  // Simulate a pre-Phase 6 DB with just a nodes table
  oldDb.prepare(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, file_path TEXT UNIQUE NOT NULL, title TEXT,
    body TEXT, content_hash TEXT, file_mtime INTEGER, indexed_at INTEGER)
  `).run();
  upgradeToPhase6(oldDb);
  const tables = oldDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
  ).all() as { name: string }[];
  expect(tables).toHaveLength(1);
  oldDb.close();
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npx vitest run tests/db/schema.test.ts
```

Expected: FAIL — `upgradeToPhase6` not found

- [ ] **Step 7: Write upgradeToPhase6 migration**

In `src/db/migrate.ts`, add:

```typescript
export function upgradeToPhase6(db: Database.Database): void {
  const run = db.transaction(() => {
    const tables = (
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_cache'"
      ).all() as { name: string }[]
    ).map(t => t.name);

    if (!tables.includes('extraction_cache')) {
      db.prepare(`
        CREATE TABLE extraction_cache (
          content_hash TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          extractor_id TEXT NOT NULL,
          extracted_text TEXT NOT NULL,
          metadata_json TEXT,
          extracted_at TEXT NOT NULL
        )
      `).run();
    }
  });

  run();
}
```

- [ ] **Step 8: Run test to verify it passes**

```bash
npx vitest run tests/db/schema.test.ts
```

Expected: PASS

- [ ] **Step 9: Wire migration into index.ts**

In `src/index.ts`, add the import:

```typescript
import { upgradeToPhase6 } from './db/migrate.js';
```

And after `upgradeToPhase3(db);`:

```typescript
upgradeToPhase6(db);
```

- [ ] **Step 10: Verify build**

```bash
npm run build
```

Expected: No errors

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.ts src/db/migrate.ts src/index.ts tests/db/schema.test.ts
git commit -m "feat(phase6): add extraction_cache table and migration"
```

---

## Task 4: Extractor Registry

**Files:**
- Create: `src/extraction/registry.ts`
- Test: `tests/extraction/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/registry.test.ts
import { describe, it, expect } from 'vitest';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

function makeExtractor(id: string, mediaType: string, extensions: string[]): Extractor {
  return {
    id,
    mediaType,
    supportedExtensions: extensions,
    async extract(): Promise<ExtractionResult> {
      return { text: `extracted by ${id}` };
    },
  };
}

describe('ExtractorRegistry', () => {
  it('registers and retrieves extractor by extension', () => {
    const registry = new ExtractorRegistry();
    const ext = makeExtractor('test-audio', 'audio', ['.mp3', '.wav']);
    registry.register(ext);
    expect(registry.getForExtension('.mp3')).toBe(ext);
    expect(registry.getForExtension('.wav')).toBe(ext);
  });

  it('returns null for unregistered extension', () => {
    const registry = new ExtractorRegistry();
    expect(registry.getForExtension('.xyz')).toBeNull();
  });

  it('last registration wins for same extension', () => {
    const registry = new ExtractorRegistry();
    const ext1 = makeExtractor('a', 'audio', ['.mp3']);
    const ext2 = makeExtractor('b', 'audio', ['.mp3']);
    registry.register(ext1);
    registry.register(ext2);
    expect(registry.getForExtension('.mp3')?.id).toBe('b');
  });

  it('lists all registered extractors', () => {
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('a', 'audio', ['.mp3']));
    registry.register(makeExtractor('b', 'image', ['.png']));
    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all.map(e => e.id).sort()).toEqual(['a', 'b']);
  });

  it('reports unavailable extractors', () => {
    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a', '.mp3'], 'DEEPGRAM_API_KEY');
    expect(registry.getForExtension('.m4a')).toBeNull();
    const unavailable = registry.getUnavailableReason('.m4a');
    expect(unavailable).toContain('DEEPGRAM_API_KEY');
  });

  it('unavailable reason is null for registered extension', () => {
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('test', 'audio', ['.mp3']));
    expect(registry.getUnavailableReason('.mp3')).toBeNull();
  });

  it('unavailable reason is null for unknown extension', () => {
    const registry = new ExtractorRegistry();
    expect(registry.getUnavailableReason('.xyz')).toBeNull();
  });

  it('getStatus returns active and unavailable lists', () => {
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('unpdf-text', 'pdf', ['.pdf']));
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    const status = registry.getStatus();
    expect(status.active).toEqual([{ id: 'unpdf-text', mediaType: 'pdf', extensions: ['.pdf'] }]);
    expect(status.unavailable).toEqual([{ id: 'deepgram-nova-3', mediaType: 'audio', extensions: ['.m4a'], missingKey: 'DEEPGRAM_API_KEY' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/registry.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement ExtractorRegistry**

```typescript
// src/extraction/registry.ts
import type { Extractor } from './types.js';

interface UnavailableEntry {
  id: string;
  mediaType: string;
  extensions: string[];
  missingKey: string;
}

interface ExtractorStatusEntry {
  id: string;
  mediaType: string;
  extensions: string[];
}

interface UnavailableStatusEntry extends ExtractorStatusEntry {
  missingKey: string;
}

export interface ExtractorStatus {
  active: ExtractorStatusEntry[];
  unavailable: UnavailableStatusEntry[];
}

export class ExtractorRegistry {
  private byExtension = new Map<string, Extractor>();
  private allExtractors = new Map<string, Extractor>();
  private unavailableByExtension = new Map<string, UnavailableEntry>();
  private unavailableEntries = new Map<string, UnavailableEntry>();

  register(extractor: Extractor): void {
    this.allExtractors.set(extractor.id, extractor);
    for (const ext of extractor.supportedExtensions) {
      this.byExtension.set(ext, extractor);
      this.unavailableByExtension.delete(ext);
    }
  }

  registerUnavailable(id: string, mediaType: string, extensions: string[], missingKey: string): void {
    const entry: UnavailableEntry = { id, mediaType, extensions, missingKey };
    this.unavailableEntries.set(id, entry);
    for (const ext of extensions) {
      if (!this.byExtension.has(ext)) {
        this.unavailableByExtension.set(ext, entry);
      }
    }
  }

  getForExtension(ext: string): Extractor | null {
    return this.byExtension.get(ext) ?? null;
  }

  getUnavailableReason(ext: string): string | null {
    const entry = this.unavailableByExtension.get(ext);
    if (!entry) return null;
    return `${entry.mediaType} extraction requires ${entry.missingKey}`;
  }

  listAll(): Extractor[] {
    return [...this.allExtractors.values()];
  }

  getStatus(): ExtractorStatus {
    const active: ExtractorStatusEntry[] = [];
    for (const ext of this.allExtractors.values()) {
      active.push({ id: ext.id, mediaType: ext.mediaType, extensions: [...ext.supportedExtensions] });
    }
    const unavailable: UnavailableStatusEntry[] = [];
    for (const entry of this.unavailableEntries.values()) {
      unavailable.push({ id: entry.id, mediaType: entry.mediaType, extensions: [...entry.extensions], missingKey: entry.missingKey });
    }
    return { active, unavailable };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/registry.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/registry.ts tests/extraction/registry.test.ts
git commit -m "feat(phase6): add ExtractorRegistry"
```

---

## Task 5: Markdown Extractor

**Files:**
- Create: `src/extraction/extractors/markdown.ts`
- Test: `tests/extraction/extractors/markdown.test.ts`

The simplest extractor — read the file and return its content. Good first extractor to verify the interface works.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/extractors/markdown.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MarkdownExtractor } from '../../../src/extraction/extractors/markdown.js';

describe('MarkdownExtractor', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reads markdown file content', async () => {
    dir = mkdtempSync(join(tmpdir(), 'md-ext-'));
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, '# Hello\n\nSome content here.');

    const extractor = new MarkdownExtractor();
    const result = await extractor.extract(filePath);
    expect(result.text).toBe('# Hello\n\nSome content here.');
    expect(result.metadata).toBeUndefined();
  });

  it('has correct id and mediaType', () => {
    const extractor = new MarkdownExtractor();
    expect(extractor.id).toBe('markdown-read');
    expect(extractor.mediaType).toBe('markdown');
    expect(extractor.supportedExtensions).toEqual(['.md']);
  });

  it('throws on missing file', async () => {
    const extractor = new MarkdownExtractor();
    await expect(extractor.extract('/nonexistent/file.md')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/extractors/markdown.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement MarkdownExtractor**

```typescript
// src/extraction/extractors/markdown.ts
import { readFile } from 'node:fs/promises';
import type { Extractor, ExtractionResult } from '../types.js';

export class MarkdownExtractor implements Extractor {
  readonly id = 'markdown-read';
  readonly mediaType = 'markdown';
  readonly supportedExtensions = ['.md'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const text = await readFile(filePath, 'utf-8');
    return { text };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/extractors/markdown.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/extractors/markdown.ts tests/extraction/extractors/markdown.test.ts
git commit -m "feat(phase6): add markdown extractor"
```

---

## Task 6: Office Document Extractor

**Files:**
- Create: `src/extraction/extractors/office.ts`
- Test: `tests/extraction/extractors/office.test.ts`

Handles .docx (mammoth), .pptx (officeparser), .xlsx/.csv (SheetJS). All local — no API keys.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/extractors/office.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OfficeExtractor } from '../../../src/extraction/extractors/office.js';

describe('OfficeExtractor', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('has correct id, mediaType, and extensions', () => {
    const ext = new OfficeExtractor();
    expect(ext.id).toBe('office-doc');
    expect(ext.mediaType).toBe('office');
    expect(ext.supportedExtensions).toEqual(['.docx', '.pptx', '.xlsx', '.csv']);
  });

  it('extracts CSV content', async () => {
    dir = mkdtempSync(join(tmpdir(), 'office-ext-'));
    const filePath = join(dir, 'data.csv');
    writeFileSync(filePath, 'Name,Age\nAlice,30\nBob,25');

    const ext = new OfficeExtractor();
    const result = await ext.extract(filePath);
    expect(result.text).toContain('Alice');
    expect(result.text).toContain('Bob');
  });

  it('throws on unsupported extension', async () => {
    dir = mkdtempSync(join(tmpdir(), 'office-ext-'));
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'hello');

    const ext = new OfficeExtractor();
    await expect(ext.extract(filePath)).rejects.toThrow('Unsupported');
  });
});
```

Note: Testing .docx/.pptx/.xlsx requires real binary files. CSV is plain text and tests the full code path for that format. Binary format tests can be added as fixture-based integration tests if desired.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/extractors/office.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement OfficeExtractor**

```typescript
// src/extraction/extractors/office.ts
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Extractor, ExtractionResult } from '../types.js';

export class OfficeExtractor implements Extractor {
  readonly id = 'office-doc';
  readonly mediaType = 'office';
  readonly supportedExtensions = ['.docx', '.pptx', '.xlsx', '.csv'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
      case '.docx':
        return this.extractDocx(filePath);
      case '.pptx':
        return this.extractPptx(filePath);
      case '.xlsx':
        return this.extractXlsx(filePath);
      case '.csv':
        return this.extractCsv(filePath);
      default:
        throw new Error(`Unsupported office format: ${ext}`);
    }
  }

  private async extractDocx(filePath: string): Promise<ExtractionResult> {
    const mammoth = await import('mammoth');
    const buffer = await readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }

  private async extractPptx(filePath: string): Promise<ExtractionResult> {
    const officeparser = await import('officeparser');
    const text = await officeparser.parseOffice(filePath) as string;
    return { text };
  }

  private async extractXlsx(filePath: string): Promise<ExtractionResult> {
    const XLSX = await import('xlsx');
    const buffer = await readFile(filePath);
    const workbook = XLSX.read(buffer);
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (workbook.SheetNames.length > 1) {
        lines.push(`## ${sheetName}\n${csv}`);
      } else {
        lines.push(csv);
      }
    }
    return { text: lines.join('\n\n') };
  }

  private async extractCsv(filePath: string): Promise<ExtractionResult> {
    const text = await readFile(filePath, 'utf-8');
    return { text };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/extractors/office.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/extractors/office.ts tests/extraction/extractors/office.test.ts
git commit -m "feat(phase6): add office document extractor"
```

---

## Task 7: PDF Text Extractor (unpdf)

**Files:**
- Create: `src/extraction/extractors/unpdf.ts`
- Test: `tests/extraction/extractors/unpdf.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/extractors/unpdf.test.ts
import { describe, it, expect } from 'vitest';
import { UnpdfExtractor } from '../../../src/extraction/extractors/unpdf.js';

describe('UnpdfExtractor', () => {
  it('has correct id, mediaType, and extensions', () => {
    const ext = new UnpdfExtractor();
    expect(ext.id).toBe('unpdf-text');
    expect(ext.mediaType).toBe('pdf');
    expect(ext.supportedExtensions).toEqual(['.pdf']);
  });

  it('extract function exists', () => {
    const ext = new UnpdfExtractor();
    expect(typeof ext.extract).toBe('function');
  });
});
```

Note: Real PDF extraction tests need actual PDF files. The interface test verifies the contract. Integration tests with fixture PDFs can be added separately.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/extractors/unpdf.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement UnpdfExtractor**

```typescript
// src/extraction/extractors/unpdf.ts
import { readFile } from 'node:fs/promises';
import type { Extractor, ExtractionResult } from '../types.js';

export class UnpdfExtractor implements Extractor {
  readonly id = 'unpdf-text';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const buffer = await readFile(filePath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return {
      text,
      metadata: { totalPages, avgCharsPerPage: Math.round(text.length / Math.max(totalPages, 1)) },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/extractors/unpdf.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/extractors/unpdf.ts tests/extraction/extractors/unpdf.test.ts
git commit -m "feat(phase6): add unpdf text extractor"
```

---

## Task 8: Deepgram Audio Extractor

**Files:**
- Create: `src/extraction/extractors/deepgram.ts`
- Test: `tests/extraction/extractors/deepgram.test.ts`

Requires `DEEPGRAM_API_KEY`. Tests cover the format function (pure logic) and interface checks.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/extractors/deepgram.test.ts
import { describe, it, expect } from 'vitest';
import { DeepgramExtractor, formatDiarizedTranscript, formatTimestamp } from '../../../src/extraction/extractors/deepgram.js';

describe('DeepgramExtractor', () => {
  it('has correct id, mediaType, and extensions', () => {
    const ext = new DeepgramExtractor('test-key');
    expect(ext.id).toBe('deepgram-nova-3');
    expect(ext.mediaType).toBe('audio');
    expect(ext.supportedExtensions).toEqual(['.m4a', '.mp3', '.wav', '.webm', '.ogg']);
  });
});

describe('formatTimestamp', () => {
  it('formats seconds into HH:MM:SS', () => {
    expect(formatTimestamp(0)).toBe('00:00:00');
    expect(formatTimestamp(12.5)).toBe('00:00:12');
    expect(formatTimestamp(65)).toBe('00:01:05');
    expect(formatTimestamp(3723.4)).toBe('01:02:03');
  });
});

describe('formatDiarizedTranscript', () => {
  it('formats speaker-labeled segments', () => {
    const segments = [
      { speaker: 0, start: 12.5, end: 18.0, text: 'We need to finalize the design by Friday.' },
      { speaker: 1, start: 18.2, end: 22.0, text: 'I can have the mockups ready by Wednesday.' },
    ];
    const result = formatDiarizedTranscript(segments);
    expect(result).toBe(
      '[Speaker 1] 00:00:12\nWe need to finalize the design by Friday.\n\n' +
      '[Speaker 2] 00:00:18\nI can have the mockups ready by Wednesday.'
    );
  });

  it('formats timestamp correctly for long recordings', () => {
    const segments = [
      { speaker: 0, start: 3723.4, end: 3730.0, text: 'An hour in.' },
    ];
    const result = formatDiarizedTranscript(segments);
    expect(result).toBe('[Speaker 1] 01:02:03\nAn hour in.');
  });

  it('handles empty segments array', () => {
    expect(formatDiarizedTranscript([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/extractors/deepgram.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement DeepgramExtractor**

```typescript
// src/extraction/extractors/deepgram.ts
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Extractor, ExtractionResult } from '../types.js';

export interface DiarizedSegment {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

const MIME_MAP: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
};

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDiarizedTranscript(segments: DiarizedSegment[]): string {
  if (segments.length === 0) return '';
  return segments.map(seg =>
    `[Speaker ${seg.speaker + 1}] ${formatTimestamp(seg.start)}\n${seg.text}`
  ).join('\n\n');
}

export class DeepgramExtractor implements Extractor {
  readonly id = 'deepgram-nova-3';
  readonly mediaType = 'audio';
  readonly supportedExtensions = ['.m4a', '.mp3', '.wav', '.webm', '.ogg'];

  constructor(private apiKey: string) {}

  async extract(filePath: string): Promise<ExtractionResult> {
    const { createClient } = await import('@deepgram/sdk');
    const deepgram = createClient(this.apiKey);

    const buffer = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimetype = MIME_MAP[ext] ?? 'audio/mpeg';

    const { result } = await deepgram.listen.prerecorded.transcribeFile(
      buffer,
      {
        model: 'nova-3',
        smart_format: true,
        diarize: true,
        mimetype,
      },
    );

    const utterances = result?.results?.utterances ?? [];
    const segments: DiarizedSegment[] = utterances.map((u: { speaker: number; start: number; end: number; transcript: string }) => ({
      speaker: u.speaker,
      start: u.start,
      end: u.end,
      text: u.transcript,
    }));

    const text = formatDiarizedTranscript(segments);

    return {
      text,
      metadata: { segments },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/extractors/deepgram.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/extractors/deepgram.ts tests/extraction/extractors/deepgram.test.ts
git commit -m "feat(phase6): add Deepgram audio extractor"
```

---

## Task 9: Claude Vision Extractors (Image + Scanned PDF)

**Files:**
- Create: `src/extraction/extractors/claude-vision.ts`
- Test: `tests/extraction/extractors/claude-vision.test.ts`

Two extractors in one file: `ClaudeVisionImageExtractor` for images, `ClaudeVisionPdfExtractor` for scanned PDFs.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/extractors/claude-vision.test.ts
import { describe, it, expect } from 'vitest';
import { ClaudeVisionImageExtractor, ClaudeVisionPdfExtractor } from '../../../src/extraction/extractors/claude-vision.js';

describe('ClaudeVisionImageExtractor', () => {
  it('has correct id, mediaType, and extensions', () => {
    const ext = new ClaudeVisionImageExtractor('test-key');
    expect(ext.id).toBe('claude-vision-image');
    expect(ext.mediaType).toBe('image');
    expect(ext.supportedExtensions).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  });
});

describe('ClaudeVisionPdfExtractor', () => {
  it('has correct id, mediaType, and extensions', () => {
    const ext = new ClaudeVisionPdfExtractor('test-key');
    expect(ext.id).toBe('claude-vision-pdf');
    expect(ext.mediaType).toBe('pdf');
    expect(ext.supportedExtensions).toEqual(['.pdf']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/extractors/claude-vision.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement Claude Vision extractors**

```typescript
// src/extraction/extractors/claude-vision.ts
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Extractor, ExtractionResult } from '../types.js';

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export class ClaudeVisionImageExtractor implements Extractor {
  readonly id = 'claude-vision-image';
  readonly mediaType = 'image';
  readonly supportedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  constructor(private apiKey: string) {}

  async extract(filePath: string): Promise<ExtractionResult> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const buffer = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const mediaType = IMAGE_MIME_MAP[ext] ?? 'image/png';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: buffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Extract all text from this image. If it contains handwriting, transcribe it. If it contains a diagram or photo, describe what you see. Return only the extracted content, no commentary.',
          },
        ],
      }],
    });

    const text = response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return { text };
  }
}

export class ClaudeVisionPdfExtractor implements Extractor {
  readonly id = 'claude-vision-pdf';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  constructor(private apiKey: string) {}

  async extract(filePath: string): Promise<ExtractionResult> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const buffer = await readFile(filePath);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: buffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Extract all text from this scanned PDF document. Transcribe any handwriting. Return only the extracted content, no commentary.',
          },
        ],
      }],
    });

    const text = response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return { text };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/extractors/claude-vision.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/extractors/claude-vision.ts tests/extraction/extractors/claude-vision.test.ts
git commit -m "feat(phase6): add Claude vision extractors for images and scanned PDFs"
```

---

## Task 10: Extraction Cache Layer

**Files:**
- Create: `src/extraction/cache.ts`
- Test: `tests/extraction/cache.test.ts`

The cache layer orchestrates hash-based lookup, extractor dispatch, DB storage, and the PDF text-to-scanned fallback logic.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let dir: string;

function makeExtractor(id: string, mediaType: string, extensions: string[], extractFn?: (fp: string) => Promise<ExtractionResult>): Extractor {
  return {
    id,
    mediaType,
    supportedExtensions: extensions,
    extract: extractFn ?? (async () => ({ text: `extracted by ${id}` })),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  dir = mkdtempSync(join(tmpdir(), 'cache-test-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ExtractionCache', () => {
  it('extracts and caches on first call', async () => {
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, 'hello world');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    const result = await cache.getExtraction(filePath);
    expect(result.text).toBe('extracted by markdown-read');
    expect(result.extractorId).toBe('markdown-read');
    expect(result.mediaType).toBe('markdown');

    // Verify it's in the DB
    const row = db.prepare('SELECT * FROM extraction_cache').get();
    expect(row).toBeTruthy();
  });

  it('returns cached result on second call (no re-extraction)', async () => {
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, 'hello world');

    let extractCount = 0;
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md'], async () => {
      extractCount++;
      return { text: 'extracted' };
    }));
    const cache = new ExtractionCache(db, registry);

    await cache.getExtraction(filePath);
    await cache.getExtraction(filePath);
    expect(extractCount).toBe(1);
  });

  it('re-extracts when file content changes', async () => {
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, 'version 1');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md'], async (fp) => {
      const { readFileSync } = await import('node:fs');
      return { text: readFileSync(fp, 'utf-8') };
    }));
    const cache = new ExtractionCache(db, registry);

    const r1 = await cache.getExtraction(filePath);
    expect(r1.text).toBe('version 1');

    writeFileSync(filePath, 'version 2');
    const r2 = await cache.getExtraction(filePath);
    expect(r2.text).toBe('version 2');
  });

  it('returns EXTRACTOR_UNAVAILABLE error for missing extractor', async () => {
    const filePath = join(dir, 'audio.m4a');
    writeFileSync(filePath, 'fake audio');

    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    const cache = new ExtractionCache(db, registry);

    await expect(cache.getExtraction(filePath)).rejects.toThrow('EXTRACTOR_UNAVAILABLE');
  });

  it('returns error for completely unknown extension', async () => {
    const filePath = join(dir, 'data.xyz');
    writeFileSync(filePath, 'mystery');

    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);

    await expect(cache.getExtraction(filePath)).rejects.toThrow('No extractor');
  });

  it('does not cache extraction failures', async () => {
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, 'hello');

    let callCount = 0;
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md'], async () => {
      callCount++;
      if (callCount === 1) throw new Error('API down');
      return { text: 'recovered' };
    }));
    const cache = new ExtractionCache(db, registry);

    await expect(cache.getExtraction(filePath)).rejects.toThrow('API down');
    const result = await cache.getExtraction(filePath);
    expect(result.text).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('stores metadata as JSON', async () => {
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, 'content');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md'], async () => ({
      text: 'hello',
      metadata: { pages: 3 },
    })));
    const cache = new ExtractionCache(db, registry);

    const result = await cache.getExtraction(filePath);
    expect(result.metadata).toEqual({ pages: 3 });
  });
});

describe('ExtractionCache PDF fallback', () => {
  it('uses vision fallback when text extraction yields sparse content', async () => {
    const filePath = join(dir, 'scanned.pdf');
    writeFileSync(filePath, 'fake pdf');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('unpdf-text', 'pdf', ['.pdf'], async () => ({
      text: 'ab',
      metadata: { totalPages: 1, avgCharsPerPage: 2 },
    })));
    const cache = new ExtractionCache(db, registry);

    const visionExtractor = makeExtractor('claude-vision-pdf', 'pdf', [], async () => ({
      text: 'Full scanned content from vision',
    }));
    cache.setPdfFallback(visionExtractor);

    const result = await cache.getExtraction(filePath);
    expect(result.text).toBe('Full scanned content from vision');
    expect(result.extractorId).toBe('claude-vision-pdf');
  });

  it('uses text result when text extraction is dense enough', async () => {
    const filePath = join(dir, 'text.pdf');
    writeFileSync(filePath, 'fake pdf');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('unpdf-text', 'pdf', ['.pdf'], async () => ({
      text: 'A'.repeat(200),
      metadata: { totalPages: 1, avgCharsPerPage: 200 },
    })));
    const cache = new ExtractionCache(db, registry);
    cache.setPdfFallback(makeExtractor('claude-vision-pdf', 'pdf', [], async () => ({
      text: 'should not be called',
    })));

    const result = await cache.getExtraction(filePath);
    expect(result.extractorId).toBe('unpdf-text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/cache.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement ExtractionCache**

```typescript
// src/extraction/cache.ts
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type Database from 'better-sqlite3';
import type { ExtractorRegistry } from './registry.js';
import type { Extractor, CachedExtraction } from './types.js';

const PDF_SPARSE_THRESHOLD = 50; // chars per page average

interface CacheRow {
  content_hash: string;
  file_path: string;
  media_type: string;
  extractor_id: string;
  extracted_text: string;
  metadata_json: string | null;
  extracted_at: string;
}

export class ExtractionCache {
  private pdfFallback: Extractor | null = null;

  constructor(
    private db: Database.Database,
    private registry: ExtractorRegistry,
  ) {}

  setPdfFallback(extractor: Extractor): void {
    this.pdfFallback = extractor;
  }

  async getExtraction(filePath: string): Promise<CachedExtraction> {
    const ext = extname(filePath).toLowerCase();

    // Check if extractor is available
    const extractor = this.registry.getForExtension(ext);
    if (!extractor) {
      const reason = this.registry.getUnavailableReason(ext);
      if (reason) {
        throw new Error(`EXTRACTOR_UNAVAILABLE: ${reason}`);
      }
      throw new Error(`No extractor registered for ${ext}`);
    }

    // Read file and compute hash
    const fileBuffer = await readFile(filePath);
    const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

    // Check cache
    const cached = this.db.prepare(
      'SELECT * FROM extraction_cache WHERE content_hash = ?'
    ).get(contentHash) as CacheRow | undefined;

    if (cached) {
      return {
        text: cached.extracted_text,
        metadata: cached.metadata_json ? JSON.parse(cached.metadata_json) : null,
        mediaType: cached.media_type,
        extractorId: cached.extractor_id,
        contentHash: cached.content_hash,
      };
    }

    // Extract
    let result = await extractor.extract(filePath);
    let usedExtractor = extractor;

    // PDF fallback: if text extraction is sparse, try vision
    if (ext === '.pdf' && this.pdfFallback) {
      const meta = result.metadata as { avgCharsPerPage?: number } | undefined;
      const avgChars = meta?.avgCharsPerPage ?? result.text.length;
      if (avgChars < PDF_SPARSE_THRESHOLD) {
        result = await this.pdfFallback.extract(filePath);
        usedExtractor = this.pdfFallback;
      }
    }

    // Store in cache
    this.db.prepare(`
      INSERT INTO extraction_cache (content_hash, file_path, media_type, extractor_id, extracted_text, metadata_json, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      contentHash,
      filePath,
      usedExtractor.mediaType,
      usedExtractor.id,
      result.text,
      result.metadata ? JSON.stringify(result.metadata) : null,
      new Date().toISOString(),
    );

    return {
      text: result.text,
      metadata: result.metadata ?? null,
      mediaType: usedExtractor.mediaType,
      extractorId: usedExtractor.id,
      contentHash,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/cache.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/cache.ts tests/extraction/cache.test.ts
git commit -m "feat(phase6): add extraction cache layer with PDF fallback"
```

---

## Task 11: Assembler — Embed Traversal & Resolution

**Files:**
- Create: `src/extraction/assembler.ts`
- Test: `tests/extraction/assembler.test.ts`

Walks node body for `![[embed]]` references, resolves via resolver, calls cache, handles recursive .md embeds with cycle detection.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/assembler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { assemble, parseEmbedReferences } from '../../src/extraction/assembler.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let dir: string;

function seedNode(id: string, filePath: string, title: string, body: string, types: string[] = []) {
  db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, filePath, title, body, 'h', 1000, 2000);
  for (const t of types) {
    db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(id, t);
  }
}

function makeExtractor(id: string, mediaType: string, extensions: string[], fn?: (fp: string) => Promise<ExtractionResult>): Extractor {
  return {
    id, mediaType, supportedExtensions: extensions,
    extract: fn ?? (async (fp) => {
      const { readFileSync } = await import('node:fs');
      return { text: readFileSync(fp, 'utf-8') };
    }),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  dir = mkdtempSync(join(tmpdir(), 'assembler-test-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseEmbedReferences', () => {
  it('extracts ![[embed]] references from body text', () => {
    const body = 'Some text\n![[recording.m4a]]\nMore text\n![[photo.png]]';
    expect(parseEmbedReferences(body)).toEqual(['recording.m4a', 'photo.png']);
  });

  it('ignores regular wiki-links', () => {
    const body = '[[not-an-embed]]\n![[real-embed.pdf]]';
    expect(parseEmbedReferences(body)).toEqual(['real-embed.pdf']);
  });

  it('returns empty array for no embeds', () => {
    expect(parseEmbedReferences('just text')).toEqual([]);
  });

  it('handles embeds with aliases (ignores alias)', () => {
    const body = '![[file.png|300]]';
    expect(parseEmbedReferences(body)).toEqual(['file.png']);
  });
});

describe('assemble', () => {
  it('assembles a node with non-markdown embeds', async () => {
    const audioPath = join(dir, 'recording.m4a');
    writeFileSync(audioPath, 'audio content');

    seedNode('n1', 'meeting.md', 'Meeting', '![[recording.m4a]]', ['meeting']);
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, ?, ?, ?)')
      .run('n1', 'project', 'Vault Engine', 'frontmatter');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('test-audio', 'audio', ['.m4a'], async () => ({
      text: 'Transcribed audio',
    })));
    const cache = new ExtractionCache(db, registry);

    const result = await assemble(db, 'n1', cache, dir);
    expect(result.node.title).toBe('Meeting');
    expect(result.node.types).toEqual(['meeting']);
    expect(result.node.fields).toHaveProperty('project');
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]).toEqual({
      reference: 'recording.m4a',
      mediaType: 'audio',
      text: 'Transcribed audio',
    });
    expect(result.errors).toEqual([]);
  });

  it('includes errors for failed extractions without stopping', async () => {
    seedNode('n1', 'test.md', 'Test', '![[audio.m4a]]\n![[doc.md]]');
    writeFileSync(join(dir, 'doc.md'), '# Doc content');

    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    const result = await assemble(db, 'n1', cache, dir);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].reference).toBe('doc.md');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reference).toBe('audio.m4a');
    expect(result.errors[0].error).toContain('EXTRACTOR_UNAVAILABLE');
  });

  it('recursively resolves markdown embeds with source attribution', async () => {
    mkdirSync(join(dir, 'notes'), { recursive: true });
    const notesPath = join(dir, 'notes', 'sub.md');
    writeFileSync(notesPath, '# Sub-note\n![[photo.png]]');
    const photoPath = join(dir, 'photo.png');
    writeFileSync(photoPath, 'image bytes');

    // sub.md is also indexed as a node so resolver can find it
    seedNode('n-sub', 'notes/sub.md', 'Sub-note', '# Sub-note\n![[photo.png]]');
    seedNode('n1', 'main.md', 'Main', '![[Sub-note]]');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    registry.register(makeExtractor('test-image', 'image', ['.png'], async () => ({
      text: 'Image description',
    })));
    const cache = new ExtractionCache(db, registry);

    const result = await assemble(db, 'n1', cache, dir);
    expect(result.embeds).toHaveLength(2);
    // First: the markdown embed itself
    expect(result.embeds[0]).toEqual({
      reference: 'Sub-note',
      mediaType: 'markdown',
      text: '# Sub-note\n![[photo.png]]',
    });
    // Second: the image found inside the markdown embed
    expect(result.embeds[1]).toEqual({
      reference: 'photo.png',
      mediaType: 'image',
      text: 'Image description',
      source: 'Sub-note',
    });
  });

  it('detects cycles in recursive markdown embeds', async () => {
    writeFileSync(join(dir, 'a.md'), '![[b.md]]');
    writeFileSync(join(dir, 'b.md'), '![[a.md]]');
    seedNode('na', 'a.md', 'A', '![[b.md]]');
    seedNode('nb', 'b.md', 'B', '![[a.md]]');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    const result = await assemble(db, 'na', cache, dir);
    // Should get b.md embed + a cycle skip (no infinite loop)
    expect(result.embeds.length).toBeGreaterThanOrEqual(1);
    expect(result.embeds.some(e => e.reference === 'b.md')).toBe(true);
  });

  it('respects maxEmbeds limit', async () => {
    const embeds = Array.from({ length: 5 }, (_, i) => `file${i}.md`);
    for (const name of embeds) {
      writeFileSync(join(dir, name), `Content of ${name}`);
    }
    seedNode('n1', 'test.md', 'Test', embeds.map(e => `![[${e}]]`).join('\n'));

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    const result = await assemble(db, 'n1', cache, dir, { maxEmbeds: 3 });
    expect(result.embeds).toHaveLength(3);
    expect(result.errors.some(e => e.error.includes('TRUNCATED'))).toBe(true);
  });

  it('respects file size limit', async () => {
    const filePath = join(dir, 'huge.md');
    writeFileSync(filePath, 'x'.repeat(200));
    seedNode('n1', 'test.md', 'Test', '![[huge.md]]');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    // Use a very small size limit for testing
    const result = await assemble(db, 'n1', cache, dir, { maxFileSizeBytes: 100 });
    expect(result.embeds).toHaveLength(0);
    expect(result.errors[0].error).toContain('FILE_TOO_LARGE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/assembler.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement the assembler**

```typescript
// src/extraction/assembler.ts
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ExtractionCache } from './cache.js';
import type { AssembledNode, EmbedEntry, EmbedError } from './types.js';
import { resolveTarget } from '../resolver/resolve.js';

const EMBED_RE = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const DEFAULT_MAX_EMBEDS = 20;
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const DEFAULT_MAX_DEPTH = 5;

export interface AssembleOptions {
  maxEmbeds?: number;
  maxFileSizeBytes?: number;
  maxDepth?: number;
}

/**
 * Parse ![[embed]] references from a body string.
 * Returns the reference part (filename/path), stripping any alias after |.
 */
export function parseEmbedReferences(body: string): string[] {
  const refs: string[] = [];
  EMBED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMBED_RE.exec(body)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Resolve an embed reference to a file path on disk.
 * Non-.md files: resolved relative to vault root.
 * .md files / no extension: use the node resolver (title/basename match).
 */
function resolveEmbedToFilePath(
  db: Database.Database,
  vaultPath: string,
  reference: string,
): string | null {
  const ext = extname(reference).toLowerCase();

  if (ext && ext !== '.md') {
    // Non-markdown file: resolve relative to vault root
    return join(vaultPath, reference);
  }

  // Markdown file or no extension: use the node resolver
  const target = reference.endsWith('.md') ? reference.slice(0, -3) : reference;
  const resolved = resolveTarget(db, target);
  if (resolved) {
    const row = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(resolved.id) as { file_path: string } | undefined;
    if (row) return join(vaultPath, row.file_path);
  }

  // Try with the full reference string
  const resolvedFull = resolveTarget(db, reference);
  if (resolvedFull) {
    const row = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(resolvedFull.id) as { file_path: string } | undefined;
    if (row) return join(vaultPath, row.file_path);
  }

  // Last resort: assume relative to vault
  return join(vaultPath, reference);
}

export async function assemble(
  db: Database.Database,
  nodeId: string,
  cache: ExtractionCache,
  vaultPath: string,
  options?: AssembleOptions,
): Promise<AssembledNode> {
  const maxEmbeds = options?.maxEmbeds ?? DEFAULT_MAX_EMBEDS;
  const maxFileSize = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Load node data
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as {
    id: string; file_path: string; title: string | null; body: string | null;
  } | undefined;

  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY rowid')
    .all(nodeId) as { schema_type: string }[]).map(t => t.schema_type);

  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(nodeId) as { field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }[];
  const fields: Record<string, unknown> = {};
  for (const f of fieldRows) {
    if (f.value_json !== null) fields[f.field_name] = JSON.parse(f.value_json);
    else if (f.value_number !== null) fields[f.field_name] = f.value_number;
    else if (f.value_date !== null) fields[f.field_name] = f.value_date;
    else fields[f.field_name] = f.value_text;
  }

  const embeds: EmbedEntry[] = [];
  const errors: EmbedError[] = [];

  if (node.body) {
    const refs = parseEmbedReferences(node.body);
    const visited = new Set<string>([nodeId]);

    await resolveEmbeds(db, cache, vaultPath, refs, null, visited, embeds, errors, maxEmbeds, maxFileSize, maxDepth, 0);
  }

  return {
    node: { title: node.title, types, fields },
    body: node.body,
    embeds,
    errors,
  };
}

async function resolveEmbeds(
  db: Database.Database,
  cache: ExtractionCache,
  vaultPath: string,
  refs: string[],
  parentRef: string | null,
  visited: Set<string>,
  embeds: EmbedEntry[],
  errors: EmbedError[],
  maxEmbeds: number,
  maxFileSize: number,
  maxDepth: number,
  depth: number,
): Promise<void> {
  for (const ref of refs) {
    // Check embed count limit
    if (embeds.length >= maxEmbeds) {
      errors.push({
        reference: ref,
        error: `TRUNCATED: embed limit reached (${maxEmbeds}). Remaining embeds skipped.`,
      });
      return;
    }

    const filePath = resolveEmbedToFilePath(db, vaultPath, ref);
    if (!filePath) {
      errors.push({ reference: ref, error: 'Could not resolve embed reference' });
      continue;
    }

    // Check file size
    try {
      const stats = await stat(filePath);
      if (stats.size > maxFileSize) {
        errors.push({ reference: ref, error: `FILE_TOO_LARGE: ${stats.size} bytes exceeds ${maxFileSize} byte limit` });
        continue;
      }
    } catch {
      errors.push({ reference: ref, error: `File not found: ${filePath}` });
      continue;
    }

    // Extract
    try {
      const result = await cache.getExtraction(filePath);
      const entry: EmbedEntry = {
        reference: ref,
        mediaType: result.mediaType,
        text: result.text,
      };
      if (parentRef) entry.source = parentRef;
      embeds.push(entry);

      // Recursive markdown embed resolution
      if (result.mediaType === 'markdown' && depth < maxDepth) {
        const ext = extname(ref).toLowerCase();
        const target = ext === '.md' ? ref.slice(0, -3) : ref;
        const resolved = resolveTarget(db, target) ?? resolveTarget(db, ref);
        if (resolved && !visited.has(resolved.id)) {
          visited.add(resolved.id);
          const subNode = db.prepare('SELECT body FROM nodes WHERE id = ?').get(resolved.id) as { body: string | null } | undefined;
          if (subNode?.body) {
            const subRefs = parseEmbedReferences(subNode.body);
            if (subRefs.length > 0) {
              await resolveEmbeds(db, cache, vaultPath, subRefs, ref, visited, embeds, errors, maxEmbeds, maxFileSize, maxDepth, depth + 1);
            }
          }
        }
      }
    } catch (err) {
      errors.push({ reference: ref, error: (err as Error).message });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/assembler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extraction/assembler.ts tests/extraction/assembler.test.ts
git commit -m "feat(phase6): add embed assembler with recursive resolution and cycle detection"
```

---

## Task 12: Registry Builder — Startup Wiring

**Files:**
- Create: `src/extraction/setup.ts`
- Modify: `src/mcp/server.ts` — extend `ServerContext`
- Modify: `src/index.ts` — build registry at startup
- Test: `tests/extraction/setup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/extraction/setup.test.ts
import { describe, it, expect } from 'vitest';
import { buildExtractorRegistry } from '../../src/extraction/setup.js';

describe('buildExtractorRegistry', () => {
  it('registers local extractors with no env vars', () => {
    const registry = buildExtractorRegistry({});
    const status = registry.getStatus();
    // Local extractors always present
    expect(status.active.map(e => e.id).sort()).toEqual([
      'markdown-read', 'office-doc', 'unpdf-text',
    ]);
    // Hosted extractors unavailable
    expect(status.unavailable.map(e => e.id).sort()).toEqual([
      'claude-vision-image', 'claude-vision-pdf', 'deepgram-nova-3',
    ]);
  });

  it('registers deepgram when DEEPGRAM_API_KEY is set', () => {
    const registry = buildExtractorRegistry({ DEEPGRAM_API_KEY: 'dk_test' });
    const status = registry.getStatus();
    expect(status.active.some(e => e.id === 'deepgram-nova-3')).toBe(true);
    expect(status.unavailable.some(e => e.id === 'deepgram-nova-3')).toBe(false);
  });

  it('registers claude vision when ANTHROPIC_API_KEY is set', () => {
    const registry = buildExtractorRegistry({ ANTHROPIC_API_KEY: 'sk-test' });
    const status = registry.getStatus();
    expect(status.active.some(e => e.id === 'claude-vision-image')).toBe(true);
    expect(status.active.some(e => e.id === 'claude-vision-pdf')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/extraction/setup.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Implement buildExtractorRegistry**

```typescript
// src/extraction/setup.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/extraction/setup.test.ts
```

Expected: PASS

- [ ] **Step 5: Update ServerContext in server.ts**

In `src/mcp/server.ts`, add imports and extend the context:

```typescript
import type { ExtractorRegistry } from '../extraction/registry.js';
import type { ExtractionCache } from '../extraction/cache.js';

export interface ServerContext {
  db: Database.Database;
  writeLock?: WriteLockManager;
  writeGate?: WriteGate;
  vaultPath?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
}
```

Update `createServer` to pass the new context fields through:

```typescript
export function createServer(db: Database.Database, ctx?: {
  writeLock?: WriteLockManager;
  writeGate?: WriteGate;
  vaultPath?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
}): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });
  registerAllTools(server, db, ctx);
  return server;
}
```

- [ ] **Step 6: Wire extraction into index.ts**

In `src/index.ts`, add after the migration calls and before watcher setup:

```typescript
import { buildExtractorRegistry } from './extraction/setup.js';
import { ExtractionCache } from './extraction/cache.js';
import { ClaudeVisionPdfExtractor } from './extraction/extractors/claude-vision.js';

// After upgradeToPhase6(db);
const extractorRegistry = buildExtractorRegistry(process.env as Record<string, string | undefined>);
const extractionCache = new ExtractionCache(db, extractorRegistry);

// Wire PDF fallback if Claude vision is available
if (process.env.ANTHROPIC_API_KEY) {
  extractionCache.setPdfFallback(new ClaudeVisionPdfExtractor(process.env.ANTHROPIC_API_KEY));
}
```

Update the server factory call:

```typescript
const serverFactory = () => createServer(db, { writeLock, writeGate, vaultPath, extractorRegistry, extractionCache });
```

- [ ] **Step 7: Verify build**

```bash
npm run build
```

Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/extraction/setup.ts tests/extraction/setup.test.ts src/mcp/server.ts src/index.ts
git commit -m "feat(phase6): wire extractor registry into server startup"
```

---

## Task 13: Extend `get-node` with `include_embeds` and `max_embeds`

**Files:**
- Modify: `src/mcp/tools/get-node.ts`
- Modify: `src/mcp/tools/index.ts`
- Test: `tests/mcp/get-node-embeds.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/get-node-embeds.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let dir: string;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(registerFn: (...args: unknown[]) => void, ...args: unknown[]) {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, ...args);
  return capturedHandler!;
}

function makeExtractor(id: string, mediaType: string, extensions: string[], fn?: (fp: string) => Promise<ExtractionResult>): Extractor {
  return {
    id, mediaType, supportedExtensions: extensions,
    extract: fn ?? (async (fp) => {
      const { readFileSync } = await import('node:fs');
      return { text: readFileSync(fp, 'utf-8') };
    }),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  dir = mkdtempSync(join(tmpdir(), 'get-node-embeds-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('get-node with embeds', () => {
  it('includes embeds when include_embeds is true', async () => {
    const audioPath = join(dir, 'rec.m4a');
    writeFileSync(audioPath, 'audio bytes');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', '![[rec.m4a]]', 'h1', 1000, 2000);

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('test-audio', 'audio', ['.m4a'], async () => ({
      text: 'Transcribed',
    })));
    const cache = new ExtractionCache(db, registry);

    const handler = getToolHandler(registerGetNode, db, cache, dir);
    const result = parseResult(await handler({ node_id: 'n1', include_embeds: true }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.embeds).toEqual([
      { reference: 'rec.m4a', mediaType: 'audio', text: 'Transcribed' },
    ]);
  });

  it('defaults include_embeds to true', async () => {
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', 'no embeds here', 'h1', 1000, 2000);

    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerGetNode, db, cache, dir);
    const result = parseResult(await handler({ node_id: 'n1' }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.embeds).toEqual([]);
    expect(result.embed_errors).toEqual([]);
  });

  it('omits embeds when include_embeds is false', async () => {
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', '![[audio.m4a]]', 'h1', 1000, 2000);

    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerGetNode, db, cache, dir);
    const result = parseResult(await handler({ node_id: 'n1', include_embeds: false }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result).not.toHaveProperty('embeds');
  });

  it('respects max_embeds parameter', async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `f${i}.md`), `Content ${i}`);
    }
    const body = Array.from({ length: 5 }, (_, i) => `![[f${i}.md]]`).join('\n');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', body, 'h1', 1000, 2000);

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerGetNode, db, cache, dir);
    const result = parseResult(await handler({ node_id: 'n1', max_embeds: 2 }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect((result.embeds as unknown[]).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/mcp/get-node-embeds.test.ts
```

Expected: FAIL — `registerGetNode` doesn't accept cache/vaultPath args

- [ ] **Step 3: Update get-node.ts**

Modify `src/mcp/tools/get-node.ts`. Key changes:

1. Import assembler and ExtractionCache types
2. Change function signature to accept optional cache and vaultPath
3. Add `include_embeds` and `max_embeds` to paramsShape
4. After building the existing result, conditionally run the assembler

Updated signature:

```typescript
import type { ExtractionCache } from '../../extraction/cache.js';
import { assemble } from '../../extraction/assembler.js';

export function registerGetNode(
  server: McpServer,
  db: Database.Database,
  extractionCache?: ExtractionCache,
  vaultPath?: string,
): void {
```

Updated params:

```typescript
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  include_embeds: z.boolean().optional().default(true),
  max_embeds: z.number().optional().default(20),
};
```

After the existing `return toolResult({...})`, change it to build a result object first, then conditionally add embeds:

```typescript
const resultObj: Record<string, unknown> = {
  id: node.id,
  file_path: node.file_path,
  title: node.title,
  types,
  fields,
  relationships: { outgoing: outgoingGrouped, incoming: incomingGrouped },
  body: node.body,
  metadata: {
    content_hash: node.content_hash,
    file_mtime: node.file_mtime,
    indexed_at: node.indexed_at,
  },
  conformance: getNodeConformance(db, node.id, types),
};

if (params.include_embeds && extractionCache && vaultPath) {
  const assembled = await assemble(db, node.id, extractionCache, vaultPath, {
    maxEmbeds: params.max_embeds,
  });
  resultObj.embeds = assembled.embeds;
  resultObj.embed_errors = assembled.errors;
} else if (params.include_embeds) {
  resultObj.embeds = [];
  resultObj.embed_errors = [];
}

return toolResult(resultObj);
```

- [ ] **Step 4: Update index.ts tool registration**

In `src/mcp/tools/index.ts`, change:

```typescript
registerGetNode(server, db);
```

to:

```typescript
registerGetNode(server, db, ctx?.extractionCache, ctx?.vaultPath);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/mcp/get-node-embeds.test.ts
```

Expected: PASS

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
npm test
```

Expected: All existing tests pass. The existing `get-node` tests still work because extractionCache is optional (undefined = no embeds added, but `include_embeds` defaults to true and hits the `else if` branch returning empty arrays).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/get-node.ts src/mcp/tools/index.ts tests/mcp/get-node-embeds.test.ts
git commit -m "feat(phase6): extend get-node with include_embeds and max_embeds"
```

---

## Task 14: New `read-embedded` Tool

**Files:**
- Create: `src/mcp/tools/read-embedded.ts`
- Modify: `src/mcp/tools/index.ts`
- Modify: `src/mcp/tools/errors.ts`
- Test: `tests/mcp/read-embedded.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/read-embedded.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { registerReadEmbedded } from '../../src/mcp/tools/read-embedded.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let dir: string;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(registerFn: (...args: unknown[]) => void, ...args: unknown[]) {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, ...args);
  return capturedHandler!;
}

function makeExtractor(id: string, mediaType: string, extensions: string[], fn?: (fp: string) => Promise<ExtractionResult>): Extractor {
  return {
    id, mediaType, supportedExtensions: extensions,
    extract: fn ?? (async (fp) => {
      const { readFileSync } = await import('node:fs');
      return { text: readFileSync(fp, 'utf-8') };
    }),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  dir = mkdtempSync(join(tmpdir(), 'read-embedded-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('read-embedded tool', () => {
  it('extracts content by file_path', async () => {
    const filePath = join(dir, 'doc.csv');
    writeFileSync(filePath, 'Name,Age\nAlice,30');

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('office-doc', 'office', ['.csv']));
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerReadEmbedded, db, cache, dir);

    const result = parseResult(await handler({ file_path: 'doc.csv' }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.text).toBe('Name,Age\nAlice,30');
    expect(result.media_type).toBe('office');
    expect(result.extractor_id).toBe('office-doc');
  });

  it('resolves filename to unique match', async () => {
    writeFileSync(join(dir, 'notes.md'), '# Notes');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'notes.md', 'Notes', '# Notes', 'h1', 1000, 2000);

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerReadEmbedded, db, cache, dir);

    const result = parseResult(await handler({ filename: 'notes.md' }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.text).toBe('# Notes');
  });

  it('returns AMBIGUOUS_FILENAME when multiple files match', async () => {
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'photo.png'), 'img1');
    writeFileSync(join(dir, 'b', 'photo.png'), 'img2');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'a/photo.png', 'photo', null, 'h1', 1000, 2000);
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n2', 'b/photo.png', 'photo', null, 'h2', 1000, 2000);

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('test-image', 'image', ['.png']));
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerReadEmbedded, db, cache, dir);

    const result = parseResult(await handler({ filename: 'photo.png' }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.code).toBe('AMBIGUOUS_FILENAME');
    expect(result.matches).toBeDefined();
  });

  it('returns error when neither file_path nor filename provided', async () => {
    const registry = new ExtractorRegistry();
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerReadEmbedded, db, cache, dir);

    const result = parseResult(await handler({}) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.code).toBe('INVALID_PARAMS');
  });

  it('returns EXTRACTOR_UNAVAILABLE for missing API key', async () => {
    writeFileSync(join(dir, 'audio.m4a'), 'bytes');
    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    const cache = new ExtractionCache(db, registry);
    const handler = getToolHandler(registerReadEmbedded, db, cache, dir);

    const result = parseResult(await handler({ file_path: 'audio.m4a' }) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result.code).toBe('EXTRACTOR_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/mcp/read-embedded.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Add new error codes to errors.ts**

In `src/mcp/tools/errors.ts`, update the type:

```typescript
export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR' | 'VALIDATION_FAILED' | 'UNKNOWN_TYPE' | 'EXTRACTOR_UNAVAILABLE' | 'AMBIGUOUS_FILENAME';
```

- [ ] **Step 4: Implement read-embedded tool**

```typescript
// src/mcp/tools/read-embedded.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { join, basename } from 'node:path';
import { toolResult } from './errors.js';
import type { ExtractionCache } from '../../extraction/cache.js';

export function registerReadEmbedded(
  server: McpServer,
  db: Database.Database,
  extractionCache: ExtractionCache,
  vaultPath: string,
): void {
  server.tool(
    'read-embedded',
    'Extract and return the content of a single embedded file. Supports audio (transcription), images (OCR), PDFs, office docs, and markdown. Specify file_path (vault-relative) or filename (basename to resolve).',
    {
      file_path: z.string().optional().describe('Vault-relative path to the file'),
      filename: z.string().optional().describe('Filename to resolve (basename match)'),
    },
    async (params) => {
      const { file_path, filename } = params;

      if (!file_path && !filename) {
        return toolResult({ error: 'Exactly one of file_path or filename is required', code: 'INVALID_PARAMS' });
      }
      if (file_path && filename) {
        return toolResult({ error: 'Provide only one of file_path or filename', code: 'INVALID_PARAMS' });
      }

      let resolvedPath: string;

      if (file_path) {
        resolvedPath = join(vaultPath, file_path);
      } else {
        // Resolve filename: find all nodes whose basename matches
        const allNodes = db.prepare('SELECT file_path FROM nodes').all() as { file_path: string }[];
        const matches = allNodes.filter(n => basename(n.file_path) === filename);

        if (matches.length === 0) {
          // File might not be a node (binary files). Fall back to direct path.
          resolvedPath = join(vaultPath, filename!);
        } else if (matches.length === 1) {
          resolvedPath = join(vaultPath, matches[0].file_path);
        } else {
          return toolResult({
            error: `Multiple files match "${filename}"`,
            code: 'AMBIGUOUS_FILENAME',
            matches: matches.map(m => m.file_path),
          });
        }
      }

      try {
        const result = await extractionCache.getExtraction(resolvedPath);
        return toolResult({
          text: result.text,
          media_type: result.mediaType,
          extractor_id: result.extractorId,
          content_hash: result.contentHash,
          metadata: result.metadata,
        });
      } catch (err) {
        const message = (err as Error).message;
        if (message.startsWith('EXTRACTOR_UNAVAILABLE')) {
          return toolResult({ error: message, code: 'EXTRACTOR_UNAVAILABLE' });
        }
        if (message.startsWith('No extractor')) {
          return toolResult({ error: message, code: 'INVALID_PARAMS' });
        }
        return toolResult({ error: message, code: 'INTERNAL_ERROR' });
      }
    },
  );
}
```

- [ ] **Step 5: Register in index.ts**

In `src/mcp/tools/index.ts`, add:

```typescript
import { registerReadEmbedded } from './read-embedded.js';
```

In the registration body, add after `registerGetNode`:

```typescript
if (ctx?.extractionCache && ctx?.vaultPath) {
  registerReadEmbedded(server, db, ctx.extractionCache, ctx.vaultPath);
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run tests/mcp/read-embedded.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/read-embedded.ts src/mcp/tools/errors.ts src/mcp/tools/index.ts tests/mcp/read-embedded.test.ts
git commit -m "feat(phase6): add read-embedded tool"
```

---

## Task 15: Extend `vault-stats` with Extractor Status

**Files:**
- Modify: `src/mcp/tools/vault-stats.ts`
- Modify: `src/mcp/tools/index.ts`
- Test: `tests/mcp/vault-stats-extractors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/vault-stats-extractors.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(registerFn: (...args: unknown[]) => void, ...args: unknown[]) {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, ...args);
  return capturedHandler!;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

describe('vault-stats extractor status', () => {
  it('includes extractors section in output', async () => {
    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    const handler = getToolHandler(registerVaultStats, db, registry);
    const result = parseResult(await handler({}) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result).toHaveProperty('extractors');
    const extractors = result.extractors as { active: unknown[]; unavailable: unknown[] };
    expect(extractors.unavailable).toHaveLength(1);
  });

  it('works without registry (backward compat)', async () => {
    const handler = getToolHandler(registerVaultStats, db);
    const result = parseResult(await handler({}) as { content: Array<{ type: string; text: string }> }) as Record<string, unknown>;
    expect(result).not.toHaveProperty('extractors');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/mcp/vault-stats-extractors.test.ts
```

Expected: FAIL — vault-stats doesn't accept registry param

- [ ] **Step 3: Update vault-stats.ts**

In `src/mcp/tools/vault-stats.ts`:

1. Add import: `import type { ExtractorRegistry } from '../../extraction/registry.js';`
2. Change signature: `export function registerVaultStats(server: McpServer, db: Database.Database, extractorRegistry?: ExtractorRegistry): void {`
3. Build the result as an object, conditionally add extractors:

```typescript
const resultObj: Record<string, unknown> = {
  node_count: nodeCount,
  type_counts: typeCounts,
  field_count: fieldCount,
  relationship_count: relationshipCount,
  orphan_count: orphanCount,
  schema_count: schemaCount,
};

if (extractorRegistry) {
  resultObj.extractors = extractorRegistry.getStatus();
}

return toolResult(resultObj);
```

- [ ] **Step 4: Update index.ts tool registration**

In `src/mcp/tools/index.ts`, change:

```typescript
registerVaultStats(server, db);
```

to:

```typescript
registerVaultStats(server, db, ctx?.extractorRegistry);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/mcp/vault-stats-extractors.test.ts
```

Expected: PASS

- [ ] **Step 6: Run full test suite**

```bash
npm test
```

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/vault-stats.ts src/mcp/tools/index.ts tests/mcp/vault-stats-extractors.test.ts
git commit -m "feat(phase6): add extractor status to vault-stats"
```

---

## Task 16: End-to-End Integration Test

**Files:**
- Create: `tests/phase6/end-to-end.test.ts`

Full integration: create temp vault with embedded files, build registry with mock extractors, call assemble, verify complete flow including caching and graceful degradation.

- [ ] **Step 1: Write the integration test**

```typescript
// tests/phase6/end-to-end.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { assemble } from '../../src/extraction/assembler.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';

let db: Database.Database;
let dir: string;

function makeExtractor(id: string, mediaType: string, extensions: string[], fn?: (fp: string) => Promise<ExtractionResult>): Extractor {
  return {
    id, mediaType, supportedExtensions: extensions,
    extract: fn ?? (async (fp) => {
      const { readFileSync } = await import('node:fs');
      return { text: readFileSync(fp, 'utf-8') };
    }),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  dir = mkdtempSync(join(tmpdir(), 'phase6-e2e-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Phase 6 end-to-end', () => {
  it('full meeting node scenario: audio + image + markdown embeds', async () => {
    // Set up vault files
    mkdirSync(join(dir, 'meetings'), { recursive: true });
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', 'recording.m4a'), 'audio bytes');
    writeFileSync(join(dir, 'attachments', 'whiteboard.png'), 'image bytes');
    writeFileSync(join(dir, 'action-items.md'), '# Action Items\n- Fix the bug\n- Review PR');

    // Index nodes
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'n1', 'meetings/standup.md', 'Standup',
      '# Standup\n![[recording.m4a]]\n![[whiteboard.png]]\n![[action-items.md]]',
      'h1', 1000, 2000
    );
    db.prepare('INSERT INTO node_types VALUES (?, ?)').run('n1', 'meeting');
    db.prepare('INSERT INTO node_fields (node_id, field_name, value_json, source) VALUES (?, ?, ?, ?)')
      .run('n1', 'people_involved', '["Alice","Bob"]', 'frontmatter');

    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'n2', 'action-items.md', 'Action Items',
      '# Action Items\n- Fix the bug\n- Review PR',
      'h2', 1000, 2000
    );

    // Build registry with mock extractors
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('mock-audio', 'audio', ['.m4a'], async () => ({
      text: '[Speaker 1] 00:00:00\nLet\'s start the standup.\n\n[Speaker 2] 00:00:05\nI worked on the API.',
      metadata: { segments: [{ speaker: 0, start: 0, end: 3, text: "Let's start the standup." }] },
    })));
    registry.register(makeExtractor('mock-image', 'image', ['.png'], async () => ({
      text: 'Whiteboard diagram showing API architecture with three microservices.',
    })));
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));

    const cache = new ExtractionCache(db, registry);

    // Assemble the meeting node
    const result = await assemble(db, 'n1', cache, dir);

    // Verify node metadata
    expect(result.node.title).toBe('Standup');
    expect(result.node.types).toEqual(['meeting']);
    expect(result.node.fields.people_involved).toEqual(['Alice', 'Bob']);

    // Verify embeds
    expect(result.embeds).toHaveLength(3);

    const audioEmbed = result.embeds.find(e => e.reference === 'recording.m4a');
    expect(audioEmbed).toBeDefined();
    expect(audioEmbed!.mediaType).toBe('audio');
    expect(audioEmbed!.text).toContain('[Speaker 1]');

    const imageEmbed = result.embeds.find(e => e.reference === 'whiteboard.png');
    expect(imageEmbed).toBeDefined();
    expect(imageEmbed!.mediaType).toBe('image');
    expect(imageEmbed!.text).toContain('Whiteboard diagram');

    const mdEmbed = result.embeds.find(e => e.reference === 'action-items.md');
    expect(mdEmbed).toBeDefined();
    expect(mdEmbed!.mediaType).toBe('markdown');
    expect(mdEmbed!.text).toContain('Fix the bug');

    expect(result.errors).toEqual([]);
  });

  it('graceful degradation: missing API key for audio', async () => {
    writeFileSync(join(dir, 'meeting.m4a'), 'audio bytes');
    writeFileSync(join(dir, 'notes.md'), '# Notes');

    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', '![[meeting.m4a]]\n![[notes.md]]', 'h1', 1000, 2000);
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n2', 'notes.md', 'Notes', '# Notes', 'h2', 1000, 2000);

    const registry = new ExtractorRegistry();
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    const result = await assemble(db, 'n1', cache, dir);

    // Markdown embed works
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].mediaType).toBe('markdown');

    // Audio fails gracefully
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reference).toBe('meeting.m4a');
    expect(result.errors[0].error).toContain('EXTRACTOR_UNAVAILABLE');
    expect(result.errors[0].error).toContain('DEEPGRAM_API_KEY');
  });

  it('cache hit: second call does not re-extract', async () => {
    writeFileSync(join(dir, 'doc.md'), '# Document');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', '![[doc.md]]', 'h1', 1000, 2000);
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n2', 'doc.md', 'Document', '# Document', 'h2', 1000, 2000);

    let extractCount = 0;
    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md'], async (fp) => {
      extractCount++;
      const { readFileSync } = await import('node:fs');
      return { text: readFileSync(fp, 'utf-8') };
    }));
    const cache = new ExtractionCache(db, registry);

    await assemble(db, 'n1', cache, dir);
    await assemble(db, 'n1', cache, dir);

    // Only extracted once, second call hits cache
    expect(extractCount).toBe(1);
  });

  it('extraction_cache table populated correctly', async () => {
    writeFileSync(join(dir, 'file.md'), '# Test content');
    db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('n1', 'test.md', 'Test', '![[file.md]]', 'h1', 1000, 2000);

    const registry = new ExtractorRegistry();
    registry.register(makeExtractor('markdown-read', 'markdown', ['.md']));
    const cache = new ExtractionCache(db, registry);

    await assemble(db, 'n1', cache, dir);

    const rows = db.prepare('SELECT * FROM extraction_cache').all() as Array<{
      content_hash: string; file_path: string; media_type: string;
      extractor_id: string; extracted_text: string; extracted_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].media_type).toBe('markdown');
    expect(rows[0].extractor_id).toBe('markdown-read');
    expect(rows[0].extracted_text).toBe('# Test content');
    expect(rows[0].extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run tests/phase6/end-to-end.test.ts
```

Expected: PASS (all components from Tasks 2-15 are already built)

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/phase6/end-to-end.test.ts
git commit -m "test(phase6): add end-to-end integration tests"
```

---

## Task 17: Build Verification & Final Wiring Check

- [ ] **Step 1: Run build**

```bash
npm run build
```

Expected: No TypeScript errors

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: All tests pass

- [ ] **Step 3: Verify index.ts wiring is complete**

Read `src/index.ts` and verify:
1. `upgradeToPhase6(db)` is called after `upgradeToPhase3(db)`
2. `buildExtractorRegistry(process.env)` is called
3. `ExtractionCache` is created with the registry
4. PDF fallback is wired when `ANTHROPIC_API_KEY` is present
5. `extractorRegistry` and `extractionCache` are passed to `createServer`

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat(phase6): content extraction complete — extractors, cache, assembler, tools"
```
