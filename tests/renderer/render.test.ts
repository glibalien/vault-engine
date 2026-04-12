import { describe, it, expect } from 'vitest';
import { renderNode } from '../../src/renderer/render.js';
import { parseMarkdown } from '../../src/parser/parse.js';
import type { RenderInput, FieldOrderEntry } from '../../src/renderer/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    title: 'Test Note',
    types: ['note'],
    fields: {},
    body: '',
    fieldOrdering: [],
    referenceFields: new Set(),
    listReferenceFields: new Set(),
    orphanRawValues: {},
    ...overrides,
  };
}

function ordering(...entries: Array<[string, 'claimed' | 'orphan']>): FieldOrderEntry[] {
  return entries.map(([field, category]) => ({ field, category }));
}

// ── Structure tests ─────────────────────────────────────────────────────

describe('renderNode', () => {
  it('renders minimal node with title and types', () => {
    const result = renderNode(makeInput());

    expect(result).toContain('title: Test Note');
    expect(result).toContain('types:\n  - note');
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/---\n$/);
  });

  it('title always first, types always second', () => {
    const result = renderNode(makeInput({
      fields: { status: 'open' },
      fieldOrdering: ordering(['status', 'claimed']),
    }));

    const lines = result.split('\n');
    const titleIdx = lines.findIndex(l => l.startsWith('title:'));
    const typesIdx = lines.findIndex(l => l.startsWith('types:'));
    const statusIdx = lines.findIndex(l => l.startsWith('status:'));

    expect(titleIdx).toBeLessThan(typesIdx);
    expect(typesIdx).toBeLessThan(statusIdx);
  });

  it('multiple types rendered as block sequence in order', () => {
    const result = renderNode(makeInput({ types: ['task', 'meeting'] }));
    expect(result).toContain('types:\n  - task\n  - meeting');
  });

  it('single type rendered as block sequence', () => {
    const result = renderNode(makeInput({ types: ['task'] }));
    expect(result).toContain('types:\n  - task');
  });

  it('empty types rendered as implicit null (bare key)', () => {
    const result = renderNode(makeInput({ types: [] }));
    // Should have `types:` with nothing after it (implicit null, not `types: []`)
    expect(result).toContain('types:');
    expect(result).not.toContain('types: []');
    expect(result).not.toContain('types: null');
    // Obsidian can safely append `\n  - person` to this
  });

  // ── Field ordering ──────────────────────────────────────────────────

  it('claimed fields appear in ordering, orphans after claimed', () => {
    const result = renderNode(makeInput({
      fields: { status: 'open', priority: 'high', custom: 'value' },
      fieldOrdering: ordering(
        ['priority', 'claimed'],
        ['status', 'claimed'],
        ['custom', 'orphan'],
      ),
    }));

    const lines = result.split('\n');
    const priorityIdx = lines.findIndex(l => l.startsWith('priority:'));
    const statusIdx = lines.findIndex(l => l.startsWith('status:'));
    const customIdx = lines.findIndex(l => l.startsWith('custom:'));

    expect(priorityIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(customIdx);
  });

  // ── Null handling ───────────────────────────────────────────────────

  it('null-valued field omitted from frontmatter', () => {
    const result = renderNode(makeInput({
      fields: { status: null, priority: 'high' },
      fieldOrdering: ordering(['status', 'claimed'], ['priority', 'claimed']),
    }));

    expect(result).not.toContain('status:');
    expect(result).toContain('priority: high');
  });

  it('falsy values 0, false, empty string are NOT omitted', () => {
    const result = renderNode(makeInput({
      fields: { count: 0, done: false, label: '' },
      fieldOrdering: ordering(
        ['count', 'claimed'],
        ['done', 'claimed'],
        ['label', 'claimed'],
      ),
    }));

    expect(result).toContain('count: 0');
    expect(result).toContain('done: false');
    expect(result).toContain('label: ""');
  });

  // ── Wiki-link wrapping ──────────────────────────────────────────────

  it('claimed reference field wrapped in [[brackets]]', () => {
    const result = renderNode(makeInput({
      fields: { project: 'Vault Engine' },
      fieldOrdering: ordering(['project', 'claimed']),
      referenceFields: new Set(['project']),
    }));

    expect(result).toContain('project: "[[Vault Engine]]"');
  });

  it('claimed list<reference> field elements wrapped in [[brackets]]', () => {
    const result = renderNode(makeInput({
      fields: { people: ['Alice', 'Bob'] },
      fieldOrdering: ordering(['people', 'claimed']),
      listReferenceFields: new Set(['people']),
    }));

    expect(result).toContain('[[Alice]]');
    expect(result).toContain('[[Bob]]');
  });

  it('orphan field with value_raw_text uses raw text (preserves aliases)', () => {
    const result = renderNode(makeInput({
      fields: { project: 'Vault Engine' },
      fieldOrdering: ordering(['project', 'orphan']),
      orphanRawValues: { project: '[[Vault Engine|VE]]' },
    }));

    expect(result).toContain('[[Vault Engine|VE]]');
  });

  it('orphan field without value_raw_text uses reconstructed value as-is', () => {
    const result = renderNode(makeInput({
      fields: { custom: 'plain text' },
      fieldOrdering: ordering(['custom', 'orphan']),
    }));

    expect(result).toContain('custom: plain text');
    expect(result).not.toContain('[[');
  });

  // ── Body content ────────────────────────────────────────────────────

  it('non-empty body appended after closing ---', () => {
    const result = renderNode(makeInput({ body: '# Hello\n\nSome content.' }));
    expect(result).toMatch(/---\n# Hello\n\nSome content\.$/);
  });

  it('empty body: file ends with ---\\n', () => {
    const result = renderNode(makeInput({ body: '' }));
    expect(result).toMatch(/---\n$/);
  });

  it('body with leading newline preserved', () => {
    const result = renderNode(makeInput({ body: '\nContent after blank line' }));
    expect(result).toMatch(/---\n\nContent after blank line$/);
  });

  // ── Determinism ─────────────────────────────────────────────────────

  it('same input produces identical bytes on repeated calls', () => {
    const input = makeInput({
      fields: { status: 'open', priority: 3, done: false },
      fieldOrdering: ordering(
        ['status', 'claimed'],
        ['priority', 'claimed'],
        ['done', 'claimed'],
      ),
      body: '# Content\n\nParagraph here.',
    });

    const a = renderNode(input);
    const b = renderNode(input);
    const c = renderNode(input);

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  // ── List and nested values ──────────────────────────────────────────

  it('list fields render as YAML sequences', () => {
    const result = renderNode(makeInput({
      fields: { tags: ['foo', 'bar', 'baz'] },
      fieldOrdering: ordering(['tags', 'claimed']),
    }));

    expect(result).toContain('tags:\n  - foo\n  - bar\n  - baz');
  });

  it('boolean field renders correctly', () => {
    const result = renderNode(makeInput({
      fields: { done: true },
      fieldOrdering: ordering(['done', 'claimed']),
    }));

    expect(result).toContain('done: true');
  });

  it('number field renders correctly', () => {
    const result = renderNode(makeInput({
      fields: { priority: 42 },
      fieldOrdering: ordering(['priority', 'claimed']),
    }));

    expect(result).toContain('priority: 42');
  });

  // ── Round-trip tests ────────────────────────────────────────────────

  it('round-trip: render then parse produces equivalent structure', () => {
    const input = makeInput({
      title: 'My Note',
      types: ['task', 'note'],
      fields: {
        status: 'open',
        priority: 3,
        due: '2026-04-11',
        done: false,
        tags: ['important', 'work'],
      },
      body: '# Content\n\nThis is the body.\n',
      fieldOrdering: ordering(
        ['status', 'claimed'],
        ['priority', 'claimed'],
        ['due', 'claimed'],
        ['done', 'claimed'],
        ['tags', 'claimed'],
      ),
    });

    const rendered = renderNode(input);
    const parsed = parseMarkdown(rendered, 'My Note.md');

    expect(parsed.parseError).toBeNull();
    expect(parsed.title).toBe('My Note');
    expect(parsed.types).toEqual(['task', 'note']);
    expect(parsed.fields.get('status')).toBe('open');
    expect(parsed.fields.get('priority')).toBe(3);
    expect(parsed.fields.get('due')).toBe('2026-04-11');
    expect(parsed.fields.get('done')).toBe(false);
    expect(parsed.fields.get('tags')).toEqual(['important', 'work']);
    expect(parsed.body).toBe('# Content\n\nThis is the body.\n');
  });

  it('round-trip: reference field re-wrapping survives parse', () => {
    const input = makeInput({
      fields: { project: 'Vault Engine' },
      fieldOrdering: ordering(['project', 'claimed']),
      referenceFields: new Set(['project']),
    });

    const rendered = renderNode(input);
    const parsed = parseMarkdown(rendered, 'Test.md');

    // Parser strips [[brackets]], so the value should be the target
    expect(parsed.fields.get('project')).toBe('Vault Engine');
    // Parser extracts the wiki-link
    expect(parsed.wikiLinks.some(l => l.target === 'Vault Engine')).toBe(true);
  });

  it('round-trip: list<reference> field survives parse', () => {
    const input = makeInput({
      fields: { people: ['Alice', 'Bob'] },
      fieldOrdering: ordering(['people', 'claimed']),
      listReferenceFields: new Set(['people']),
    });

    const rendered = renderNode(input);
    const parsed = parseMarkdown(rendered, 'Test.md');

    expect(parsed.fields.get('people')).toEqual(['Alice', 'Bob']);
    expect(parsed.wikiLinks.some(l => l.target === 'Alice')).toBe(true);
    expect(parsed.wikiLinks.some(l => l.target === 'Bob')).toBe(true);
  });

  it('round-trip: empty body renders and parses back', () => {
    const input = makeInput({ body: '' });
    const rendered = renderNode(input);
    const parsed = parseMarkdown(rendered, 'Test.md');
    expect(parsed.body).toBe('');
  });

  it('round-trip: types canonicalization (scalar → list)', () => {
    // Parser accepts scalar types, renderer always outputs list
    const input = makeInput({ types: ['task'] });
    const rendered = renderNode(input);
    const parsed = parseMarkdown(rendered, 'Test.md');
    expect(parsed.types).toEqual(['task']);
  });

  it('round-trip determinism: render → parse → reconstruct → render → same bytes', () => {
    const input = makeInput({
      title: 'Round Trip',
      types: ['task'],
      fields: {
        status: 'open',
        count: 5,
        tags: ['a', 'b'],
      },
      body: 'Some body content.\n',
      fieldOrdering: ordering(
        ['status', 'claimed'],
        ['count', 'claimed'],
        ['tags', 'claimed'],
      ),
    });

    const rendered1 = renderNode(input);
    const parsed = parseMarkdown(rendered1, 'test.md');

    // Reconstruct RenderInput from parsed
    const fields2: Record<string, unknown> = {};
    for (const [k, v] of parsed.fields) {
      fields2[k] = v;
    }
    const input2 = makeInput({
      title: parsed.title!,
      types: parsed.types,
      fields: fields2,
      body: parsed.body,
      fieldOrdering: ordering(
        ['status', 'claimed'],
        ['count', 'claimed'],
        ['tags', 'claimed'],
      ),
    });

    const rendered2 = renderNode(input2);
    expect(rendered2).toBe(rendered1);
  });
});
