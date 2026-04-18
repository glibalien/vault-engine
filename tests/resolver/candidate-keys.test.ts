import { describe, it, expect } from 'vitest';
import { candidateKeysForNode } from '../../src/resolver/candidate-keys.js';

describe('candidateKeysForNode', () => {
  it('produces file_path, title, basename, case-folded basename, NFC basename', () => {
    const keys = candidateKeysForNode({
      file_path: 'Projects/Acme Corp.md',
      title: 'Acme Corp',
    });
    expect(keys.file_path).toBe('Projects/Acme Corp.md');
    expect(keys.title).toBe('Acme Corp');
    expect(keys.basename).toBe('Acme Corp');
    expect(keys.basenameLower).toBe('acme corp');
    expect(keys.basenameNfcLower).toBe('acme corp');
  });

  it('strips .md extension from basename', () => {
    const keys = candidateKeysForNode({ file_path: 'a/b/Foo.md', title: 'Foo' });
    expect(keys.basename).toBe('Foo');
  });

  it('normalizes unicode for NFC key', () => {
    // "café" as NFD (e + combining acute)
    const nfd = 'cafe\u0301';
    const keys = candidateKeysForNode({ file_path: `${nfd}.md`, title: nfd });
    expect(keys.basenameNfcLower).toBe('café'.normalize('NFC').toLowerCase());
  });

  it('returns null title when title is null', () => {
    const keys = candidateKeysForNode({ file_path: 'Untitled.md', title: null });
    expect(keys.title).toBeNull();
    expect(keys.basename).toBe('Untitled');
  });
});
