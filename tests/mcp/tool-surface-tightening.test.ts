import { describe, it, expect } from 'vitest';
import { checkTitleSafety, checkBodyFrontmatter } from '../../src/mcp/tools/title-warnings.js';

describe('checkTitleSafety', () => {
  it('returns no issues for clean titles', () => {
    expect(checkTitleSafety('My Normal Title')).toEqual([]);
  });

  it('flags parentheses', () => {
    const issues = checkTitleSafety('Something (with parens)');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('TITLE_WIKILINK_UNSAFE');
    expect(issues[0].characters).toContain('(');
    expect(issues[0].characters).toContain(')');
  });

  it('flags brackets', () => {
    const issues = checkTitleSafety('Has [brackets]');
    expect(issues[0].characters).toContain('[');
    expect(issues[0].characters).toContain(']');
  });

  it('flags pipe, hash, caret', () => {
    const issues = checkTitleSafety('A | B # C ^ D');
    expect(issues[0].characters).toEqual(expect.arrayContaining(['|', '#', '^']));
  });

  it('returns empty for titles with safe special chars like dashes and apostrophes', () => {
    expect(checkTitleSafety("It's a well-formed — title")).toEqual([]);
  });
});

describe('checkBodyFrontmatter', () => {
  it('returns no issue for normal body', () => {
    expect(checkBodyFrontmatter('Just some text')).toEqual([]);
  });

  it('returns no issue for empty body', () => {
    expect(checkBodyFrontmatter('')).toEqual([]);
  });

  it('flags body starting with frontmatter delimiter', () => {
    const issues = checkBodyFrontmatter('---\ntitle: oops\n---\nBody text');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('FRONTMATTER_IN_BODY');
  });

  it('does not flag horizontal rules mid-body', () => {
    expect(checkBodyFrontmatter('Some text\n\n---\n\nMore text')).toEqual([]);
  });
});
