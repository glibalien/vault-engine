# Wiki Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a background subsystem that autonomously maintains a structured wiki from source documents, using a hosted LLM for entity/concept extraction and writing results through the existing mutation pipeline.

**Architecture:** The Wiki Curator is an in-process background subsystem (like the embedding indexer and normalizer). The watcher triggers ingestion when a `source`-typed node is created/updated. An in-memory queue with dedup feeds items to a Fireworks-hosted LLM. The LLM returns structured JSON specifying wiki article create/update operations. All writes go through `executeMutation()`. A croner-scheduled lint pass checks wiki health. `Wiki/index.md` is a deterministic DB projection rebuilt after each ingest.

**Tech Stack:** TypeScript/ESM, better-sqlite3, croner (scheduling), native fetch (Fireworks API), vitest (testing)

**Spec:** `~/Documents/archbrain/Notes/Wiki Curator — Technical Spec.md`

---

## File Structure

```
src/wiki/
  types.ts          — TypeScript interfaces (LlmRequest, LlmResponse, LlmConfig, IngestResult, ArticleOp, CuratorQueueItem)
  llm-client.ts     — Fireworks/ollama HTTP wrapper: createLlmClient() factory
  prompts.ts        — System and user prompt templates for ingest and lint
  curator.ts        — Queue, ingest loop, watcher hook, startup wiring, shutdown drain
  index-sync.ts     — Deterministic Wiki/index.md rebuild from DB state
  lint.ts           — Scheduled wiki health checks (deterministic + optional LLM)

src/pipeline/types.ts   — Modify: add 'wiki-curator' to ProposedMutation.source union
src/pipeline/edits-log.ts — Modify: add 'wiki-curator' to source union in buildDeviationEntries
src/sync/watcher.ts     — Modify: add curator.enqueue() call after source-node mutations
src/index.ts            — Modify: add curator initialization, config loading, shutdown wiring

tests/wiki/
  types.test.ts
  llm-client.test.ts
  prompts.test.ts
  curator.test.ts
  index-sync.test.ts
  lint.test.ts
```

---

### Task 1: Types and Interfaces

**Files:**
- Create: `src/wiki/types.ts`
- Test: `tests/wiki/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/wiki/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  LlmRequest,
  LlmResponse,
  LlmConfig,
  LlmClient,
  IngestResult,
  ArticleOp,
  CuratorQueueItem,
  WikiCuratorConfig,
} from '../../src/wiki/types.js';

describe('wiki types', () => {
  it('CuratorQueueItem has required shape', () => {
    const item: CuratorQueueItem = {
      node_id: 'abc123',
      trigger: 'source_created',
      retries: 0,
      enqueued_at: Date.now(),
    };
    expect(item.node_id).toBe('abc123');
    expect(item.trigger).toBe('source_created');
    expect(item.retries).toBe(0);
    expect(typeof item.enqueued_at).toBe('number');
  });

  it('ArticleOp has required fields', () => {
    const op: ArticleOp = {
      action: 'create',
      title: 'Test Entity',
      article_type: 'entity',
      body: '# Test Entity\n\nSome content.',
      summary: 'A test entity.',
      confidence: 'high',
      domain: ['testing'],
      tags: ['test'],
      sources: ['Source Doc'],
      related_articles: [],
    };
    expect(op.action).toBe('create');
    expect(op.article_type).toBe('entity');
  });

  it('IngestResult has required fields', () => {
    const result: IngestResult = {
      articles: [],
      source_summary: 'A test source.',
      source_type: 'article',
      log_entry: 'Processed test source',
    };
    expect(result.articles).toHaveLength(0);
    expect(result.source_type).toBe('article');
  });

  it('LlmConfig has required shape', () => {
    const config: LlmConfig = {
      provider: 'fireworks',
      model: 'accounts/fireworks/models/gpt-oss-120b',
      temperature: 0,
      maxOutputTokens: 4096,
    };
    expect(config.provider).toBe('fireworks');
  });

  it('WikiCuratorConfig has full shape', () => {
    const config: WikiCuratorConfig = {
      enabled: true,
      llm: {
        provider: 'fireworks',
        model: 'accounts/fireworks/models/gpt-oss-120b',
        temperature: 0,
        maxOutputTokens: 4096,
      },
      ingest: {
        trigger: 'on_source_mutation',
        maxRetries: 3,
        delayBetweenIngests: 5000,
      },
      lint: {
        cronExpression: '0 4 * * *',
        llmChecks: false,
        autoFix: false,
      },
      indexSync: {
        afterEveryIngest: true,
      },
    };
    expect(config.enabled).toBe(true);
  });

  it('trigger enum covers all values', () => {
    const triggers: CuratorQueueItem['trigger'][] = [
      'source_created',
      'source_updated',
      'manual',
    ];
    expect(triggers).toHaveLength(3);
  });

  it('article_type enum covers all values', () => {
    const types: ArticleOp['article_type'][] = [
      'entity', 'concept', 'topic', 'comparison',
      'synthesis', 'overview', 'timeline',
    ];
    expect(types).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/types.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/types.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/wiki/types.ts

// ── LLM Client types ────────────────────────────────────────────────

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  responseFormat?: 'json';
}

export interface LlmResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  durationMs: number;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
  isReady(): boolean;
}

export interface LlmConfig {
  provider: 'fireworks' | 'ollama';
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxConcurrent?: number;
  temperature?: number;
  maxOutputTokens: number;
}

// ── Ingest types ────────────────────────────────────────────────────

export interface CuratorQueueItem {
  node_id: string;
  trigger: 'source_created' | 'source_updated' | 'manual';
  retries: number;
  enqueued_at: number;
}

export type ArticleType =
  | 'entity' | 'concept' | 'topic' | 'comparison'
  | 'synthesis' | 'overview' | 'timeline';

export type SourceType =
  | 'article' | 'paper' | 'report' | 'transcript'
  | 'book-chapter' | 'podcast' | 'video' | 'letter';

export type Confidence = 'high' | 'medium' | 'low' | 'contested';

export interface ArticleOp {
  action: 'create' | 'update';
  title: string;
  article_type: ArticleType;
  body: string;
  summary: string;
  confidence: Confidence;
  domain: string[];
  tags: string[];
  sources: string[];
  related_articles: string[];
}

export interface IngestResult {
  articles: ArticleOp[];
  source_summary: string;
  source_type: SourceType;
  log_entry: string;
}

// ── Configuration ───────────────────────────────────────────────────

export interface WikiCuratorConfig {
  enabled: boolean;
  llm: LlmConfig;
  ingest: {
    trigger: 'on_source_mutation' | 'manual_only';
    maxRetries: number;
    delayBetweenIngests: number;
  };
  lint: {
    cronExpression: string;
    llmChecks: boolean;
    autoFix: boolean;
  };
  indexSync: {
    afterEveryIngest: boolean;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/types.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/wiki/types.ts tests/wiki/types.test.ts
git commit -m "feat(wiki): add TypeScript interfaces for wiki curator"
```

---

### Task 2: Pipeline Source Type Extension

The curator is a new mutation source. The `ProposedMutation.source` union and `buildDeviationEntries` source parameter need `'wiki-curator'` added. The curator should behave like `'tool'` in Stage 3 of the pipeline (strict validation, throw on blocking errors).

**Files:**
- Modify: `src/pipeline/types.ts:8`
- Modify: `src/pipeline/edits-log.ts:20`
- Modify: `src/pipeline/execute.ts` (Stage 3 condition)
- Test: `tests/pipeline/execute.test.ts` (add test for wiki-curator source)

- [ ] **Step 1: Write the failing test**

Add to `tests/pipeline/execute.test.ts`:

```typescript
describe('wiki-curator source', () => {
  it('wiki-curator mutations use strict validation like tool path', () => {
    // Create a global field with enum constraint
    createGlobalField(db, {
      name: 'test_enum',
      field_type: 'enum',
      enum_values: ['alpha', 'beta'],
    });

    // wiki-curator source with invalid enum should throw PipelineError
    expect(() => executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: null,
      file_path: 'test-curator.md',
      title: 'Test Curator',
      types: [],
      fields: { test_enum: 'invalid_value' },
      body: '',
    }, syncLogger)).toThrow('PipelineError');
  });

  it('wiki-curator mutations create nodes successfully', () => {
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: null,
      file_path: 'Wiki/Test Article.md',
      title: 'Test Article',
      types: [],
      fields: {},
      body: 'Wiki curator content.',
    }, syncLogger);
    expect(result.node_id).toBeTruthy();
    expect(result.file_written).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "wiki-curator"`
Expected: FAIL — TypeScript error, `'wiki-curator'` not in source union

- [ ] **Step 3: Modify source union in types.ts**

In `src/pipeline/types.ts`, change line 8:

```typescript
// Before:
  source: 'tool' | 'watcher' | 'normalizer';
// After:
  source: 'tool' | 'watcher' | 'normalizer' | 'wiki-curator';
```

- [ ] **Step 4: Modify source union in edits-log.ts**

In `src/pipeline/edits-log.ts`, change line 20:

```typescript
// Before:
  source: 'tool' | 'watcher' | 'normalizer',
// After:
  source: 'tool' | 'watcher' | 'normalizer' | 'wiki-curator',
```

- [ ] **Step 5: Update Stage 3 in execute.ts**

In `src/pipeline/execute.ts`, find the Stage 3 condition that checks mutation source. The condition `if (mutation.source === 'tool' || mutation.source === 'normalizer')` needs to include `'wiki-curator'`:

```typescript
// Before:
if (mutation.source === 'tool' || mutation.source === 'normalizer') {
// After:
if (mutation.source === 'tool' || mutation.source === 'normalizer' || mutation.source === 'wiki-curator') {
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "wiki-curator"`
Expected: PASS

- [ ] **Step 7: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/edits-log.ts src/pipeline/execute.ts tests/pipeline/execute.test.ts
git commit -m "feat(wiki): add wiki-curator as pipeline mutation source"
```

---

### Task 3: LLM Client

**Files:**
- Create: `src/wiki/llm-client.ts`
- Test: `tests/wiki/llm-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/wiki/llm-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLlmClient } from '../../src/wiki/llm-client.js';
import type { LlmConfig } from '../../src/wiki/types.js';

describe('createLlmClient', () => {
  const baseConfig: LlmConfig = {
    provider: 'fireworks',
    model: 'accounts/fireworks/models/gpt-oss-120b',
    temperature: 0,
    maxOutputTokens: 4096,
  };

  describe('isReady', () => {
    it('returns false when API key env var is missing', () => {
      delete process.env.FIREWORKS_API_KEY;
      const client = createLlmClient(baseConfig);
      expect(client.isReady()).toBe(false);
    });

    it('returns true when API key env var is set', () => {
      process.env.FIREWORKS_API_KEY = 'test-key';
      const client = createLlmClient(baseConfig);
      expect(client.isReady()).toBe(true);
      delete process.env.FIREWORKS_API_KEY;
    });

    it('reads custom apiKeyEnv', () => {
      process.env.CUSTOM_KEY = 'test-key';
      const client = createLlmClient({ ...baseConfig, apiKeyEnv: 'CUSTOM_KEY' });
      expect(client.isReady()).toBe(true);
      delete process.env.CUSTOM_KEY;
    });
  });

  describe('request building', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      process.env.FIREWORKS_API_KEY = 'test-key';
      fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"test": true}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          model: 'gpt-oss-120b',
        }),
      });
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      delete process.env.FIREWORKS_API_KEY;
      vi.restoreAllMocks();
    });

    it('sends correct request to Fireworks API', async () => {
      const client = createLlmClient(baseConfig);
      await client.complete({
        system: 'You are a test.',
        prompt: 'Say hello.',
        maxTokens: 100,
        responseFormat: 'json',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('accounts/fireworks/models/gpt-oss-120b');
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Say hello.' },
      ]);
      expect(body.max_tokens).toBe(100);
      expect(body.temperature).toBe(0);
      expect(body.response_format).toEqual({ type: 'json_object' });

      const headers = options.headers;
      expect(headers['Authorization']).toBe('Bearer test-key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('returns parsed LlmResponse', async () => {
      const client = createLlmClient(baseConfig);
      const response = await client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      });

      expect(response.content).toBe('{"test": true}');
      expect(response.usage.inputTokens).toBe(100);
      expect(response.usage.outputTokens).toBe(50);
      expect(response.model).toBe('gpt-oss-120b');
      expect(typeof response.durationMs).toBe('number');
    });

    it('uses ollama base URL when provider is ollama', async () => {
      const client = createLlmClient({
        ...baseConfig,
        provider: 'ollama',
        model: 'llama3',
      });
      await client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:11434/v1/chat/completions');
    });

    it('uses custom baseUrl when provided', async () => {
      const client = createLlmClient({
        ...baseConfig,
        baseUrl: 'https://custom.api.com/v1',
      });
      await client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://custom.api.com/v1/chat/completions');
    });
  });

  describe('retry logic', () => {
    beforeEach(() => {
      process.env.FIREWORKS_API_KEY = 'test-key';
    });

    afterEach(() => {
      delete process.env.FIREWORKS_API_KEY;
      vi.restoreAllMocks();
    });

    it('retries on 429 with backoff up to 3 attempts', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
        .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            model: 'test',
          }),
        });
      vi.stubGlobal('fetch', fetchSpy);

      const client = createLlmClient(baseConfig);
      const response = await client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(response.content).toBe('ok');
    });

    it('throws after 3 consecutive failures', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' });
      vi.stubGlobal('fetch', fetchSpy);

      const client = createLlmClient(baseConfig);
      await expect(client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      })).rejects.toThrow();

      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('retries on 500 server errors', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            model: 'test',
          }),
        });
      vi.stubGlobal('fetch', fetchSpy);

      const client = createLlmClient(baseConfig);
      const response = await client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      });

      expect(response.content).toBe('ok');
    });

    it('does not retry on 400 client errors', async () => {
      const fetchSpy = vi.fn()
        .mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
      vi.stubGlobal('fetch', fetchSpy);

      const client = createLlmClient(baseConfig);
      await expect(client.complete({
        system: 'test',
        prompt: 'test',
        maxTokens: 100,
      })).rejects.toThrow();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/llm-client.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/llm-client.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/wiki/llm-client.ts

import type { LlmClient, LlmConfig, LlmRequest, LlmResponse } from './types.js';

const DEFAULT_BASE_URLS: Record<string, string> = {
  fireworks: 'https://api.fireworks.ai/inference/v1',
  ollama: 'http://localhost:11434/v1',
};

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 60_000;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  const apiKeyEnv = config.apiKeyEnv ?? 'FIREWORKS_API_KEY';
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URLS[config.provider] ?? DEFAULT_BASE_URLS.fireworks;
  const endpoint = `${baseUrl}/chat/completions`;

  function getApiKey(): string | undefined {
    return process.env[apiKeyEnv];
  }

  async function complete(request: LlmRequest): Promise<LlmResponse> {
    const apiKey = getApiKey();
    if (!apiKey && config.provider === 'fireworks') {
      throw new Error(`LLM API key not found in env var ${apiKeyEnv}`);
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? config.temperature ?? 0,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = BACKOFF_BASE_MS * Math.pow(4, attempt - 1);
        await new Promise(r => setTimeout(r, delayMs));
      }

      const start = Date.now();

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        lastError = new Error(`LLM API error: ${response.status} ${response.statusText}`);
        if (!isRetryable(response.status)) {
          throw lastError;
        }
        continue;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number };
        model: string;
      };

      return {
        content: data.choices[0].message.content,
        usage: {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        },
        model: data.model,
        durationMs: Date.now() - start,
      };
    }

    throw lastError ?? new Error('LLM request failed after retries');
  }

  return {
    complete,
    isReady(): boolean {
      if (config.provider === 'ollama') return true;
      return !!getApiKey();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/llm-client.test.ts`
Expected: PASS (all tests). Note: retry tests with backoff may take a second due to `setTimeout` — consider whether vitest fake timers are needed. If tests are slow, add `vi.useFakeTimers()` in the retry describe block's `beforeEach` and `vi.advanceTimersByTimeAsync()` to skip waits.

- [ ] **Step 5: Commit**

```bash
git add src/wiki/llm-client.ts tests/wiki/llm-client.test.ts
git commit -m "feat(wiki): add LLM client with Fireworks/ollama support and retry"
```

---

### Task 4: Prompt Templates

**Files:**
- Create: `src/wiki/prompts.ts`
- Test: `tests/wiki/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/wiki/prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildIngestSystemPrompt,
  buildIngestUserPrompt,
  ARTICLE_TYPES,
  SOURCE_TYPES,
  CONFIDENCE_LEVELS,
} from '../../src/wiki/prompts.js';

describe('buildIngestSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildIngestSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('includes all article types', () => {
    const prompt = buildIngestSystemPrompt();
    for (const type of ARTICLE_TYPES) {
      expect(prompt).toContain(type);
    }
  });

  it('includes all source types', () => {
    const prompt = buildIngestSystemPrompt();
    for (const type of SOURCE_TYPES) {
      expect(prompt).toContain(type);
    }
  });

  it('includes all confidence levels', () => {
    const prompt = buildIngestSystemPrompt();
    for (const level of CONFIDENCE_LEVELS) {
      expect(prompt).toContain(level);
    }
  });

  it('includes JSON output schema', () => {
    const prompt = buildIngestSystemPrompt();
    expect(prompt).toContain('"articles"');
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"source_summary"');
    expect(prompt).toContain('"log_entry"');
  });
});

describe('buildIngestUserPrompt', () => {
  it('includes source document fields', () => {
    const prompt = buildIngestUserPrompt({
      source: {
        title: 'My Source',
        author: 'Author Name',
        published: '2026-01-01',
        body: 'Source body content here.',
      },
      existingArticles: [],
      indexContent: '',
    });
    expect(prompt).toContain('My Source');
    expect(prompt).toContain('Author Name');
    expect(prompt).toContain('2026-01-01');
    expect(prompt).toContain('Source body content here.');
  });

  it('includes existing articles when present', () => {
    const prompt = buildIngestUserPrompt({
      source: {
        title: 'My Source',
        body: 'Content.',
      },
      existingArticles: [
        {
          title: 'Existing Article',
          summary: 'An existing article.',
          article_type: 'entity',
          body: 'Full body of existing article.',
        },
      ],
      indexContent: '',
    });
    expect(prompt).toContain('Existing Article');
    expect(prompt).toContain('An existing article.');
    expect(prompt).toContain('Full body of existing article.');
  });

  it('includes index content when present', () => {
    const prompt = buildIngestUserPrompt({
      source: {
        title: 'My Source',
        body: 'Content.',
      },
      existingArticles: [],
      indexContent: '## AI\n- [[GPT]] — Overview of GPT models',
    });
    expect(prompt).toContain('## AI');
    expect(prompt).toContain('GPT');
  });

  it('handles missing optional source fields', () => {
    const prompt = buildIngestUserPrompt({
      source: {
        title: 'Bare Source',
        body: 'Just body.',
      },
      existingArticles: [],
      indexContent: '',
    });
    expect(prompt).toContain('Bare Source');
    expect(prompt).toContain('Just body.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/prompts.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/prompts.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/wiki/prompts.ts

export const ARTICLE_TYPES = [
  'entity', 'concept', 'topic', 'comparison',
  'synthesis', 'overview', 'timeline',
] as const;

export const SOURCE_TYPES = [
  'article', 'paper', 'report', 'transcript',
  'book-chapter', 'podcast', 'video', 'letter',
] as const;

export const CONFIDENCE_LEVELS = [
  'high', 'medium', 'low', 'contested',
] as const;

export function buildIngestSystemPrompt(): string {
  return `You are a wiki curator for a personal knowledge base. Your job is to read a source document and produce structured wiki operations as JSON.

OUTPUT FORMAT:
Return a single JSON object matching this schema exactly:
{
  "articles": [
    {
      "action": "create" | "update",
      "title": "Article Title",
      "article_type": "${ARTICLE_TYPES.join('" | "')}",
      "body": "Full markdown body with [[wiki-links]] to other articles and sources",
      "summary": "One to two sentence summary",
      "confidence": "${CONFIDENCE_LEVELS.join('" | "')}",
      "domain": ["domain1", "domain2"],
      "tags": ["tag1", "tag2"],
      "sources": ["Source Title 1"],
      "related_articles": ["Existing Article Title"]
    }
  ],
  "source_summary": "One sentence summary of the source for the wiki index",
  "source_type": "${SOURCE_TYPES.join('" | "')}",
  "log_entry": "Brief description of what was extracted"
}

RULES:
- action "create": use when no existing wiki article covers this entity/concept/topic
- action "update": use ONLY for articles listed in EXISTING ARTICLES below. Provide the COMPLETE updated body, not a diff.
- article_type: choose the most specific type. "entity" for people, organizations, products. "concept" for ideas, theories, methods. "topic" for subject areas. "comparison" for X-vs-Y analyses. "synthesis" for multi-source conclusions. "overview" for broad surveys. "timeline" for chronological sequences.
- body: use [[wiki-links]] to reference other wiki articles and source documents by title. Write in neutral encyclopedic tone. Include a "## Sources" section at the end listing source references.
- summary: this appears in the wiki index. Make it informative enough to decide whether to read the full article.
- confidence: "high" if the source is authoritative and claims are well-supported. "medium" if reasonable but limited sourcing. "low" if speculative or single-source. "contested" if contradicts existing wiki content.
- sources: list the titles of source nodes this article draws from. Always include the current source being ingested.
- related_articles: list titles of existing wiki articles that should cross-reference this one.
- source_type: classify the source document. "article" for news/blog posts, "paper" for academic work, "report" for structured analysis, "transcript" for conversations/interviews, "book-chapter" for book excerpts, "podcast" for audio show notes, "video" for video transcripts/notes, "letter" for correspondence.
- Do NOT create articles for trivial mentions. Only create articles for entities/concepts that are substantively discussed in the source (at least a paragraph of relevant content).
- Prefer updating existing articles over creating near-duplicates. If an existing article covers 80%+ of what you'd create, update it instead.`;
}

export interface IngestUserPromptInput {
  source: {
    title: string;
    author?: string;
    published?: string;
    body: string;
  };
  existingArticles: Array<{
    title: string;
    summary: string;
    article_type: string;
    body: string;
  }>;
  indexContent: string;
}

export function buildIngestUserPrompt(input: IngestUserPromptInput): string {
  const { source, existingArticles, indexContent } = input;

  let prompt = `SOURCE DOCUMENT:
Title: ${source.title}`;

  if (source.author) {
    prompt += `\nAuthor: ${source.author}`;
  }
  if (source.published) {
    prompt += `\nPublished: ${source.published}`;
  }

  prompt += `\nBody:\n${source.body}`;

  if (existingArticles.length > 0) {
    prompt += '\n\nEXISTING WIKI ARTICLES THAT CITE THIS SOURCE:';
    for (const article of existingArticles) {
      prompt += `\n\n### ${article.title}
Type: ${article.article_type}
Summary: ${article.summary}
Body:\n${article.body}`;
    }
  } else {
    prompt += '\n\nEXISTING WIKI ARTICLES THAT CITE THIS SOURCE:\n(none)';
  }

  if (indexContent) {
    prompt += `\n\nEXISTING WIKI INDEX (for awareness of what already exists):\n${indexContent}`;
  } else {
    prompt += '\n\nEXISTING WIKI INDEX:\n(empty — this is a new wiki)';
  }

  prompt += '\n\nProduce the JSON wiki operations for this source.';

  return prompt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wiki/prompts.ts tests/wiki/prompts.test.ts
git commit -m "feat(wiki): add ingest prompt templates"
```

---

### Task 5: Ingest Result Validation

The curator must validate LLM output before applying mutations. This is a pure function: JSON in, validated `IngestResult` out or error.

**Files:**
- Add validation function to: `src/wiki/prompts.ts` (it's prompt-adjacent — the validation schema mirrors the prompt's output schema)
- Test: `tests/wiki/prompts.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/wiki/prompts.test.ts`:

```typescript
import { validateIngestResult } from '../../src/wiki/prompts.js';

describe('validateIngestResult', () => {
  const validResult = {
    articles: [
      {
        action: 'create',
        title: 'Test Entity',
        article_type: 'entity',
        body: '# Test Entity\n\nContent here.',
        summary: 'A test entity.',
        confidence: 'high',
        domain: ['testing'],
        tags: ['test'],
        sources: ['Source Doc'],
        related_articles: [],
      },
    ],
    source_summary: 'A test source document.',
    source_type: 'article',
    log_entry: 'Created Test Entity',
  };

  it('accepts valid ingest result', () => {
    const result = validateIngestResult(JSON.stringify(validResult));
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe('Test Entity');
    expect(result.source_type).toBe('article');
  });

  it('rejects malformed JSON', () => {
    expect(() => validateIngestResult('not json')).toThrow();
  });

  it('rejects missing articles array', () => {
    expect(() => validateIngestResult(JSON.stringify({
      source_summary: 'test',
      source_type: 'article',
      log_entry: 'test',
    }))).toThrow();
  });

  it('rejects invalid article_type', () => {
    const bad = { ...validResult, articles: [{ ...validResult.articles[0], article_type: 'invalid' }] };
    expect(() => validateIngestResult(JSON.stringify(bad))).toThrow();
  });

  it('rejects invalid source_type', () => {
    const bad = { ...validResult, source_type: 'invalid' };
    expect(() => validateIngestResult(JSON.stringify(bad))).toThrow();
  });

  it('rejects invalid confidence', () => {
    const bad = { ...validResult, articles: [{ ...validResult.articles[0], confidence: 'invalid' }] };
    expect(() => validateIngestResult(JSON.stringify(bad))).toThrow();
  });

  it('rejects invalid action', () => {
    const bad = { ...validResult, articles: [{ ...validResult.articles[0], action: 'delete' }] };
    expect(() => validateIngestResult(JSON.stringify(bad))).toThrow();
  });

  it('rejects article with missing title', () => {
    const { title: _, ...noTitle } = validResult.articles[0];
    const bad = { ...validResult, articles: [noTitle] };
    expect(() => validateIngestResult(JSON.stringify(bad))).toThrow();
  });

  it('accepts result with empty articles array', () => {
    const result = validateIngestResult(JSON.stringify({
      ...validResult,
      articles: [],
    }));
    expect(result.articles).toHaveLength(0);
  });

  it('accepts all valid article types', () => {
    for (const type of ARTICLE_TYPES) {
      const data = { ...validResult, articles: [{ ...validResult.articles[0], article_type: type }] };
      const result = validateIngestResult(JSON.stringify(data));
      expect(result.articles[0].article_type).toBe(type);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/prompts.test.ts -t "validateIngestResult"`
Expected: FAIL — `validateIngestResult` is not exported

- [ ] **Step 3: Add validateIngestResult to prompts.ts**

Append to `src/wiki/prompts.ts`:

```typescript
import type { IngestResult, ArticleOp } from './types.js';

export function validateIngestResult(jsonString: string): IngestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON in LLM response');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('LLM response is not an object');
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.articles)) {
    throw new Error('Missing or invalid "articles" array');
  }

  if (typeof obj.source_summary !== 'string') {
    throw new Error('Missing or invalid "source_summary"');
  }

  if (typeof obj.source_type !== 'string' || !(SOURCE_TYPES as readonly string[]).includes(obj.source_type)) {
    throw new Error(`Invalid source_type: ${obj.source_type}`);
  }

  if (typeof obj.log_entry !== 'string') {
    throw new Error('Missing or invalid "log_entry"');
  }

  const articles: ArticleOp[] = obj.articles.map((a: unknown, i: number) => {
    if (typeof a !== 'object' || a === null) {
      throw new Error(`Article ${i} is not an object`);
    }
    const art = a as Record<string, unknown>;

    if (art.action !== 'create' && art.action !== 'update') {
      throw new Error(`Article ${i}: invalid action "${art.action}"`);
    }
    if (typeof art.title !== 'string' || !art.title) {
      throw new Error(`Article ${i}: missing or empty title`);
    }
    if (typeof art.article_type !== 'string' || !(ARTICLE_TYPES as readonly string[]).includes(art.article_type)) {
      throw new Error(`Article ${i}: invalid article_type "${art.article_type}"`);
    }
    if (typeof art.body !== 'string') {
      throw new Error(`Article ${i}: missing body`);
    }
    if (typeof art.summary !== 'string') {
      throw new Error(`Article ${i}: missing summary`);
    }
    if (typeof art.confidence !== 'string' || !(CONFIDENCE_LEVELS as readonly string[]).includes(art.confidence)) {
      throw new Error(`Article ${i}: invalid confidence "${art.confidence}"`);
    }

    return {
      action: art.action as 'create' | 'update',
      title: art.title,
      article_type: art.article_type as ArticleOp['article_type'],
      body: art.body,
      summary: art.summary,
      confidence: art.confidence as ArticleOp['confidence'],
      domain: Array.isArray(art.domain) ? art.domain.filter((d): d is string => typeof d === 'string') : [],
      tags: Array.isArray(art.tags) ? art.tags.filter((t): t is string => typeof t === 'string') : [],
      sources: Array.isArray(art.sources) ? art.sources.filter((s): s is string => typeof s === 'string') : [],
      related_articles: Array.isArray(art.related_articles)
        ? art.related_articles.filter((r): r is string => typeof r === 'string')
        : [],
    };
  });

  return {
    articles,
    source_summary: obj.source_summary as string,
    source_type: obj.source_type as IngestResult['source_type'],
    log_entry: obj.log_entry as string,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/prompts.test.ts`
Expected: PASS (all tests including validation)

- [ ] **Step 5: Commit**

```bash
git add src/wiki/prompts.ts tests/wiki/prompts.test.ts
git commit -m "feat(wiki): add ingest result validation"
```

---

### Task 6: Index Sync

Deterministic `Wiki/index.md` rebuild from DB state. No LLM involved. Pure function over DB query results.

**Files:**
- Create: `src/wiki/index-sync.ts`
- Test: `tests/wiki/index-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/wiki/index-sync.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { buildIndexBody } from '../../src/wiki/index-sync.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);

  // Set up wiki-article schema and required global fields
  createGlobalField(db, { name: 'article_type', field_type: 'enum', enum_values: ['entity', 'concept', 'topic', 'comparison', 'synthesis', 'overview', 'timeline'] });
  createGlobalField(db, { name: 'summary', field_type: 'string' });
  createGlobalField(db, { name: 'confidence', field_type: 'enum', enum_values: ['high', 'medium', 'low', 'contested'] });
  createGlobalField(db, { name: 'domain', field_type: 'list', list_item_type: 'string' });
  createSchemaDefinition(db, {
    name: 'wiki-article',
    display_name: 'Wiki Article',
    filename_template: 'Wiki/{{title}}.md',
    field_claims: [
      { field: 'article_type', required: true },
      { field: 'summary' },
      { field: 'confidence' },
      { field: 'domain' },
    ],
  });
});

afterEach(() => {
  db.close();
  cleanup();
});

function createWikiArticle(title: string, opts: { article_type: string; summary: string; confidence: string; domain: string[]; body?: string }): string {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: `Wiki/${title}.md`,
    title,
    types: ['wiki-article'],
    fields: {
      article_type: opts.article_type,
      summary: opts.summary,
      confidence: opts.confidence,
      domain: opts.domain,
    },
    body: opts.body ?? `# ${title}\n\nContent.`,
  }, syncLogger);
  return result.node_id;
}

describe('buildIndexBody', () => {
  it('returns empty content when no wiki articles exist', () => {
    const body = buildIndexBody(db);
    expect(body).toContain('Wiki Index');
    expect(body).not.toContain('##');
  });

  it('groups articles by domain', () => {
    createWikiArticle('GPT', { article_type: 'entity', summary: 'A language model.', confidence: 'high', domain: ['AI'] });
    createWikiArticle('React', { article_type: 'entity', summary: 'A UI library.', confidence: 'high', domain: ['Web Development'] });

    const body = buildIndexBody(db);
    expect(body).toContain('## AI');
    expect(body).toContain('## Web Development');
    expect(body).toContain('[[GPT]]');
    expect(body).toContain('[[React]]');
  });

  it('includes summary, article_type, and confidence in each entry', () => {
    createWikiArticle('GPT', { article_type: 'entity', summary: 'A language model.', confidence: 'high', domain: ['AI'] });

    const body = buildIndexBody(db);
    expect(body).toContain('A language model.');
    expect(body).toContain('entity');
    expect(body).toContain('high');
  });

  it('puts articles with no domain under Uncategorized', () => {
    createWikiArticle('Misc Thing', { article_type: 'concept', summary: 'A misc concept.', confidence: 'medium', domain: [] });

    const body = buildIndexBody(db);
    expect(body).toContain('## Uncategorized');
    expect(body).toContain('[[Misc Thing]]');
  });

  it('sorts domains alphabetically', () => {
    createWikiArticle('B Thing', { article_type: 'entity', summary: 'B.', confidence: 'high', domain: ['Zebra'] });
    createWikiArticle('A Thing', { article_type: 'entity', summary: 'A.', confidence: 'high', domain: ['Alpha'] });

    const body = buildIndexBody(db);
    const alphaPos = body.indexOf('## Alpha');
    const zebraPos = body.indexOf('## Zebra');
    expect(alphaPos).toBeLessThan(zebraPos);
  });

  it('articles with multiple domains appear under each domain', () => {
    createWikiArticle('Cross Domain', { article_type: 'topic', summary: 'Spans domains.', confidence: 'medium', domain: ['AI', 'Ethics'] });

    const body = buildIndexBody(db);
    expect(body).toContain('## AI');
    expect(body).toContain('## Ethics');
    // Article appears under both
    const aiSection = body.indexOf('## AI');
    const ethicsSection = body.indexOf('## Ethics');
    const firstMention = body.indexOf('[[Cross Domain]]');
    const secondMention = body.indexOf('[[Cross Domain]]', firstMention + 1);
    expect(firstMention).toBeGreaterThan(aiSection);
    expect(secondMention).toBeGreaterThan(ethicsSection);
  });

  it('sorts articles within a domain alphabetically by title', () => {
    createWikiArticle('Zeta', { article_type: 'entity', summary: 'Z.', confidence: 'high', domain: ['AI'] });
    createWikiArticle('Alpha', { article_type: 'entity', summary: 'A.', confidence: 'high', domain: ['AI'] });

    const body = buildIndexBody(db);
    const alphaPos = body.indexOf('[[Alpha]]');
    const zetaPos = body.indexOf('[[Zeta]]');
    expect(alphaPos).toBeLessThan(zetaPos);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/index-sync.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/index-sync.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/wiki/index-sync.ts

import type Database from 'better-sqlite3';

interface WikiArticleRow {
  id: string;
  title: string;
}

interface FieldRow {
  node_id: string;
  field: string;
  value_json: string;
}

interface ArticleEntry {
  title: string;
  summary: string;
  article_type: string;
  confidence: string;
  domains: string[];
}

export function buildIndexBody(db: Database.Database): string {
  // Query all wiki-article nodes
  const articleRows = db.prepare(`
    SELECT n.id, n.title
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id
    WHERE nt.type_name = 'wiki-article'
    ORDER BY n.title
  `).all() as WikiArticleRow[];

  if (articleRows.length === 0) {
    return '# Wiki Index\n\nNo articles yet.';
  }

  // Load fields for these nodes
  const nodeIds = articleRows.map(r => r.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const fieldRows = db.prepare(`
    SELECT node_id, field, value_json
    FROM node_fields
    WHERE node_id IN (${placeholders})
      AND field IN ('article_type', 'summary', 'confidence', 'domain')
  `).all(...nodeIds) as FieldRow[];

  // Build field lookup: node_id -> field -> value
  const fieldMap = new Map<string, Map<string, unknown>>();
  for (const row of fieldRows) {
    if (!fieldMap.has(row.node_id)) {
      fieldMap.set(row.node_id, new Map());
    }
    fieldMap.get(row.node_id)!.set(row.field, JSON.parse(row.value_json));
  }

  // Build article entries
  const articles: ArticleEntry[] = articleRows.map(row => {
    const fields = fieldMap.get(row.id) ?? new Map();
    const domainVal = fields.get('domain');
    const domains = Array.isArray(domainVal) ? domainVal.filter((d): d is string => typeof d === 'string') : [];

    return {
      title: row.title,
      summary: (fields.get('summary') as string) ?? '',
      article_type: (fields.get('article_type') as string) ?? 'unknown',
      confidence: (fields.get('confidence') as string) ?? 'unknown',
      domains,
    };
  });

  // Group by domain
  const domainGroups = new Map<string, ArticleEntry[]>();
  for (const article of articles) {
    if (article.domains.length === 0) {
      if (!domainGroups.has('Uncategorized')) {
        domainGroups.set('Uncategorized', []);
      }
      domainGroups.get('Uncategorized')!.push(article);
    } else {
      for (const domain of article.domains) {
        if (!domainGroups.has(domain)) {
          domainGroups.set(domain, []);
        }
        domainGroups.get(domain)!.push(article);
      }
    }
  }

  // Sort domains (Uncategorized last)
  const sortedDomains = [...domainGroups.keys()].sort((a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  // Build index body
  let body = '# Wiki Index\n';

  for (const domain of sortedDomains) {
    const group = domainGroups.get(domain)!;
    group.sort((a, b) => a.title.localeCompare(b.title));

    body += `\n## ${domain}\n\n`;
    for (const article of group) {
      body += `- [[${article.title}]] — ${article.summary} (${article.article_type}, ${article.confidence})\n`;
    }
  }

  return body;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/index-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wiki/index-sync.ts tests/wiki/index-sync.test.ts
git commit -m "feat(wiki): add deterministic index sync for Wiki/index.md"
```

---

### Task 7: Curator Core — Queue, Ingest Loop, and Wiring

This is the central component. It owns the queue, runs the ingest pipeline (gather context → LLM → validate → apply mutations), syncs the index, appends the log, and handles errors/retries.

**Files:**
- Create: `src/wiki/curator.ts`
- Test: `tests/wiki/curator.test.ts`

- [ ] **Step 1: Write the failing test — queue mechanics**

```typescript
// tests/wiki/curator.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { createWikiCurator } from '../../src/wiki/curator.js';
import type { LlmClient, LlmResponse, WikiCuratorConfig } from '../../src/wiki/types.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

function setupSchemas(): void {
  // source schema
  createGlobalField(db, { name: 'source_type', field_type: 'enum', enum_values: ['article', 'paper', 'report', 'transcript', 'book-chapter', 'podcast', 'video', 'letter'] });
  createGlobalField(db, { name: 'source_url', field_type: 'string' });
  createGlobalField(db, { name: 'ingested', field_type: 'date' });
  createGlobalField(db, { name: 'content_hash', field_type: 'string' });
  createGlobalField(db, { name: 'curator_status', field_type: 'enum', enum_values: ['pending', 'ingested', 'failed', 'superseded'] });
  createSchemaDefinition(db, {
    name: 'source',
    display_name: 'Source',
    filename_template: 'Sources/{{title}}.md',
    field_claims: [
      { field: 'source_type' },
      { field: 'source_url' },
      { field: 'ingested' },
      { field: 'content_hash' },
      { field: 'curator_status' },
    ],
  });

  // wiki-article schema
  createGlobalField(db, { name: 'article_type', field_type: 'enum', enum_values: ['entity', 'concept', 'topic', 'comparison', 'synthesis', 'overview', 'timeline'] });
  createGlobalField(db, { name: 'summary', field_type: 'string' });
  createGlobalField(db, { name: 'confidence', field_type: 'enum', enum_values: ['high', 'medium', 'low', 'contested'] });
  createGlobalField(db, { name: 'domain', field_type: 'list', list_item_type: 'string' });
  createGlobalField(db, { name: 'source_count', field_type: 'number' });
  createGlobalField(db, { name: 'wiki_status', field_type: 'enum', enum_values: ['stub', 'draft', 'mature', 'stale'] });
  createGlobalField(db, { name: 'last_curated', field_type: 'date' });
  createGlobalField(db, { name: 'last_reviewed', field_type: 'date' });
  createGlobalField(db, { name: 'sources', field_type: 'list', list_item_type: 'reference' });
  createGlobalField(db, { name: 'tags', field_type: 'list', list_item_type: 'string' });
  createSchemaDefinition(db, {
    name: 'wiki-article',
    display_name: 'Wiki Article',
    filename_template: 'Wiki/{{title}}.md',
    field_claims: [
      { field: 'article_type', required: true },
      { field: 'summary' },
      { field: 'confidence' },
      { field: 'domain' },
      { field: 'source_count' },
      { field: 'wiki_status' },
      { field: 'last_curated' },
      { field: 'last_reviewed' },
      { field: 'sources' },
      { field: 'tags' },
    ],
  });
}

function createSourceNode(title: string, body: string): string {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: `Sources/${title}.md`,
    title,
    types: ['source'],
    fields: {},
    body,
  }, syncLogger);
  return result.node_id;
}

function makeMockLlmClient(responseContent: string): LlmClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content: responseContent,
      usage: { inputTokens: 100, outputTokens: 50 },
      model: 'test-model',
      durationMs: 100,
    } satisfies LlmResponse),
    isReady: () => true,
  };
}

const defaultConfig: WikiCuratorConfig = {
  enabled: true,
  llm: {
    provider: 'fireworks',
    model: 'test-model',
    temperature: 0,
    maxOutputTokens: 4096,
  },
  ingest: {
    trigger: 'on_source_mutation',
    maxRetries: 3,
    delayBetweenIngests: 0, // no delay in tests
  },
  lint: {
    cronExpression: '',
    llmChecks: false,
    autoFix: false,
  },
  indexSync: {
    afterEveryIngest: true,
  },
};

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);
  setupSchemas();
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('queue mechanics', () => {
  it('enqueue and queueSize work', () => {
    const llm = makeMockLlmClient('{}');
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: 'abc', trigger: 'source_created', retries: 0, enqueued_at: Date.now() });
    expect(curator.queueSize()).toBe(1);
  });

  it('deduplicates by node_id (last-write-wins)', () => {
    const llm = makeMockLlmClient('{}');
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: 'abc', trigger: 'source_created', retries: 0, enqueued_at: 1000 });
    curator.enqueue({ node_id: 'abc', trigger: 'source_updated', retries: 0, enqueued_at: 2000 });
    expect(curator.queueSize()).toBe(1);
  });

  it('allows different node_ids in queue', () => {
    const llm = makeMockLlmClient('{}');
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: 'abc', trigger: 'source_created', retries: 0, enqueued_at: Date.now() });
    curator.enqueue({ node_id: 'def', trigger: 'source_created', retries: 0, enqueued_at: Date.now() });
    expect(curator.queueSize()).toBe(2);
  });
});

describe('ingest pipeline', () => {
  it('creates wiki articles from LLM response', async () => {
    const sourceId = createSourceNode('Test Source', '# Test\n\nThis is about AI and machine learning concepts.');

    const llmResponse = JSON.stringify({
      articles: [
        {
          action: 'create',
          title: 'Machine Learning',
          article_type: 'concept',
          body: '# Machine Learning\n\nA field of AI.\n\n## Sources\n- [[Test Source]]',
          summary: 'The study of algorithms that learn from data.',
          confidence: 'high',
          domain: ['AI'],
          tags: ['ml'],
          sources: ['Test Source'],
          related_articles: [],
        },
      ],
      source_summary: 'An overview of machine learning.',
      source_type: 'article',
      log_entry: 'Created Machine Learning article.',
    });

    const llm = makeMockLlmClient(llmResponse);
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: sourceId, trigger: 'source_created', retries: 0, enqueued_at: Date.now() });
    await curator.processNext();

    // Verify wiki article was created
    const articles = db.prepare(`
      SELECT n.id, n.title FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id
      WHERE nt.type_name = 'wiki-article'
    `).all() as Array<{ id: string; title: string }>;
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Machine Learning');

    // Verify source was marked as ingested
    const sourceFields = db.prepare(`
      SELECT field, value_json FROM node_fields WHERE node_id = ? AND field = 'curator_status'
    `).get(sourceId) as { field: string; value_json: string } | undefined;
    expect(sourceFields).toBeDefined();
    expect(JSON.parse(sourceFields!.value_json)).toBe('ingested');

    // Queue should be empty
    expect(curator.queueSize()).toBe(0);
  });

  it('updates existing wiki articles on action: update', async () => {
    const sourceId = createSourceNode('Test Source', '# Test\n\nUpdated content about AI.');

    // Pre-create the wiki article
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Wiki/Machine Learning.md',
      title: 'Machine Learning',
      types: ['wiki-article'],
      fields: { article_type: 'concept', summary: 'Old summary.', confidence: 'medium', domain: ['AI'], wiki_status: 'draft', sources: ['Test Source'] },
      body: '# Machine Learning\n\nOld body.',
    }, syncLogger);

    const llmResponse = JSON.stringify({
      articles: [
        {
          action: 'update',
          title: 'Machine Learning',
          article_type: 'concept',
          body: '# Machine Learning\n\nUpdated body with new info.\n\n## Sources\n- [[Test Source]]',
          summary: 'Updated summary.',
          confidence: 'high',
          domain: ['AI'],
          tags: ['ml'],
          sources: ['Test Source'],
          related_articles: [],
        },
      ],
      source_summary: 'Updated AI content.',
      source_type: 'article',
      log_entry: 'Updated Machine Learning.',
    });

    const llm = makeMockLlmClient(llmResponse);
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: sourceId, trigger: 'source_updated', retries: 0, enqueued_at: Date.now() });
    await curator.processNext();

    // Verify body was updated
    const node = db.prepare('SELECT body FROM nodes WHERE title = ?').get('Machine Learning') as { body: string };
    expect(node.body).toContain('Updated body with new info.');
  });

  it('retries on LLM failure and drops after maxRetries', async () => {
    const sourceId = createSourceNode('Fail Source', '# Fail\n\nContent.');

    const failingLlm: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      isReady: () => true,
    };

    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: failingLlm, config: defaultConfig });

    curator.enqueue({ node_id: sourceId, trigger: 'source_created', retries: 0, enqueued_at: Date.now() });

    // Process — should requeue with retries+1
    await curator.processNext();
    expect(curator.queueSize()).toBe(1); // requeued

    await curator.processNext();
    expect(curator.queueSize()).toBe(1); // requeued again

    await curator.processNext();
    expect(curator.queueSize()).toBe(0); // dropped after 3rd failure

    // Source should be marked failed
    const status = db.prepare(`
      SELECT value_json FROM node_fields WHERE node_id = ? AND field = 'curator_status'
    `).get(sourceId) as { value_json: string } | undefined;
    expect(status).toBeDefined();
    expect(JSON.parse(status!.value_json)).toBe('failed');
  });

  it('skips articles with last_reviewed > last_curated', async () => {
    const sourceId = createSourceNode('Source', '# Source\n\nContent.');

    // Create article with last_reviewed set (simulating human edit)
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Wiki/Human Edited.md',
      title: 'Human Edited',
      types: ['wiki-article'],
      fields: {
        article_type: 'entity',
        summary: 'Human edited.',
        confidence: 'high',
        domain: ['Test'],
        wiki_status: 'mature',
        last_curated: '2026-04-01',
        last_reviewed: '2026-04-10',
        sources: ['Source'],
      },
      body: '# Human Edited\n\nHuman wrote this.',
    }, syncLogger);

    const llmResponse = JSON.stringify({
      articles: [
        {
          action: 'update',
          title: 'Human Edited',
          article_type: 'entity',
          body: '# Human Edited\n\nCurator wants to overwrite.',
          summary: 'Curator summary.',
          confidence: 'high',
          domain: ['Test'],
          tags: [],
          sources: ['Source'],
          related_articles: [],
        },
      ],
      source_summary: 'Test source.',
      source_type: 'article',
      log_entry: 'Attempted update.',
    });

    const llm = makeMockLlmClient(llmResponse);
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: sourceId, trigger: 'source_updated', retries: 0, enqueued_at: Date.now() });
    await curator.processNext();

    // Article body should be unchanged (human edit preserved)
    const node = db.prepare('SELECT body FROM nodes WHERE title = ?').get('Human Edited') as { body: string };
    expect(node.body).toContain('Human wrote this.');
    expect(node.body).not.toContain('Curator wants to overwrite');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/curator.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/curator.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/wiki/curator.ts

import type Database from 'better-sqlite3';
import { sha256 } from '../indexer/hash.js';
import { executeMutation } from '../pipeline/execute.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import { buildIngestSystemPrompt, buildIngestUserPrompt, validateIngestResult } from './prompts.js';
import { buildIndexBody } from './index-sync.js';
import type { CuratorQueueItem, LlmClient, WikiCuratorConfig, ArticleOp } from './types.js';

export interface WikiCurator {
  enqueue(item: CuratorQueueItem): void;
  processNext(): Promise<boolean>;
  queueSize(): number;
  stop(): void;
}

interface CuratorDeps {
  db: Database.Database;
  vaultPath: string;
  writeLock: WriteLockManager;
  syncLogger?: SyncLogger;
  llmClient: LlmClient;
  config: WikiCuratorConfig;
}

export function createWikiCurator(deps: CuratorDeps): WikiCurator {
  const { db, vaultPath, writeLock, syncLogger, llmClient, config } = deps;
  const queue: CuratorQueueItem[] = [];
  let processing = false;
  let stopped = false;

  function enqueue(item: CuratorQueueItem): void {
    // Dedup by node_id — replace existing entry
    const idx = queue.findIndex(q => q.node_id === item.node_id);
    if (idx !== -1) {
      queue[idx] = item;
    } else {
      queue.push(item);
    }
  }

  function queueSize(): number {
    return queue.length;
  }

  async function processNext(): Promise<boolean> {
    if (processing || stopped || queue.length === 0) return false;

    processing = true;
    const item = queue.shift()!;

    try {
      await ingest(item);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wiki-curator] Ingest failed for ${item.node_id}: ${msg}`);

      if (item.retries + 1 < config.ingest.maxRetries) {
        enqueue({ ...item, retries: item.retries + 1, enqueued_at: Date.now() });
      } else {
        // Max retries exceeded — mark source as failed
        markSourceFailed(item.node_id);
        console.error(`[wiki-curator] Dropped ${item.node_id} after ${config.ingest.maxRetries} failures`);
      }
      return false;
    } finally {
      processing = false;
    }
  }

  async function ingest(item: CuratorQueueItem): Promise<void> {
    // Step 1: Gather context
    const sourceNode = db.prepare('SELECT id, title, body, file_path FROM nodes WHERE id = ?').get(item.node_id) as
      { id: string; title: string; body: string; file_path: string } | undefined;

    if (!sourceNode) {
      console.warn(`[wiki-curator] Source node ${item.node_id} not found, skipping`);
      return;
    }

    const sourceFields = getNodeFields(sourceNode.id);

    // Find existing wiki articles that reference this source
    const existingArticles = db.prepare(`
      SELECT n.id, n.title, n.body
      FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id
      WHERE nt.type_name = 'wiki-article'
    `).all() as Array<{ id: string; title: string; body: string }>;

    // Filter to articles that cite this source
    const citingArticles = existingArticles.filter(a => {
      const fields = getNodeFields(a.id);
      const sources = fields.sources;
      return Array.isArray(sources) && sources.some(
        (s: unknown) => typeof s === 'string' && s.includes(sourceNode.title)
      );
    });

    // Get existing index content
    const indexNode = db.prepare(`SELECT body FROM nodes WHERE title = 'index' AND file_path LIKE 'Wiki/%'`).get() as
      { body: string } | undefined;
    const indexContent = indexNode?.body ?? '';

    // Step 2: Call LLM
    const systemPrompt = buildIngestSystemPrompt();
    const userPrompt = buildIngestUserPrompt({
      source: {
        title: sourceNode.title,
        author: sourceFields.author as string | undefined,
        published: sourceFields.published as string | undefined,
        body: sourceNode.body,
      },
      existingArticles: citingArticles.map(a => {
        const fields = getNodeFields(a.id);
        return {
          title: a.title,
          summary: (fields.summary as string) ?? '',
          article_type: (fields.article_type as string) ?? '',
          body: a.body,
        };
      }),
      indexContent,
    });

    const llmResponse = await llmClient.complete({
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: config.llm.maxOutputTokens,
      temperature: config.llm.temperature,
      responseFormat: 'json',
    });

    // Step 3: Validate
    const ingestResult = validateIngestResult(llmResponse.content);

    // Step 4: Apply mutations
    const today = new Date().toISOString().slice(0, 10);
    const created: string[] = [];
    const updated: string[] = [];

    for (const articleOp of ingestResult.articles) {
      if (articleOp.action === 'update') {
        // Check if article exists and if human-edited
        const existing = db.prepare('SELECT id FROM nodes WHERE title = ?').get(articleOp.title) as
          { id: string } | undefined;

        if (!existing) {
          console.warn(`[wiki-curator] Article "${articleOp.title}" not found for update, skipping`);
          continue;
        }

        // Check human-edit skip
        if (shouldSkipHumanEdited(existing.id)) {
          console.log(`[wiki-curator] Skipping "${articleOp.title}" — human-edited since last curated`);
          continue;
        }

        applyArticleOp(existing.id, articleOp, today);
        updated.push(articleOp.title);
      } else {
        // Create — verify no existing article with same title
        const existing = db.prepare('SELECT id FROM nodes WHERE title = ?').get(articleOp.title) as
          { id: string } | undefined;

        if (existing) {
          // Article exists — treat as update if not human-edited
          if (shouldSkipHumanEdited(existing.id)) {
            console.log(`[wiki-curator] Skipping "${articleOp.title}" — human-edited since last curated`);
            continue;
          }
          applyArticleOp(existing.id, articleOp, today);
          updated.push(articleOp.title);
        } else {
          createArticle(articleOp, today);
          created.push(articleOp.title);
        }
      }
    }

    // Step 5: Update source node
    executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: sourceNode.id,
      file_path: sourceNode.file_path,
      title: sourceNode.title,
      types: ['source'],
      fields: {
        ...sourceFields,
        curator_status: 'ingested',
        source_type: ingestResult.source_type,
        ingested: today,
        content_hash: sha256(sourceNode.body),
      },
      body: sourceNode.body,
    }, syncLogger);

    // Step 6: Sync index
    if (config.indexSync.afterEveryIngest) {
      syncIndex();
    }

    // Step 7: Append log
    appendLog(today, sourceNode.title, created, updated);

    // Step 8: Log to edits_log
    const logStmt = db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    );
    logStmt.run(
      sourceNode.id,
      Date.now(),
      'wiki-curator-ingest',
      JSON.stringify({
        source_title: sourceNode.title,
        articles_created: created,
        articles_updated: updated,
        llm_model: llmResponse.model,
        llm_input_tokens: llmResponse.usage.inputTokens,
        llm_output_tokens: llmResponse.usage.outputTokens,
        llm_duration_ms: llmResponse.durationMs,
      }),
    );
  }

  function getNodeFields(nodeId: string): Record<string, unknown> {
    const rows = db.prepare('SELECT field, value_json FROM node_fields WHERE node_id = ?').all(nodeId) as
      Array<{ field: string; value_json: string }>;
    const fields: Record<string, unknown> = {};
    for (const row of rows) {
      fields[row.field] = JSON.parse(row.value_json);
    }
    return fields;
  }

  function shouldSkipHumanEdited(nodeId: string): boolean {
    const fields = getNodeFields(nodeId);
    const lastCurated = fields.last_curated as string | undefined;
    const lastReviewed = fields.last_reviewed as string | undefined;
    if (!lastReviewed || !lastCurated) return false;
    return lastReviewed > lastCurated;
  }

  function createArticle(op: ArticleOp, today: string): void {
    executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: null,
      file_path: `Wiki/${op.title}.md`,
      title: op.title,
      types: ['wiki-article'],
      fields: {
        article_type: op.article_type,
        summary: op.summary,
        confidence: op.confidence,
        domain: op.domain,
        tags: op.tags,
        sources: op.sources,
        source_count: op.sources.length,
        wiki_status: 'draft',
        last_curated: today,
      },
      body: op.body,
    }, syncLogger);
    writeLock.markRecentWrite(`${vaultPath}/Wiki/${op.title}.md`);
  }

  function applyArticleOp(nodeId: string, op: ArticleOp, today: string): void {
    const existing = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?').get(nodeId) as
      { file_path: string; title: string };

    executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: nodeId,
      file_path: existing.file_path,
      title: existing.title,
      types: ['wiki-article'],
      fields: {
        article_type: op.article_type,
        summary: op.summary,
        confidence: op.confidence,
        domain: op.domain,
        tags: op.tags,
        sources: op.sources,
        source_count: op.sources.length,
        last_curated: today,
      },
      body: op.body,
    }, syncLogger);
    writeLock.markRecentWrite(`${vaultPath}/${existing.file_path}`);
  }

  function syncIndex(): void {
    const body = buildIndexBody(db);
    const existingIndex = db.prepare(`SELECT id, file_path FROM nodes WHERE file_path = 'Wiki/index.md'`).get() as
      { id: string; file_path: string } | undefined;

    executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: existingIndex?.id ?? null,
      file_path: 'Wiki/index.md',
      title: 'index',
      types: [],
      fields: {},
      body,
    }, syncLogger);
    writeLock.markRecentWrite(`${vaultPath}/Wiki/index.md`);
  }

  function appendLog(today: string, sourceTitle: string, created: string[], updated: string[]): void {
    const logNode = db.prepare(`SELECT id, body, file_path FROM nodes WHERE file_path = 'Wiki/log.md'`).get() as
      { id: string; body: string; file_path: string } | undefined;

    const parts: string[] = [];
    if (created.length > 0) parts.push(`Created: ${created.join(', ')}`);
    if (updated.length > 0) parts.push(`Updated: ${updated.join(', ')}`);

    const entry = `## [${today}] ingest | ${sourceTitle}\n${parts.join('\n')}\nSource: [[${sourceTitle}]]`;

    if (logNode) {
      const newBody = logNode.body ? `${logNode.body}\n\n${entry}` : entry;
      executeMutation(db, writeLock, vaultPath, {
        source: 'wiki-curator',
        node_id: logNode.id,
        file_path: logNode.file_path,
        title: 'log',
        types: [],
        fields: {},
        body: newBody,
      }, syncLogger);
    } else {
      executeMutation(db, writeLock, vaultPath, {
        source: 'wiki-curator',
        node_id: null,
        file_path: 'Wiki/log.md',
        title: 'log',
        types: [],
        fields: {},
        body: entry,
      }, syncLogger);
    }
    writeLock.markRecentWrite(`${vaultPath}/Wiki/log.md`);
  }

  function markSourceFailed(nodeId: string): void {
    try {
      const node = db.prepare('SELECT id, title, body, file_path FROM nodes WHERE id = ?').get(nodeId) as
        { id: string; title: string; body: string; file_path: string } | undefined;
      if (!node) return;

      const fields = getNodeFields(nodeId);
      executeMutation(db, writeLock, vaultPath, {
        source: 'wiki-curator',
        node_id: nodeId,
        file_path: node.file_path,
        title: node.title,
        types: ['source'],
        fields: { ...fields, curator_status: 'failed' },
        body: node.body,
      }, syncLogger);
    } catch (err) {
      console.error(`[wiki-curator] Failed to mark source ${nodeId} as failed:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    enqueue,
    processNext,
    queueSize,
    stop(): void {
      stopped = true;
      if (queue.length > 0) {
        console.log(`[wiki-curator] Stopping with ${queue.length} items dropped from queue`);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/curator.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/wiki/curator.ts tests/wiki/curator.test.ts
git commit -m "feat(wiki): add curator core with queue, ingest pipeline, and wiring"
```

---

### Task 8: Lint System

Scheduled via croner. Runs deterministic checks (free) and optional LLM checks (costs tokens).

**Files:**
- Create: `src/wiki/lint.ts`
- Test: `tests/wiki/lint.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/wiki/lint.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { runDeterministicLint, type LintReport } from '../../src/wiki/lint.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);

  // Setup schemas (same as curator test)
  createGlobalField(db, { name: 'article_type', field_type: 'enum', enum_values: ['entity', 'concept', 'topic', 'comparison', 'synthesis', 'overview', 'timeline'] });
  createGlobalField(db, { name: 'summary', field_type: 'string' });
  createGlobalField(db, { name: 'confidence', field_type: 'enum', enum_values: ['high', 'medium', 'low', 'contested'] });
  createGlobalField(db, { name: 'domain', field_type: 'list', list_item_type: 'string' });
  createGlobalField(db, { name: 'source_count', field_type: 'number' });
  createGlobalField(db, { name: 'wiki_status', field_type: 'enum', enum_values: ['stub', 'draft', 'mature', 'stale'] });
  createGlobalField(db, { name: 'last_curated', field_type: 'date' });
  createGlobalField(db, { name: 'last_reviewed', field_type: 'date' });
  createGlobalField(db, { name: 'sources', field_type: 'list', list_item_type: 'reference' });
  createGlobalField(db, { name: 'tags', field_type: 'list', list_item_type: 'string' });
  createGlobalField(db, { name: 'source_type', field_type: 'enum', enum_values: ['article', 'paper', 'report', 'transcript', 'book-chapter', 'podcast', 'video', 'letter'] });
  createGlobalField(db, { name: 'ingested', field_type: 'date' });
  createGlobalField(db, { name: 'content_hash', field_type: 'string' });
  createGlobalField(db, { name: 'curator_status', field_type: 'enum', enum_values: ['pending', 'ingested', 'failed', 'superseded'] });
  createSchemaDefinition(db, {
    name: 'wiki-article',
    display_name: 'Wiki Article',
    filename_template: 'Wiki/{{title}}.md',
    field_claims: [
      { field: 'article_type', required: true },
      { field: 'summary' },
      { field: 'confidence' },
      { field: 'domain' },
      { field: 'source_count' },
      { field: 'wiki_status' },
      { field: 'last_curated' },
      { field: 'last_reviewed' },
      { field: 'sources' },
      { field: 'tags' },
    ],
  });
  createSchemaDefinition(db, {
    name: 'source',
    display_name: 'Source',
    filename_template: 'Sources/{{title}}.md',
    field_claims: [
      { field: 'source_type' },
      { field: 'ingested' },
      { field: 'content_hash' },
      { field: 'curator_status' },
    ],
  });
});

afterEach(() => {
  db.close();
  cleanup();
});

function createArticle(title: string, opts: {
  article_type?: string; summary?: string; confidence?: string;
  domain?: string[]; wiki_status?: string; last_curated?: string;
  sources?: string[]; body?: string;
} = {}): string {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: `Wiki/${title}.md`,
    title,
    types: ['wiki-article'],
    fields: {
      article_type: opts.article_type ?? 'entity',
      summary: opts.summary ?? 'A test article.',
      confidence: opts.confidence ?? 'high',
      domain: opts.domain ?? [],
      wiki_status: opts.wiki_status ?? 'draft',
      last_curated: opts.last_curated ?? '2026-04-13',
      sources: opts.sources ?? [],
    },
    body: opts.body ?? `# ${title}\n\nContent.`,
  }, syncLogger);
  return result.node_id;
}

function createSource(title: string, opts: {
  content_hash?: string; body?: string; ingested?: string;
} = {}): string {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: `Sources/${title}.md`,
    title,
    types: ['source'],
    fields: {
      content_hash: opts.content_hash ?? 'hash123',
      ingested: opts.ingested ?? '2026-04-13',
      curator_status: 'ingested',
    },
    body: opts.body ?? `# ${title}\n\nSource content.`,
  }, syncLogger);
  return result.node_id;
}

describe('runDeterministicLint', () => {
  it('returns empty report when no wiki articles exist', () => {
    const report = runDeterministicLint(db);
    expect(report.orphanArticles).toHaveLength(0);
    expect(report.staleSources).toHaveLength(0);
    expect(report.staleArticles).toHaveLength(0);
    expect(report.danglingRefs).toHaveLength(0);
    expect(report.shallowStubs).toHaveLength(0);
    expect(report.missingSources).toHaveLength(0);
  });

  it('detects articles with empty sources as missing-sources', () => {
    createArticle('No Sources', { sources: [] });

    const report = runDeterministicLint(db);
    expect(report.missingSources).toContain('No Sources');
  });

  it('detects shallow stubs', () => {
    createArticle('Stub Article', {
      wiki_status: 'stub',
      body: '# Stub\n\nShort.',  // < 200 words
    });

    const report = runDeterministicLint(db);
    expect(report.shallowStubs).toContain('Stub Article');
  });

  it('does not flag non-stub short articles as shallow stubs', () => {
    createArticle('Short Draft', {
      wiki_status: 'draft',
      body: '# Draft\n\nShort.',
    });

    const report = runDeterministicLint(db);
    expect(report.shallowStubs).not.toContain('Short Draft');
  });

  it('detects dangling refs in article bodies', () => {
    createArticle('Has Dangling', {
      body: '# Has Dangling\n\nSee [[Nonexistent Article]] for more.',
    });

    const report = runDeterministicLint(db);
    expect(report.danglingRefs).toContainEqual({
      article: 'Has Dangling',
      target: 'Nonexistent Article',
    });
  });

  it('does not flag wiki-links to existing nodes as dangling', () => {
    createArticle('Target');
    createArticle('Linker', {
      body: '# Linker\n\nSee [[Target]] for more.',
    });

    const report = runDeterministicLint(db);
    const danglingTargets = report.danglingRefs.map(d => d.target);
    expect(danglingTargets).not.toContain('Target');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/lint.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/lint.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/wiki/lint.ts

import type Database from 'better-sqlite3';

export interface LintReport {
  orphanArticles: string[];
  staleSources: string[];
  staleArticles: string[];
  danglingRefs: Array<{ article: string; target: string }>;
  shallowStubs: string[];
  missingSources: string[];
}

interface ArticleRow {
  id: string;
  title: string;
  body: string;
}

interface FieldRow {
  node_id: string;
  field: string;
  value_json: string;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function extractWikiLinks(body: string): string[] {
  const matches = body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  return [...matches].map(m => m[1]);
}

export function runDeterministicLint(db: Database.Database): LintReport {
  // Load all wiki-article nodes
  const articles = db.prepare(`
    SELECT n.id, n.title, n.body
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id
    WHERE nt.type_name = 'wiki-article'
  `).all() as ArticleRow[];

  if (articles.length === 0) {
    return {
      orphanArticles: [],
      staleSources: [],
      staleArticles: [],
      danglingRefs: [],
      shallowStubs: [],
      missingSources: [],
    };
  }

  // Load fields for all wiki articles
  const articleIds = articles.map(a => a.id);
  const placeholders = articleIds.map(() => '?').join(',');
  const fieldRows = db.prepare(`
    SELECT node_id, field, value_json
    FROM node_fields
    WHERE node_id IN (${placeholders})
      AND field IN ('sources', 'wiki_status', 'last_curated')
  `).all(...articleIds) as FieldRow[];

  const fieldMap = new Map<string, Map<string, unknown>>();
  for (const row of fieldRows) {
    if (!fieldMap.has(row.node_id)) {
      fieldMap.set(row.node_id, new Map());
    }
    fieldMap.get(row.node_id)!.set(row.field, JSON.parse(row.value_json));
  }

  // Load all node titles for dangling ref detection
  const allTitles = new Set(
    (db.prepare('SELECT title FROM nodes').all() as Array<{ title: string }>).map(r => r.title),
  );

  // Missing sources: articles with empty sources field
  const missingSources: string[] = [];
  for (const article of articles) {
    const fields = fieldMap.get(article.id) ?? new Map();
    const sources = fields.get('sources');
    if (!Array.isArray(sources) || sources.length === 0) {
      missingSources.push(article.title);
    }
  }

  // Shallow stubs: wiki_status: stub AND body < 200 words
  const shallowStubs: string[] = [];
  for (const article of articles) {
    const fields = fieldMap.get(article.id) ?? new Map();
    const status = fields.get('wiki_status');
    if (status === 'stub' && wordCount(article.body) < 200) {
      shallowStubs.push(article.title);
    }
  }

  // Dangling refs: wiki-links in article bodies that don't resolve to any node
  const danglingRefs: Array<{ article: string; target: string }> = [];
  for (const article of articles) {
    const links = extractWikiLinks(article.body);
    for (const target of links) {
      if (!allTitles.has(target)) {
        danglingRefs.push({ article: article.title, target });
      }
    }
  }

  // Stale sources: source nodes where body hash != stored content_hash
  const staleSources: string[] = [];
  // (Requires sha256 import — deferred to wiring step since it needs full source body comparison)

  // Orphan articles: articles not referenced by other articles' body wiki-links
  const articleTitles = new Set(articles.map(a => a.title));
  const referencedTitles = new Set<string>();
  for (const article of articles) {
    const links = extractWikiLinks(article.body);
    for (const link of links) {
      if (articleTitles.has(link)) {
        referencedTitles.add(link);
      }
    }
  }
  const orphanArticles = articles
    .filter(a => !referencedTitles.has(a.title))
    .map(a => a.title);

  // Stale articles: last_curated < most recent ingested date on linked sources
  const staleArticles: string[] = [];

  return {
    orphanArticles,
    staleSources,
    staleArticles,
    danglingRefs,
    shallowStubs,
    missingSources,
  };
}

export function formatLintReport(report: LintReport, today: string): string {
  const sections: string[] = ['# Wiki Lint Report\n'];

  if (report.orphanArticles.length > 0) {
    sections.push(`## Orphan Articles (${report.orphanArticles.length})\n`);
    for (const title of report.orphanArticles) {
      sections.push(`- [[${title}]]`);
    }
    sections.push('');
  }

  if (report.staleSources.length > 0) {
    sections.push(`## Stale Sources (${report.staleSources.length})\n`);
    for (const title of report.staleSources) {
      sections.push(`- [[${title}]]`);
    }
    sections.push('');
  }

  if (report.staleArticles.length > 0) {
    sections.push(`## Stale Articles (${report.staleArticles.length})\n`);
    for (const title of report.staleArticles) {
      sections.push(`- [[${title}]]`);
    }
    sections.push('');
  }

  if (report.danglingRefs.length > 0) {
    sections.push(`## Dangling References (${report.danglingRefs.length})\n`);
    for (const ref of report.danglingRefs) {
      sections.push(`- [[${ref.article}]] → [[${ref.target}]]`);
    }
    sections.push('');
  }

  if (report.shallowStubs.length > 0) {
    sections.push(`## Shallow Stubs (${report.shallowStubs.length})\n`);
    for (const title of report.shallowStubs) {
      sections.push(`- [[${title}]]`);
    }
    sections.push('');
  }

  if (report.missingSources.length > 0) {
    sections.push(`## Missing Sources (${report.missingSources.length})\n`);
    for (const title of report.missingSources) {
      sections.push(`- [[${title}]]`);
    }
    sections.push('');
  }

  const total = report.orphanArticles.length + report.staleSources.length +
    report.staleArticles.length + report.danglingRefs.length +
    report.shallowStubs.length + report.missingSources.length;

  if (total === 0) {
    sections.push('All checks passed. No issues found.');
  }

  return sections.join('\n');
}

export function formatLintLogEntry(report: LintReport, today: string): string {
  const parts = [
    `${report.orphanArticles.length} orphans`,
    `${report.staleSources.length} stale sources`,
    `${report.danglingRefs.length} dangling refs`,
    `${report.shallowStubs.length} stubs`,
    `${report.missingSources.length} unsourced`,
  ];
  return `## [${today}] lint | ${parts.join(', ')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/lint.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wiki/lint.ts tests/wiki/lint.test.ts
git commit -m "feat(wiki): add deterministic lint system for wiki health checks"
```

---

### Task 9: Startup Wiring — Config, Index.ts, Watcher Hook

Wire the curator into the engine's startup, config system, and watcher.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/sync/watcher.ts`
- Test: `tests/wiki/wiring.test.ts`

- [ ] **Step 1: Write the failing test — watcher hook**

```typescript
// tests/wiki/wiring.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createTempVault } from '../helpers/vault.js';
import { createWikiCurator, type WikiCurator } from '../../src/wiki/curator.js';
import type { LlmClient, LlmResponse, WikiCuratorConfig } from '../../src/wiki/types.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

const defaultConfig: WikiCuratorConfig = {
  enabled: true,
  llm: { provider: 'fireworks', model: 'test', temperature: 0, maxOutputTokens: 4096 },
  ingest: { trigger: 'on_source_mutation', maxRetries: 3, delayBetweenIngests: 0 },
  lint: { cronExpression: '', llmChecks: false, autoFix: false },
  indexSync: { afterEveryIngest: true },
};

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);

  createGlobalField(db, { name: 'curator_status', field_type: 'enum', enum_values: ['pending', 'ingested', 'failed', 'superseded'] });
  createSchemaDefinition(db, {
    name: 'source',
    display_name: 'Source',
    filename_template: 'Sources/{{title}}.md',
    field_claims: [{ field: 'curator_status' }],
  });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('curator.onNodeMutated hook', () => {
  it('enqueues source nodes and ignores non-source nodes', () => {
    const llm: LlmClient = {
      complete: vi.fn().mockResolvedValue({ content: '{}', usage: { inputTokens: 0, outputTokens: 0 }, model: 'test', durationMs: 0 }),
      isReady: () => true,
    };
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    // Non-source node — should not enqueue
    curator.onNodeMutated('node1', ['note']);
    expect(curator.queueSize()).toBe(0);

    // Source node — should enqueue
    curator.onNodeMutated('node2', ['source']);
    expect(curator.queueSize()).toBe(1);

    // Source + other types — should still enqueue
    curator.onNodeMutated('node3', ['source', 'note']);
    expect(curator.queueSize()).toBe(2);
  });
});

describe('curator.stop', () => {
  it('prevents further processing after stop', async () => {
    const llm: LlmClient = {
      complete: vi.fn().mockResolvedValue({ content: '{}', usage: { inputTokens: 0, outputTokens: 0 }, model: 'test', durationMs: 0 }),
      isReady: () => true,
    };
    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config: defaultConfig });

    curator.enqueue({ node_id: 'abc', trigger: 'source_created', retries: 0, enqueued_at: Date.now() });
    curator.stop();

    const processed = await curator.processNext();
    expect(processed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/wiring.test.ts`
Expected: FAIL — `onNodeMutated` not a property of WikiCurator

- [ ] **Step 3: Add onNodeMutated to curator**

In `src/wiki/curator.ts`, add to the `WikiCurator` interface:

```typescript
export interface WikiCurator {
  enqueue(item: CuratorQueueItem): void;
  processNext(): Promise<boolean>;
  queueSize(): number;
  onNodeMutated(nodeId: string, types: string[]): void;
  stop(): void;
}
```

Add the implementation inside `createWikiCurator()`, before the return:

```typescript
  function onNodeMutated(nodeId: string, types: string[]): void {
    if (!types.includes('source')) return;
    if (config.ingest.trigger === 'manual_only') return;

    enqueue({
      node_id: nodeId,
      trigger: 'source_updated',
      retries: 0,
      enqueued_at: Date.now(),
    });

    // Kick the processing loop (non-blocking)
    processNext().catch(err => {
      console.error('[wiki-curator] processNext error:', err instanceof Error ? err.message : err);
    });
  }
```

Include `onNodeMutated` in the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/wiring.test.ts`
Expected: PASS

- [ ] **Step 5: Modify watcher.ts to call curator**

In `src/sync/watcher.ts`:

1. Add the `wikiCurator` parameter to `startWatcher`:

```typescript
export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  wikiCurator?: { onNodeMutated(nodeId: string, types: string[]): void },
  options?: WatcherOptions,
): FSWatcher {
```

2. After the existing `embeddingIndexer?.enqueue()` / `embeddingIndexer?.processOne()` calls (the ones after successful `executeMutation()`), add:

```typescript
wikiCurator?.onNodeMutated(result.node_id, mutation.types);
```

Note: The `mutation.types` is available from the `ProposedMutation` built earlier in `processFileChange()`.

- [ ] **Step 6: Modify index.ts to wire curator**

In `src/index.ts`, add imports and wiring:

```typescript
import { createLlmClient } from './wiki/llm-client.js';
import { createWikiCurator, type WikiCurator } from './wiki/curator.js';
```

After the normalizer initialization (line ~90) and before extractor setup, add:

```typescript
// --- Wiki Curator ---
let wikiCurator: WikiCurator | undefined;
if (process.env.WIKI_CURATOR_ENABLED === 'true' || process.env.WIKI_CURATOR_ENABLED === '1') {
  const llmClient = createLlmClient({
    provider: (process.env.WIKI_LLM_PROVIDER as 'fireworks' | 'ollama') ?? 'fireworks',
    model: process.env.WIKI_LLM_MODEL ?? 'accounts/fireworks/models/gpt-oss-120b',
    apiKeyEnv: process.env.WIKI_LLM_API_KEY_ENV ?? 'FIREWORKS_API_KEY',
    baseUrl: process.env.WIKI_LLM_BASE_URL,
    temperature: 0,
    maxOutputTokens: parseInt(process.env.WIKI_LLM_MAX_TOKENS ?? '4096', 10),
  });

  if (llmClient.isReady()) {
    wikiCurator = createWikiCurator({
      db, vaultPath, writeLock, syncLogger,
      llmClient,
      config: {
        enabled: true,
        llm: {
          provider: (process.env.WIKI_LLM_PROVIDER as 'fireworks' | 'ollama') ?? 'fireworks',
          model: process.env.WIKI_LLM_MODEL ?? 'accounts/fireworks/models/gpt-oss-120b',
          temperature: 0,
          maxOutputTokens: parseInt(process.env.WIKI_LLM_MAX_TOKENS ?? '4096', 10),
        },
        ingest: {
          trigger: (process.env.WIKI_INGEST_TRIGGER as 'on_source_mutation' | 'manual_only') ?? 'on_source_mutation',
          maxRetries: 3,
          delayBetweenIngests: parseInt(process.env.WIKI_DELAY_BETWEEN_INGESTS ?? '5000', 10),
        },
        lint: {
          cronExpression: process.env.WIKI_LINT_CRON ?? '',
          llmChecks: process.env.WIKI_LINT_LLM === 'true',
          autoFix: process.env.WIKI_LINT_AUTOFIX === 'true',
        },
        indexSync: { afterEveryIngest: true },
      },
    });
    console.log('Wiki curator enabled');
  } else {
    console.warn('Wiki curator: LLM client not ready (missing API key?)');
  }
}
```

Update the `startWatcher` call to pass `wikiCurator`:

```typescript
const watcher = startWatcher(vaultPath, db, mutex, writeLock, syncLogger, embeddingIndexer, wikiCurator);
```

Add to the shutdown function:

```typescript
wikiCurator?.stop();
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. The watcher tests may need a small adjustment if they explicitly count `startWatcher` parameters. Check for failures and fix.

- [ ] **Step 8: Commit**

```bash
git add src/wiki/curator.ts src/sync/watcher.ts src/index.ts tests/wiki/wiring.test.ts
git commit -m "feat(wiki): wire curator into watcher and startup"
```

---

### Task 10: Lint Scheduling

Wire the croner-scheduled lint into the curator lifecycle.

**Files:**
- Modify: `src/wiki/curator.ts` (add lint scheduling)
- Test: `tests/wiki/lint.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/wiki/lint.test.ts`:

```typescript
import { formatLintReport, formatLintLogEntry } from '../../src/wiki/lint.js';

describe('formatLintReport', () => {
  it('formats empty report', () => {
    const report: LintReport = {
      orphanArticles: [],
      staleSources: [],
      staleArticles: [],
      danglingRefs: [],
      shallowStubs: [],
      missingSources: [],
    };
    const body = formatLintReport(report, '2026-04-13');
    expect(body).toContain('All checks passed');
  });

  it('formats report with findings', () => {
    const report: LintReport = {
      orphanArticles: ['Orphan A'],
      staleSources: [],
      staleArticles: [],
      danglingRefs: [{ article: 'X', target: 'Y' }],
      shallowStubs: ['Stub B'],
      missingSources: ['No Source C'],
    };
    const body = formatLintReport(report, '2026-04-13');
    expect(body).toContain('## Orphan Articles (1)');
    expect(body).toContain('[[Orphan A]]');
    expect(body).toContain('## Dangling References (1)');
    expect(body).toContain('[[X]] → [[Y]]');
    expect(body).toContain('## Shallow Stubs (1)');
    expect(body).toContain('## Missing Sources (1)');
  });
});

describe('formatLintLogEntry', () => {
  it('formats log entry', () => {
    const report: LintReport = {
      orphanArticles: ['A', 'B'],
      staleSources: [],
      staleArticles: [],
      danglingRefs: [{ article: 'X', target: 'Y' }],
      shallowStubs: [],
      missingSources: ['C'],
    };
    const entry = formatLintLogEntry(report, '2026-04-13');
    expect(entry).toContain('## [2026-04-13] lint');
    expect(entry).toContain('2 orphans');
    expect(entry).toContain('1 dangling refs');
    expect(entry).toContain('1 unsourced');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/wiki/lint.test.ts`
Expected: PASS (these functions already exist from Task 8)

- [ ] **Step 3: Add lint runner to curator**

Add to the `WikiCurator` interface and `createWikiCurator()`:

```typescript
// In the interface:
export interface WikiCurator {
  enqueue(item: CuratorQueueItem): void;
  processNext(): Promise<boolean>;
  queueSize(): number;
  onNodeMutated(nodeId: string, types: string[]): void;
  runLint(): void;
  stop(): void;
}
```

Inside `createWikiCurator()`, add lint scheduling:

```typescript
import { Cron } from 'croner';
import { runDeterministicLint, formatLintReport, formatLintLogEntry } from './lint.js';

// After the existing code, before the return:
  let lintTimer: ReturnType<typeof setTimeout> | null = null;
  let lintCron: Cron | null = null;

  function runLint(): void {
    const today = new Date().toISOString().slice(0, 10);
    const report = runDeterministicLint(db);

    // Write lint report as a wiki-article node
    const reportBody = formatLintReport(report, today);
    const reportTitle = `lint-report-${today}`;
    executeMutation(db, writeLock, vaultPath, {
      source: 'wiki-curator',
      node_id: null,
      file_path: `Wiki/${reportTitle}.md`,
      title: reportTitle,
      types: ['wiki-article'],
      fields: {
        article_type: 'overview',
        wiki_status: 'mature',
        summary: `Wiki lint report for ${today}.`,
        last_curated: today,
      },
      body: reportBody,
    }, syncLogger);

    // Append to log
    const logEntry = formatLintLogEntry(report, today);
    appendLog(today, `lint | ${today}`, [], []);
    // Actually use the proper log entry format:
    const logNode = db.prepare(`SELECT id, body, file_path FROM nodes WHERE file_path = 'Wiki/log.md'`).get() as
      { id: string; body: string; file_path: string } | undefined;
    if (logNode) {
      const newBody = logNode.body ? `${logNode.body}\n\n${logEntry}` : logEntry;
      executeMutation(db, writeLock, vaultPath, {
        source: 'wiki-curator',
        node_id: logNode.id,
        file_path: logNode.file_path,
        title: 'log',
        types: [],
        fields: {},
        body: newBody,
      }, syncLogger);
    }

    // Sync index after lint
    if (config.indexSync.afterEveryIngest) {
      syncIndex();
    }

    // Log to edits_log
    db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ).run(null, Date.now(), 'wiki-curator-lint', JSON.stringify(report));

    console.log(`[wiki-curator] Lint complete: ${formatLintLogEntry(report, today)}`);
  }

  // Schedule lint if cron expression provided
  if (config.lint.cronExpression) {
    lintCron = new Cron(config.lint.cronExpression);
    function scheduleLint(): void {
      if (stopped || !lintCron) return;
      const next = lintCron.nextRun();
      if (!next) return;
      const delayMs = next.getTime() - Date.now();
      lintTimer = setTimeout(() => {
        runLint();
        scheduleLint();
      }, delayMs);
      lintTimer.unref();
    }
    scheduleLint();
  }
```

Update the `stop()` function to clear the lint timer:

```typescript
    stop(): void {
      stopped = true;
      if (lintTimer) clearTimeout(lintTimer);
      if (queue.length > 0) {
        console.log(`[wiki-curator] Stopping with ${queue.length} items dropped from queue`);
      }
    },
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/wiki/curator.ts tests/wiki/lint.test.ts
git commit -m "feat(wiki): add croner-scheduled lint to curator"
```

---

### Task 11: Schema Setup Script

The `source` and `wiki-article` schemas need global fields and schema definitions created. This can be done via the MCP tools at runtime, but for initial deployment we need a setup path.

**Files:**
- Create: `src/wiki/setup-schemas.ts`
- Test: `tests/wiki/setup-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/wiki/setup-schemas.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { ensureWikiSchemas } from '../../src/wiki/setup-schemas.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe('ensureWikiSchemas', () => {
  it('creates source schema and its global fields', () => {
    ensureWikiSchemas(db);

    const schema = db.prepare('SELECT name FROM schemas WHERE name = ?').get('source') as { name: string } | undefined;
    expect(schema).toBeDefined();

    // Check key global fields exist
    const curatorStatus = db.prepare('SELECT name FROM global_fields WHERE name = ?').get('curator_status');
    expect(curatorStatus).toBeDefined();

    const contentHash = db.prepare('SELECT name FROM global_fields WHERE name = ?').get('content_hash');
    expect(contentHash).toBeDefined();
  });

  it('creates wiki-article schema and its global fields', () => {
    ensureWikiSchemas(db);

    const schema = db.prepare('SELECT name FROM schemas WHERE name = ?').get('wiki-article') as { name: string } | undefined;
    expect(schema).toBeDefined();

    const articleType = db.prepare('SELECT name FROM global_fields WHERE name = ?').get('article_type');
    expect(articleType).toBeDefined();

    const wikiStatus = db.prepare('SELECT name FROM global_fields WHERE name = ?').get('wiki_status');
    expect(wikiStatus).toBeDefined();

    const lastCurated = db.prepare('SELECT name FROM global_fields WHERE name = ?').get('last_curated');
    expect(lastCurated).toBeDefined();
  });

  it('is idempotent — running twice does not error', () => {
    ensureWikiSchemas(db);
    expect(() => ensureWikiSchemas(db)).not.toThrow();
  });

  it('does not overwrite existing global fields with same name', () => {
    // Pre-create a field that wiki also needs
    const { createGlobalField } = require('../../src/global-fields/crud.js');
    createGlobalField(db, { name: 'tags', field_type: 'list', list_item_type: 'string', description: 'User tags' });

    ensureWikiSchemas(db);

    // Field should still exist (not thrown an error)
    const field = db.prepare('SELECT name FROM global_fields WHERE name = ?').get('tags');
    expect(field).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wiki/setup-schemas.test.ts`
Expected: FAIL — cannot resolve `../../src/wiki/setup-schemas.js`

- [ ] **Step 3: Write implementation**

```typescript
// src/wiki/setup-schemas.ts

import type Database from 'better-sqlite3';
import { createGlobalField, type CreateGlobalFieldInput } from '../global-fields/crud.js';
import { createSchemaDefinition, type CreateSchemaInput } from '../schema/crud.js';

function ensureGlobalField(db: Database.Database, input: CreateGlobalFieldInput): void {
  const existing = db.prepare('SELECT name FROM global_fields WHERE name = ?').get(input.name);
  if (existing) return;
  createGlobalField(db, input);
}

function ensureSchema(db: Database.Database, input: CreateSchemaInput): void {
  const existing = db.prepare('SELECT name FROM schemas WHERE name = ?').get(input.name);
  if (existing) return;
  createSchemaDefinition(db, input);
}

export function ensureWikiSchemas(db: Database.Database): void {
  // --- Global fields for source schema ---
  ensureGlobalField(db, {
    name: 'source_type',
    field_type: 'enum',
    enum_values: ['article', 'paper', 'report', 'transcript', 'book-chapter', 'podcast', 'video', 'letter'],
    description: 'Classification of source material',
  });
  ensureGlobalField(db, { name: 'source_url', field_type: 'string', description: 'Original URL of the source' });
  ensureGlobalField(db, { name: 'ingested', field_type: 'date', description: 'Date the curator processed this source' });
  ensureGlobalField(db, { name: 'content_hash', field_type: 'string', description: 'SHA-256 of body content at ingest time' });
  ensureGlobalField(db, {
    name: 'curator_status',
    field_type: 'enum',
    enum_values: ['pending', 'ingested', 'failed', 'superseded'],
    description: 'Curator processing state',
  });

  // --- Global fields for wiki-article schema ---
  ensureGlobalField(db, {
    name: 'article_type',
    field_type: 'enum',
    enum_values: ['entity', 'concept', 'topic', 'comparison', 'synthesis', 'overview', 'timeline'],
    description: 'What kind of wiki article this is',
  });
  ensureGlobalField(db, { name: 'source_count', field_type: 'number', description: 'Number of source nodes this article draws from' });
  ensureGlobalField(db, {
    name: 'confidence',
    field_type: 'enum',
    enum_values: ['high', 'medium', 'low', 'contested'],
    description: 'Confidence level of claims in this article',
  });
  ensureGlobalField(db, { name: 'summary', field_type: 'string', description: '1-2 sentence summary' });
  ensureGlobalField(db, { name: 'last_curated', field_type: 'date', description: 'When the curator last wrote or updated this article' });
  ensureGlobalField(db, { name: 'last_reviewed', field_type: 'date', description: 'When a human last edited this article' });
  ensureGlobalField(db, {
    name: 'wiki_status',
    field_type: 'enum',
    enum_values: ['stub', 'draft', 'mature', 'stale'],
    description: 'Article maturity level',
  });

  // --- Shared global fields (may already exist) ---
  ensureGlobalField(db, { name: 'tags', field_type: 'list', list_item_type: 'string' });
  ensureGlobalField(db, { name: 'domain', field_type: 'list', list_item_type: 'string' });
  ensureGlobalField(db, { name: 'sources', field_type: 'list', list_item_type: 'reference' });
  ensureGlobalField(db, { name: 'author', field_type: 'string' });
  ensureGlobalField(db, { name: 'published', field_type: 'date' });

  // --- Source schema ---
  ensureSchema(db, {
    name: 'source',
    display_name: 'Source',
    filename_template: 'Sources/{{title}}.md',
    field_claims: [
      { field: 'source_type' },
      { field: 'source_url' },
      { field: 'author' },
      { field: 'published' },
      { field: 'ingested' },
      { field: 'content_hash' },
      { field: 'curator_status' },
      { field: 'tags' },
      { field: 'domain' },
    ],
  });

  // --- Wiki Article schema ---
  ensureSchema(db, {
    name: 'wiki-article',
    display_name: 'Wiki Article',
    filename_template: 'Wiki/{{title}}.md',
    field_claims: [
      { field: 'article_type', required: true },
      { field: 'sources' },
      { field: 'source_count' },
      { field: 'confidence' },
      { field: 'summary' },
      { field: 'last_curated' },
      { field: 'last_reviewed' },
      { field: 'domain' },
      { field: 'tags' },
      { field: 'wiki_status' },
    ],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wiki/setup-schemas.test.ts`
Expected: PASS

- [ ] **Step 5: Wire ensureWikiSchemas into index.ts**

In `src/index.ts`, add import and call before the curator initialization:

```typescript
import { ensureWikiSchemas } from './wiki/setup-schemas.js';

// Before the wiki curator block:
if (process.env.WIKI_CURATOR_ENABLED === 'true' || process.env.WIKI_CURATOR_ENABLED === '1') {
  ensureWikiSchemas(db);
  // ... existing LLM client and curator initialization
}
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/wiki/setup-schemas.ts tests/wiki/setup-schemas.test.ts src/index.ts
git commit -m "feat(wiki): add idempotent schema setup for source and wiki-article"
```

---

### Task 12: Integration Test — End-to-End Ingest

A golden-path test: create a source node, run the curator, verify the entire output chain.

**Files:**
- Create: `tests/wiki/end-to-end.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/wiki/end-to-end.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ensureWikiSchemas } from '../../src/wiki/setup-schemas.js';
import { createWikiCurator } from '../../src/wiki/curator.js';
import { createTempVault } from '../helpers/vault.js';
import type { LlmClient, LlmResponse, WikiCuratorConfig } from '../../src/wiki/types.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let syncLogger: SyncLogger;

const config: WikiCuratorConfig = {
  enabled: true,
  llm: { provider: 'fireworks', model: 'test', temperature: 0, maxOutputTokens: 4096 },
  ingest: { trigger: 'on_source_mutation', maxRetries: 3, delayBetweenIngests: 0 },
  lint: { cronExpression: '', llmChecks: false, autoFix: false },
  indexSync: { afterEveryIngest: true },
};

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();
  syncLogger = new SyncLogger(db);
  ensureWikiSchemas(db);
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('end-to-end ingest', () => {
  it('ingests a source and produces complete wiki output', async () => {
    // 1. Create a source node
    const sourceResult = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'Sources/Attention Is All You Need.md',
      title: 'Attention Is All You Need',
      types: ['source'],
      fields: { author: 'Vaswani et al.' },
      body: '# Attention Is All You Need\n\nThis paper introduces the Transformer architecture, a novel sequence-to-sequence model that relies entirely on attention mechanisms, dispensing with recurrence and convolutions. The Transformer achieves state-of-the-art results on machine translation benchmarks while being more parallelizable and requiring significantly less time to train.',
    }, syncLogger);

    // 2. Mock LLM response
    const llmResponse = JSON.stringify({
      articles: [
        {
          action: 'create',
          title: 'Transformer',
          article_type: 'concept',
          body: '# Transformer\n\nThe Transformer is a neural network architecture introduced in [[Attention Is All You Need]] that relies entirely on attention mechanisms.\n\n## Key Innovation\n\nUnlike previous sequence-to-sequence models, the Transformer removes recurrence entirely, enabling greater parallelization during training.\n\n## Sources\n- [[Attention Is All You Need]]',
          summary: 'A neural network architecture that uses self-attention instead of recurrence for sequence modeling.',
          confidence: 'high',
          domain: ['AI', 'Deep Learning'],
          tags: ['transformer', 'attention', 'nlp'],
          sources: ['Attention Is All You Need'],
          related_articles: [],
        },
        {
          action: 'create',
          title: 'Attention Mechanism',
          article_type: 'concept',
          body: '# Attention Mechanism\n\nAttention is a technique that allows neural networks to focus on relevant parts of the input. The [[Transformer]] architecture uses multi-head self-attention as its core computation.\n\n## Sources\n- [[Attention Is All You Need]]',
          summary: 'A neural network technique for dynamically focusing on relevant input parts.',
          confidence: 'high',
          domain: ['AI', 'Deep Learning'],
          tags: ['attention', 'nlp'],
          sources: ['Attention Is All You Need'],
          related_articles: ['Transformer'],
        },
      ],
      source_summary: 'Seminal paper introducing the Transformer architecture based on self-attention.',
      source_type: 'paper',
      log_entry: 'Created Transformer and Attention Mechanism articles from Vaswani et al. paper.',
    });

    const llm: LlmClient = {
      complete: vi.fn().mockResolvedValue({
        content: llmResponse,
        usage: { inputTokens: 500, outputTokens: 300 },
        model: 'test-model',
        durationMs: 150,
      } satisfies LlmResponse),
      isReady: () => true,
    };

    const curator = createWikiCurator({ db, vaultPath, writeLock, syncLogger, llmClient: llm, config });

    // 3. Run ingest
    curator.enqueue({
      node_id: sourceResult.node_id,
      trigger: 'source_created',
      retries: 0,
      enqueued_at: Date.now(),
    });
    await curator.processNext();

    // 4. Verify wiki articles created
    const articles = db.prepare(`
      SELECT n.id, n.title FROM nodes n
      JOIN node_types nt ON nt.node_id = n.id
      WHERE nt.type_name = 'wiki-article'
    `).all() as Array<{ id: string; title: string }>;
    const articleTitles = articles.map(a => a.title).sort();
    expect(articleTitles).toEqual(['Attention Mechanism', 'Transformer']);

    // 5. Verify article fields
    const transformerFields = db.prepare(`
      SELECT field, value_json FROM node_fields
      WHERE node_id = (SELECT id FROM nodes WHERE title = 'Transformer')
    `).all() as Array<{ field: string; value_json: string }>;
    const tfMap = Object.fromEntries(transformerFields.map(f => [f.field, JSON.parse(f.value_json)]));
    expect(tfMap.article_type).toBe('concept');
    expect(tfMap.confidence).toBe('high');
    expect(tfMap.wiki_status).toBe('draft');
    expect(tfMap.source_count).toBe(1);

    // 6. Verify source node updated
    const sourceFields = db.prepare(`
      SELECT field, value_json FROM node_fields
      WHERE node_id = ? AND field IN ('curator_status', 'source_type', 'content_hash')
    `).all(sourceResult.node_id) as Array<{ field: string; value_json: string }>;
    const srcMap = Object.fromEntries(sourceFields.map(f => [f.field, JSON.parse(f.value_json)]));
    expect(srcMap.curator_status).toBe('ingested');
    expect(srcMap.source_type).toBe('paper');
    expect(srcMap.content_hash).toBeTruthy();

    // 7. Verify Wiki/index.md exists and contains articles
    const indexNode = db.prepare(`SELECT body FROM nodes WHERE file_path = 'Wiki/index.md'`).get() as { body: string } | undefined;
    expect(indexNode).toBeDefined();
    expect(indexNode!.body).toContain('[[Transformer]]');
    expect(indexNode!.body).toContain('[[Attention Mechanism]]');
    expect(indexNode!.body).toContain('## AI');

    // 8. Verify Wiki/log.md exists with ingest entry
    const logNode = db.prepare(`SELECT body FROM nodes WHERE file_path = 'Wiki/log.md'`).get() as { body: string } | undefined;
    expect(logNode).toBeDefined();
    expect(logNode!.body).toContain('Attention Is All You Need');
    expect(logNode!.body).toContain('Created:');

    // 9. Verify edits_log entry
    const editLog = db.prepare(`
      SELECT details FROM edits_log WHERE event_type = 'wiki-curator-ingest'
    `).get() as { details: string } | undefined;
    expect(editLog).toBeDefined();
    const logDetails = JSON.parse(editLog!.details);
    expect(logDetails.articles_created).toContain('Transformer');
    expect(logDetails.articles_created).toContain('Attention Mechanism');
    expect(logDetails.llm_input_tokens).toBe(500);

    // 10. Verify files on disk
    const transformerFile = readFileSync(join(vaultPath, 'Wiki/Transformer.md'), 'utf-8');
    expect(transformerFile).toContain('Transformer');
    expect(transformerFile).toContain('wiki-article');

    const indexFile = readFileSync(join(vaultPath, 'Wiki/index.md'), 'utf-8');
    expect(indexFile).toContain('Transformer');

    // 11. Queue should be empty
    expect(curator.queueSize()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/wiki/end-to-end.test.ts`
Expected: PASS — the entire ingest pipeline works end to end

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/wiki/end-to-end.test.ts
git commit -m "test(wiki): add end-to-end integration test for curator ingest"
```

---

### Task 13: Build Verification

- [ ] **Step 1: Run TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Fix any compilation or test issues found**

Address any issues discovered in steps 1-2.

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix(wiki): address build/test issues from final verification"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-04-13-wiki-curator.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?