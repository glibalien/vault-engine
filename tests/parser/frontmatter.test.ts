import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';

describe('parseFrontmatter', () => {
  describe('types array filtering', () => {
    it('filters out non-string elements from types array', () => {
      const raw = '---\ntypes:\n  - meeting\n  - date: 2026-04-13\n  - true\n  - 42\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual(['meeting']);
    });

    it('strips [[wikilink]] brackets from type strings', () => {
      const raw = '---\ntypes:\n  - "[[person]]"\n  - meeting\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual(['person', 'meeting']);
    });

    it('strips [[wikilink]] brackets from scalar type string', () => {
      const raw = '---\ntypes: "[[person]]"\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual(['person']);
    });

    it('handles types array with only non-string elements', () => {
      const raw = '---\ntypes:\n  - date: 2026-04-13\n  - status: active\n---\nBody.\n';
      const result = parseFrontmatter(raw);
      expect(result.types).toEqual([]);
    });
  });
});
