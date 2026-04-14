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

  describe('unquoted wikilink handling', () => {
    it('extracts wikilink from quoted [[target]] string', () => {
      const raw = '---\nband: "[[The Police]]"\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('band')).toBe('The Police');
      expect(result.wikiLinks).toEqual([
        { target: 'The Police', alias: null, context: 'band' },
      ]);
    });

    it('detects unquoted [[target]] (YAML nested array) as a wikilink', () => {
      // YAML parses unquoted [[The Police]] as flow notation → [["The Police"]]
      const raw = '---\nband: [[The Police]]\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('band')).toBe('The Police');
      expect(result.wikiLinks).toEqual([
        { target: 'The Police', alias: null, context: 'band' },
      ]);
    });

    it('detects unquoted date-like wikilink [[2023-09-09]]', () => {
      const raw = '---\ndate: [[2023-09-09]]\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('date')).toBe('2023-09-09');
      expect(result.wikiLinks).toEqual([
        { target: '2023-09-09', alias: null, context: 'date' },
      ]);
    });

    it('still handles normal arrays without false-positive wikilink detection', () => {
      const raw = '---\ntags:\n  - music\n  - rock\n---\n';
      const result = parseFrontmatter(raw);
      expect(result.fields.get('tags')).toEqual(['music', 'rock']);
      expect(result.wikiLinks).toEqual([]);
    });
  });
});
