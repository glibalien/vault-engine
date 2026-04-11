import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_VAULT } from '../helpers/vault.js';
import { parseMarkdown } from '../../src/parser/parse.js';

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_VAULT, name), 'utf-8');
}

describe('parseMarkdown', () => {
  describe('types extraction', () => {
    it('extracts types as string array from frontmatter', () => {
      const result = parseMarkdown(fixture('multi-type.md'), 'multi-type.md');
      expect(result.types).toEqual(['meeting', 'note']);
    });

    it('returns empty types for no-frontmatter file', () => {
      const result = parseMarkdown(fixture('plain-no-frontmatter.md'), 'plain-no-frontmatter.md');
      expect(result.types).toEqual([]);
    });

    it('returns empty types for empty-frontmatter file', () => {
      const result = parseMarkdown(fixture('empty-frontmatter.md'), 'empty-frontmatter.md');
      expect(result.types).toEqual([]);
    });
  });

  describe('title resolution', () => {
    it('uses frontmatter title when present', () => {
      const result = parseMarkdown(fixture('body-wikilinks.md'), 'body-wikilinks.md');
      expect(result.title).toBe('Body Links Test');
    });

    it('falls back to first H1 when no frontmatter title', () => {
      const result = parseMarkdown(fixture('plain-no-frontmatter.md'), 'plain-no-frontmatter.md');
      expect(result.title).toBe('A Plain Note');
    });

    it('falls back to filename when no title or H1', () => {
      const result = parseMarkdown(fixture('empty-frontmatter.md'), 'empty-frontmatter.md');
      expect(result.title).toBe('empty-frontmatter');
    });

    it('preserves unicode in title', () => {
      const result = parseMarkdown(fixture('unicode-title.md'), 'unicode-title.md');
      expect(result.title).toBe('Café Meeting — 東京');
    });
  });

  describe('fields extraction', () => {
    it('preserves native JS types (number stays number)', () => {
      const result = parseMarkdown(fixture('multi-type.md'), 'multi-type.md');
      expect(result.fields.get('priority')).toBe(1);
    });

    it('preserves arrays in fields after bracket stripping', () => {
      const result = parseMarkdown(fixture('multi-type.md'), 'multi-type.md');
      const attendees = result.fields.get('attendees');
      expect(attendees).toEqual(['Alice', 'Bob']);
    });

    it('strips wiki-link brackets from string field values', () => {
      const result = parseMarkdown(fixture('frontmatter-wikilinks.md'), 'frontmatter-wikilinks.md');
      expect(result.fields.get('project')).toBe('Vault Engine');
      expect(result.fields.get('company')).toBe('Acme Corp');
    });

    it('does NOT include title in fields map', () => {
      const result = parseMarkdown(fixture('multi-type.md'), 'multi-type.md');
      expect(result.fields.has('title')).toBe(false);
    });

    it('does NOT include types in fields map', () => {
      const result = parseMarkdown(fixture('multi-type.md'), 'multi-type.md');
      expect(result.fields.has('types')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('sets parseError for malformed YAML', () => {
      const result = parseMarkdown(fixture('malformed-yaml.md'), 'malformed-yaml.md');
      expect(result.parseError).toBeTruthy();
      expect(result.types).toEqual([]);
      expect(result.fields.size).toBe(0);
    });

    it('preserves body content on parse error (entire file)', () => {
      const raw = fixture('malformed-yaml.md');
      const result = parseMarkdown(raw, 'malformed-yaml.md');
      expect(result.body).toBe(raw);
    });
  });

  describe('frontmatter wiki-links', () => {
    it('extracts wiki-links from string fields', () => {
      const result = parseMarkdown(fixture('frontmatter-wikilinks.md'), 'frontmatter-wikilinks.md');
      const fmLinks = result.wikiLinks.filter((l) => l.context === 'project');
      expect(fmLinks).toHaveLength(1);
      expect(fmLinks[0].target).toBe('Vault Engine');
    });

    it('extracts wiki-links from array fields', () => {
      const result = parseMarkdown(fixture('frontmatter-wikilinks.md'), 'frontmatter-wikilinks.md');
      const peopleLinks = result.wikiLinks.filter((l) => l.context === 'people');
      expect(peopleLinks).toHaveLength(2);
      expect(peopleLinks.map((l) => l.target)).toEqual(['Alice', 'Bob']);
    });

    it('handles aliased wiki-link: stores canonical target as field value', () => {
      const result = parseMarkdown(fixture('alias-wikilink.md'), 'alias-wikilink.md');
      expect(result.fields.get('contact')).toBe('Alice Smith');
      const contactLinks = result.wikiLinks.filter((l) => l.context === 'contact');
      expect(contactLinks).toHaveLength(1);
      expect(contactLinks[0].target).toBe('Alice Smith');
      expect(contactLinks[0].alias).toBe('our contact');
    });

    it('uses field name as context for frontmatter wiki-links', () => {
      const result = parseMarkdown(fixture('frontmatter-wikilinks.md'), 'frontmatter-wikilinks.md');
      const companyLinks = result.wikiLinks.filter((l) => l.context === 'company');
      expect(companyLinks).toHaveLength(1);
      expect(companyLinks[0].context).toBe('company');
    });
  });

  describe('body wiki-links', () => {
    it('extracts wiki-links from body text', () => {
      const result = parseMarkdown(fixture('body-wikilinks.md'), 'body-wikilinks.md');
      const targets = result.wikiLinks.map((l) => l.target);
      expect(targets).toContain('Alice Smith');
      expect(targets).toContain('Bob Jones');
      expect(targets).toContain('Vault Engine');
    });

    it('extracts aliases from body wiki-links', () => {
      const result = parseMarkdown(fixture('body-wikilinks.md'), 'body-wikilinks.md');
      const bobLink = result.wikiLinks.find((l) => l.target === 'Bob Jones');
      expect(bobLink?.alias).toBe('Bob');
    });

    it('does NOT extract wiki-links from fenced code blocks', () => {
      const result = parseMarkdown(fixture('code-block-links.md'), 'code-block-links.md');
      const targets = result.wikiLinks.map((l) => l.target);
      expect(targets).toContain('Alice Smith');
      expect(targets).toContain('Bob Jones');
      expect(targets).not.toContain('Fake Link');
      expect(targets).not.toContain('Another Fake');
    });

    it('extracts wiki-links from GFM table cells', () => {
      const result = parseMarkdown(fixture('gfm-tables.md'), 'gfm-tables.md');
      const targets = result.wikiLinks.map((l) => l.target);
      expect(targets).toContain('Alice');
      expect(targets).toContain('Bob');
      expect(targets).toContain('Charlie');
    });

    it('provides context for body wiki-links', () => {
      const result = parseMarkdown(fixture('body-wikilinks.md'), 'body-wikilinks.md');
      const aliceLink = result.wikiLinks.find((l) => l.target === 'Alice Smith');
      expect(aliceLink?.context).toBeTruthy();
      expect(aliceLink!.context.length).toBeGreaterThan(0);
      expect(aliceLink!.context.length).toBeLessThanOrEqual(200);
    });
  });

  describe('combined wiki-links', () => {
    it('collects both frontmatter and body wiki-links', () => {
      const result = parseMarkdown(fixture('multi-type.md'), 'multi-type.md');
      // Frontmatter links: date, project, attendees (Alice, Bob)
      const fmLinks = result.wikiLinks.filter(
        (l) => l.context === 'date' || l.context === 'project' || l.context === 'attendees',
      );
      expect(fmLinks.length).toBeGreaterThanOrEqual(4);

      // Body link: SQLite
      const bodyLinks = result.wikiLinks.filter((l) => l.target === 'SQLite');
      expect(bodyLinks).toHaveLength(1);
    });
  });
});
