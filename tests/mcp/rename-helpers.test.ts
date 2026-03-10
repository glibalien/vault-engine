import { describe, it, expect } from 'vitest';
import { updateBodyReferences, updateFrontmatterReferences } from '../../src/mcp/rename-helpers.js';

describe('updateBodyReferences', () => {
  it('replaces a single wiki-link target', () => {
    const body = 'See [[Alice]] for details.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Smith]] for details.');
  });

  it('preserves alias when renaming target', () => {
    const body = 'Contact [[Alice|the boss]] today.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('Contact [[Alice Smith|the boss]] today.');
  });

  it('matches case-insensitively', () => {
    const body = 'See [[alice]] and [[ALICE]] here.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Smith]] and [[Alice Smith]] here.');
  });

  it('replaces multiple occurrences in one body', () => {
    const body = 'First [[Alice]], then [[Alice]] again.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('First [[Alice Smith]], then [[Alice Smith]] again.');
  });

  it('does not replace substring matches', () => {
    const body = 'See [[Alice Cooper]] and [[Alice]].';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Cooper]] and [[Alice Smith]].');
  });

  it('returns body unchanged when no matches', () => {
    const body = 'See [[Bob]] for details.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Bob]] for details.');
  });

  it('handles empty body', () => {
    expect(updateBodyReferences('', 'Alice', 'Alice Smith')).toBe('');
  });

  it('handles link at start of body', () => {
    const body = '[[Alice]] is here.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('[[Alice Smith]] is here.');
  });

  it('handles link at end of body', () => {
    const body = 'See [[Alice]]';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Smith]]');
  });
});

describe('updateFrontmatterReferences', () => {
  it('replaces reference in a scalar string field', () => {
    const fields = { assignee: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ assignee: '[[Alice Smith]]' });
  });

  it('replaces references in array field values', () => {
    const fields = { reviewers: ['[[Alice]]', '[[Bob]]'] };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ reviewers: ['[[Alice Smith]]', '[[Bob]]'] });
  });

  it('preserves alias in frontmatter references', () => {
    const fields = { lead: '[[Alice|project lead]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ lead: '[[Alice Smith|project lead]]' });
  });

  it('does not modify non-reference string fields', () => {
    const fields = { status: 'in-progress', assignee: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ status: 'in-progress', assignee: '[[Alice Smith]]' });
  });

  it('preserves non-string values unchanged', () => {
    const fields = { count: 5, done: true, assignee: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ count: 5, done: true, assignee: '[[Alice Smith]]' });
  });

  it('matches case-insensitively', () => {
    const fields = { assignee: '[[alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ assignee: '[[Alice Smith]]' });
  });

  it('does not replace substring matches', () => {
    const fields = { person: '[[Alice Cooper]]', other: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ person: '[[Alice Cooper]]', other: '[[Alice Smith]]' });
  });

  it('handles multiple references in one string', () => {
    const fields = { note: 'From [[Alice]] to [[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ note: 'From [[Alice Smith]] to [[Alice Smith]]' });
  });

  it('returns empty object for empty input', () => {
    expect(updateFrontmatterReferences({}, 'Alice', 'Alice Smith')).toEqual({});
  });
});
