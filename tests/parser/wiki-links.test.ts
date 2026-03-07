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
