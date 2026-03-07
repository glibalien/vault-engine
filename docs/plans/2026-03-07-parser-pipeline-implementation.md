# Parser Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the markdown parser pipeline that takes raw `.md` files and produces structured `ParsedFile` objects with frontmatter, wiki-links, field entries, MDAST, and plain text for FTS.

**Architecture:** unified/remark parses full file into MDAST (with remarkFrontmatter). gray-matter extracts YAML frontmatter. Custom regex extracts wiki-links from both frontmatter values and MDAST text nodes. A top-level `parseFile()` orchestrates everything into a single `ParsedFile` return type.

**Tech Stack:** unified, remark-parse, remark-frontmatter, gray-matter, vitest

---

### Task 1: Shared Types

**Files:**
- Create: `src/parser/types.ts`

**Step 1: Create the types file**

```typescript
import type { Root, Position } from 'mdast';

export type { Root, Position };

export interface WikiLink {
  target: string;
  alias?: string;
  source: 'frontmatter' | 'body';
  field?: string;
  context?: string;
  position?: Position;
}

export type FieldValueType = 'string' | 'number' | 'date' | 'boolean' | 'reference' | 'list';

export interface FieldEntry {
  key: string;
  value: unknown;
  valueType: FieldValueType;
}

export interface ParsedFile {
  filePath: string;
  frontmatter: Record<string, unknown>;
  types: string[];
  fields: FieldEntry[];
  wikiLinks: WikiLink[];
  mdast: Root;
  contentText: string;
  contentMd: string;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```
git add src/parser/types.ts
git commit -m "add parser types: ParsedFile, WikiLink, FieldEntry"
```

---

### Task 2: Wiki-Link Extraction

**Files:**
- Create: `src/parser/wiki-links.ts`
- Create: `tests/parser/wiki-links.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { extractWikiLinksFromString, extractWikiLinksFromMdast } from '../../src/parser/wiki-links.js';

describe('extractWikiLinksFromString', () => {
  it('extracts a simple wiki-link', () => {
    const result = extractWikiLinksFromString('[[Bob Jones]]');
    expect(result).toEqual([{ target: 'Bob Jones', alias: undefined }]);
  });

  it('extracts a wiki-link with alias', () => {
    const result = extractWikiLinksFromString('[[Bob Jones|Bob]]');
    expect(result).toEqual([{ target: 'Bob Jones', alias: 'Bob' }]);
  });

  it('extracts multiple wiki-links from one string', () => {
    const result = extractWikiLinksFromString('Talk to [[Alice]] and [[Bob]]');
    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('Alice');
    expect(result[1].target).toBe('Bob');
  });

  it('returns empty array for no links', () => {
    const result = extractWikiLinksFromString('no links here');
    expect(result).toEqual([]);
  });

  it('handles wiki-links in array values', () => {
    const values = ['[[Alice Smith]]', '[[Bob Jones]]'];
    const results = values.flatMap(v => extractWikiLinksFromString(v));
    expect(results).toHaveLength(2);
    expect(results[0].target).toBe('Alice Smith');
    expect(results[1].target).toBe('Bob Jones');
  });
});

describe('extractWikiLinksFromMdast', () => {
  it('extracts wiki-links from text nodes with context', () => {
    // Minimal MDAST with a text node containing a wiki-link
    const mdast = {
      type: 'root' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [
            {
              type: 'text' as const,
              value: 'Read proposal from [[Acme Corp]]',
              position: {
                start: { line: 5, column: 1, offset: 40 },
                end: { line: 5, column: 33, offset: 72 },
              },
            },
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast as any);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('Acme Corp');
    expect(result[0].source).toBe('body');
    expect(result[0].context).toBe('Read proposal from Acme Corp');
    expect(result[0].position).toBeDefined();
  });

  it('extracts multiple wiki-links from multiple nodes', () => {
    const mdast = {
      type: 'root' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [
            { type: 'text' as const, value: '[[Alice]] and [[Bob]]' },
          ],
        },
        {
          type: 'paragraph' as const,
          children: [
            { type: 'text' as const, value: 'See [[Charlie]]' },
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast as any);
    expect(result).toHaveLength(3);
    expect(result.map(l => l.target)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('skips yaml frontmatter nodes', () => {
    const mdast = {
      type: 'root' as const,
      children: [
        { type: 'yaml' as const, value: 'title: "[[Not A Link]]"' },
        {
          type: 'paragraph' as const,
          children: [
            { type: 'text' as const, value: '[[Real Link]]' },
          ],
        },
      ],
    };
    const result = extractWikiLinksFromMdast(mdast as any);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('Real Link');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser/wiki-links.test.ts`
Expected: FAIL — module not found

**Step 3: Implement wiki-links.ts**

```typescript
import type { Root, Position } from 'mdast';
import type { WikiLink } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface RawWikiLink {
  target: string;
  alias?: string;
}

export function extractWikiLinksFromString(text: string): RawWikiLink[] {
  const links: RawWikiLink[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);
  while ((match = re.exec(text)) !== null) {
    links.push({
      target: match[1].trim(),
      alias: match[2]?.trim(),
    });
  }
  return links;
}

export function extractWikiLinksFromMdast(mdast: Root): WikiLink[] {
  const links: WikiLink[] = [];
  visit(mdast, links);
  return links;
}

function visit(node: any, links: WikiLink[]): void {
  // Skip frontmatter yaml nodes
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    const raw = extractWikiLinksFromString(node.value);
    for (const link of raw) {
      links.push({
        target: link.target,
        alias: link.alias,
        source: 'body',
        context: node.value.replace(WIKI_LINK_RE, (_: string, target: string) => target),
        position: node.position,
      });
    }
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      visit(child, links);
    }
  }
}

export function stripWikiLinks(text: string): string {
  return text.replace(WIKI_LINK_RE, (_: string, target: string) => target);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser/wiki-links.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```
git add src/parser/wiki-links.ts tests/parser/wiki-links.test.ts
git commit -m "add wiki-link extraction from strings and MDAST"
```

---

### Task 3: Markdown Parser (unified pipeline)

**Files:**
- Create: `src/parser/markdown.ts`
- Create: `tests/parser/markdown.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseMarkdown, extractPlainText } from '../../src/parser/markdown.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('parseMarkdown', () => {
  it('parses a markdown file into MDAST', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const tree = parseMarkdown(raw);
    expect(tree.type).toBe('root');
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it('recognizes frontmatter as a yaml node', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const tree = parseMarkdown(raw);
    const yamlNode = tree.children.find((n: any) => n.type === 'yaml');
    expect(yamlNode).toBeDefined();
  });

  it('preserves positions relative to full file', () => {
    const raw = '---\ntitle: Test\n---\nHello world';
    const tree = parseMarkdown(raw);
    // The paragraph after frontmatter should start on line 4
    const paragraph = tree.children.find((n: any) => n.type === 'paragraph');
    expect(paragraph?.position?.start.line).toBe(4);
  });
});

describe('extractPlainText', () => {
  it('extracts plain text from MDAST, skipping frontmatter', () => {
    const raw = '---\ntitle: Test\n---\nHello [[World]].\n\n- Item one\n- Item [[two]]';
    const tree = parseMarkdown(raw);
    const text = extractPlainText(tree);
    expect(text).toContain('Hello World.');
    expect(text).toContain('Item one');
    expect(text).toContain('Item two');
    expect(text).not.toContain('title: Test');
    expect(text).not.toContain('[[');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser/markdown.test.ts`
Expected: FAIL — module not found

**Step 3: Implement markdown.ts**

```typescript
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root } from 'mdast';
import { stripWikiLinks } from './wiki-links.js';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml']);

export function parseMarkdown(raw: string): Root {
  return processor.parse(raw);
}

export function extractPlainText(mdast: Root): string {
  const parts: string[] = [];
  collectText(mdast, parts);
  return parts.join('\n').trim();
}

function collectText(node: any, parts: string[]): void {
  if (node.type === 'yaml') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    parts.push(stripWikiLinks(node.value));
    return;
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectText(child, parts);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser/markdown.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```
git add src/parser/markdown.ts tests/parser/markdown.test.ts
git commit -m "add markdown parser and plain text extraction"
```

---

### Task 4: Frontmatter Parser (gray-matter + type inference)

**Files:**
- Create: `src/parser/frontmatter.ts`
- Create: `tests/parser/frontmatter.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('parseFrontmatter', () => {
  it('extracts frontmatter data and body content', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe('Review vendor proposals');
    expect(result.content).toContain('Review the three vendor proposals');
  });

  it('extracts types array', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    expect(result.types).toEqual(['meeting', 'task']);
  });

  it('defaults types to empty array when missing', () => {
    const raw = '---\ntitle: No Types\n---\nBody';
    const result = parseFrontmatter(raw);
    expect(result.types).toEqual([]);
  });

  it('handles single type as string', () => {
    const raw = '---\ntitle: Test\ntypes: task\n---\nBody';
    const result = parseFrontmatter(raw);
    expect(result.types).toEqual(['task']);
  });
});

describe('field type inference', () => {
  it('infers reference type for wiki-link strings', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const assignee = result.fields.find(f => f.key === 'assignee');
    expect(assignee?.valueType).toBe('reference');
  });

  it('infers list type for arrays', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const attendees = result.fields.find(f => f.key === 'attendees');
    expect(attendees?.valueType).toBe('list');
  });

  it('infers date type for date values', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const dueDate = result.fields.find(f => f.key === 'due_date');
    expect(dueDate?.valueType).toBe('date');
  });

  it('infers number type for numeric values', () => {
    const raw = '---\ntitle: Test\ncount: 42\nprice: 3.14\n---\nBody';
    const result = parseFrontmatter(raw);
    const count = result.fields.find(f => f.key === 'count');
    const price = result.fields.find(f => f.key === 'price');
    expect(count?.valueType).toBe('number');
    expect(price?.valueType).toBe('number');
  });

  it('infers boolean type for true/false', () => {
    const raw = '---\ntitle: Test\nactive: true\n---\nBody';
    const result = parseFrontmatter(raw);
    const active = result.fields.find(f => f.key === 'active');
    expect(active?.valueType).toBe('boolean');
  });

  it('infers string type for plain strings', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-person.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const role = result.fields.find(f => f.key === 'role');
    expect(role?.valueType).toBe('string');
  });

  it('excludes title and types from fields', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const keys = result.fields.map(f => f.key);
    expect(keys).not.toContain('title');
    expect(keys).not.toContain('types');
  });

  it('extracts wiki-links from frontmatter values', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const assigneeLink = result.wikiLinks.find(l => l.field === 'assignee');
    expect(assigneeLink?.target).toBe('Bob Jones');
    expect(assigneeLink?.source).toBe('frontmatter');
  });

  it('extracts wiki-links from array frontmatter values', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFrontmatter(raw);
    const attendeeLinks = result.wikiLinks.filter(l => l.field === 'attendees');
    expect(attendeeLinks).toHaveLength(2);
    expect(attendeeLinks.map(l => l.target)).toEqual(['Alice Smith', 'Bob Jones']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser/frontmatter.test.ts`
Expected: FAIL — module not found

**Step 3: Implement frontmatter.ts**

```typescript
import matter from 'gray-matter';
import type { FieldEntry, WikiLink, FieldValueType } from './types.js';
import { extractWikiLinksFromString } from './wiki-links.js';

const META_KEYS = new Set(['title', 'types']);
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

export interface FrontmatterResult {
  data: Record<string, unknown>;
  content: string;
  types: string[];
  fields: FieldEntry[];
  wikiLinks: WikiLink[];
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  const { data, content } = matter(raw);

  const types = normalizeTypes(data.types);
  const fields: FieldEntry[] = [];
  const wikiLinks: WikiLink[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (META_KEYS.has(key)) continue;

    fields.push({
      key,
      value,
      valueType: inferType(value),
    });

    // Extract wiki-links from this field's value
    const extracted = extractLinksFromValue(value, key);
    wikiLinks.push(...extracted);
  }

  return { data, content, types, fields, wikiLinks };
}

function normalizeTypes(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

function inferType(value: unknown): FieldValueType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') {
    if (WIKI_LINK_RE.test(value)) return 'reference';
  }
  return 'string';
}

function extractLinksFromValue(value: unknown, field: string): WikiLink[] {
  const links: WikiLink[] = [];

  if (typeof value === 'string') {
    for (const raw of extractWikiLinksFromString(value)) {
      links.push({
        target: raw.target,
        alias: raw.alias,
        source: 'frontmatter',
        field,
      });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        for (const raw of extractWikiLinksFromString(item)) {
          links.push({
            target: raw.target,
            alias: raw.alias,
            source: 'frontmatter',
            field,
          });
        }
      }
    }
  }

  return links;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser/frontmatter.test.ts`
Expected: PASS (all 10 tests)

**Step 5: Commit**

```
git add src/parser/frontmatter.ts tests/parser/frontmatter.test.ts
git commit -m "add frontmatter parser with type inference and wiki-link extraction"
```

---

### Task 5: Parser Orchestrator (parseFile)

**Files:**
- Create: `src/parser/index.ts`
- Create: `tests/parser/parse-file.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseFile } from '../../src/parser/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('parseFile', () => {
  it('returns a complete ParsedFile for a task', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.filePath).toBe('tasks/Review vendor proposals.md');
    expect(result.types).toEqual(['task']);
    expect(result.frontmatter.title).toBe('Review vendor proposals');
    expect(result.frontmatter.status).toBe('todo');
  });

  it('combines frontmatter and body wiki-links', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    const frontmatterLinks = result.wikiLinks.filter(l => l.source === 'frontmatter');
    const bodyLinks = result.wikiLinks.filter(l => l.source === 'body');

    // Frontmatter: assignee [[Bob Jones]], source [[Q1 Planning Meeting]]
    expect(frontmatterLinks.map(l => l.target)).toContain('Bob Jones');
    expect(frontmatterLinks.map(l => l.target)).toContain('Q1 Planning Meeting');

    // Body: [[Acme Corp Proposal]], [[Globex Proposal]], [[Alice Smith]]
    expect(bodyLinks.map(l => l.target)).toContain('Acme Corp Proposal');
    expect(bodyLinks.map(l => l.target)).toContain('Globex Proposal');
    expect(bodyLinks.map(l => l.target)).toContain('Alice Smith');
  });

  it('produces contentText without markdown syntax or [[ ]]', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.contentText).toContain('Review the three vendor proposals');
    expect(result.contentText).toContain('Alice Smith');
    expect(result.contentText).not.toContain('[[');
    expect(result.contentText).not.toContain('title:');
  });

  it('produces contentMd as the body markdown', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.contentMd).toContain('[[Acme Corp Proposal]]');
    expect(result.contentMd).not.toContain('title:');
  });

  it('handles multi-typed nodes', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-meeting.md'), 'utf-8');
    const result = parseFile('meetings/Q1 Planning Meeting.md', raw);

    expect(result.types).toEqual(['meeting', 'task']);
  });

  it('includes field entries excluding title and types', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-person.md'), 'utf-8');
    const result = parseFile('people/Alice Smith.md', raw);

    const keys = result.fields.map(f => f.key);
    expect(keys).toContain('role');
    expect(keys).toContain('company');
    expect(keys).toContain('email');
    expect(keys).toContain('tags');
    expect(keys).not.toContain('title');
    expect(keys).not.toContain('types');
  });

  it('has a valid MDAST with correct positions', () => {
    const raw = readFileSync(resolve(fixturesDir, 'sample-task.md'), 'utf-8');
    const result = parseFile('tasks/Review vendor proposals.md', raw);

    expect(result.mdast.type).toBe('root');
    // Frontmatter yaml node should start at line 1
    const yamlNode = result.mdast.children.find((n: any) => n.type === 'yaml');
    expect(yamlNode?.position?.start.line).toBe(1);
  });

  it('handles a file with no frontmatter', () => {
    const raw = 'Just a plain note with [[a link]].';
    const result = parseFile('notes/plain.md', raw);

    expect(result.types).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.wikiLinks).toHaveLength(1);
    expect(result.wikiLinks[0].target).toBe('a link');
    expect(result.contentText).toContain('a link');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser/parse-file.test.ts`
Expected: FAIL — module not found

**Step 3: Implement index.ts**

```typescript
import { parseMarkdown, extractPlainText } from './markdown.js';
import { parseFrontmatter } from './frontmatter.js';
import { extractWikiLinksFromMdast } from './wiki-links.js';
import type { ParsedFile } from './types.js';

export type { ParsedFile, WikiLink, FieldEntry, FieldValueType } from './types.js';

export function parseFile(filePath: string, raw: string): ParsedFile {
  const mdast = parseMarkdown(raw);
  const { data, content, types, fields, wikiLinks: frontmatterLinks } = parseFrontmatter(raw);
  const bodyLinks = extractWikiLinksFromMdast(mdast);
  const contentText = extractPlainText(mdast);

  return {
    filePath,
    frontmatter: data,
    types,
    fields,
    wikiLinks: [...frontmatterLinks, ...bodyLinks],
    mdast,
    contentText,
    contentMd: content.trim(),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser/parse-file.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```
git add src/parser/index.ts tests/parser/parse-file.test.ts
git commit -m "add parseFile orchestrator combining all parser modules"
```

---

### Task 6: Clean Up and Final Verification

**Step 1: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (setup + wiki-links + markdown + frontmatter + parse-file)

**Step 3: Delete the setup smoke test**

Remove `tests/setup.test.ts` — it served its purpose.

**Step 4: Commit**

```
git add -A
git commit -m "parser pipeline complete: markdown, frontmatter, wiki-links"
```
