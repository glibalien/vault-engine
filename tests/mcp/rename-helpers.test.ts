import { describe, it, expect } from 'vitest';
import { updateBodyReferences } from '../../src/mcp/rename-helpers.js';

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
