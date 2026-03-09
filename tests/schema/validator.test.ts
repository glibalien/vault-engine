import { describe, it, expect } from 'vitest';
import { validateNode } from '../../src/schema/validator.js';
import type { ParsedFile } from '../../src/parser/types.js';
import type { MergeResult } from '../../src/schema/types.js';

function makeParsed(fields: Array<{ key: string; value: unknown; valueType: string }>): ParsedFile {
  return {
    filePath: 'test.md',
    frontmatter: {},
    types: [],
    fields: fields as ParsedFile['fields'],
    wikiLinks: [],
    mdast: { type: 'root', children: [] },
    contentText: '',
    contentMd: '',
  };
}

function makeMerge(fields: Record<string, { type: string; required?: boolean; values?: string[]; target_schema?: string }>): MergeResult {
  const merged: MergeResult['fields'] = {};
  for (const [name, def] of Object.entries(fields)) {
    merged[name] = { ...def, sources: ['test'] } as any;
  }
  return { fields: merged, conflicts: [] };
}

describe('validateNode', () => {
  describe('required fields', () => {
    it('warns when a required field is missing', () => {
      const parsed = makeParsed([]);
      const merge = makeMerge({ status: { type: 'enum', required: true, values: ['todo', 'done'] } });

      const result = validateNode(parsed, merge);

      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toEqual({
        field: 'status',
        rule: 'required',
        message: "Required field 'status' is missing",
      });
    });

    it('passes when a required field is present', () => {
      const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum', required: true, values: ['todo', 'done'] } });

      const result = validateNode(parsed, merge);

      expect(result.warnings.filter(w => w.rule === 'required')).toHaveLength(0);
    });

    it('skips non-required fields that are missing', () => {
      const parsed = makeParsed([]);
      const merge = makeMerge({ notes: { type: 'string' } });

      const result = validateNode(parsed, merge);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('type compatibility', () => {
    it('warns on type mismatch (schema expects number, got string)', () => {
      const parsed = makeParsed([{ key: 'count', value: 'abc', valueType: 'string' }]);
      const merge = makeMerge({ count: { type: 'number' } });
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ field: 'count', rule: 'type_mismatch' });
    });

    it('passes when types are compatible', () => {
      const parsed = makeParsed([{ key: 'count', value: 42, valueType: 'number' }]);
      const merge = makeMerge({ count: { type: 'number' } });
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(true);
    });

    it('accepts string valueType for enum schema type', () => {
      const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
    });

    it('accepts reference valueType for reference schema type', () => {
      const parsed = makeParsed([{ key: 'assignee', value: '[[Alice]]', valueType: 'reference' }]);
      const merge = makeMerge({ assignee: { type: 'reference' } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
    });

    it('accepts list valueType for list<string> schema type', () => {
      const parsed = makeParsed([{ key: 'tags', value: ['a', 'b'], valueType: 'list' }]);
      const merge = makeMerge({ tags: { type: 'list<string>' } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
    });

    it('accepts list valueType for list<reference> schema type', () => {
      const parsed = makeParsed([{ key: 'attendees', value: ['[[Alice]]', '[[Bob]]'], valueType: 'list' }]);
      const merge = makeMerge({ attendees: { type: 'list<reference>' } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'type_mismatch')).toHaveLength(0);
    });

    it('skips fields not in schema (extra frontmatter fields are fine)', () => {
      const parsed = makeParsed([{ key: 'custom', value: 'whatever', valueType: 'string' }]);
      const merge = makeMerge({});
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(true);
    });
  });

  describe('enum validation', () => {
    it('warns when enum value is not in allowed values', () => {
      const parsed = makeParsed([{ key: 'status', value: 'invalid', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ field: 'status', rule: 'invalid_enum' });
    });

    it('passes when enum value is in allowed values', () => {
      const parsed = makeParsed([{ key: 'status', value: 'todo', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum', values: ['todo', 'done'] } });
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(true);
    });

    it('skips enum check when schema has no values array', () => {
      const parsed = makeParsed([{ key: 'status', value: 'anything', valueType: 'string' }]);
      const merge = makeMerge({ status: { type: 'enum' } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'invalid_enum')).toHaveLength(0);
    });
  });

  describe('reference validation', () => {
    it('warns when reference field lacks wiki-link syntax', () => {
      const parsed = makeParsed([{ key: 'assignee', value: 'Alice', valueType: 'string' }]);
      const merge = makeMerge({ assignee: { type: 'reference' } });
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(false);
      // type_mismatch also fires (string vs reference), plus invalid_reference
      expect(result.warnings.filter(w => w.rule === 'invalid_reference')).toHaveLength(1);
      expect(result.warnings.filter(w => w.rule === 'invalid_reference')[0]).toMatchObject({
        field: 'assignee',
        rule: 'invalid_reference',
      });
    });

    it('passes when reference field has wiki-link syntax', () => {
      const parsed = makeParsed([{ key: 'assignee', value: '[[Alice]]', valueType: 'reference' }]);
      const merge = makeMerge({ assignee: { type: 'reference' } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'invalid_reference')).toHaveLength(0);
    });

    it('warns for list<reference> items without wiki-link syntax', () => {
      const parsed = makeParsed([{ key: 'attendees', value: ['[[Alice]]', 'Bob', '[[Carol]]'], valueType: 'list' }]);
      const merge = makeMerge({ attendees: { type: 'list<reference>' } });
      const result = validateNode(parsed, merge);
      expect(result.valid).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({
        field: 'attendees',
        rule: 'invalid_reference',
        message: expect.stringContaining('Bob'),
      });
    });

    it('passes for list<reference> when all items are wiki-links', () => {
      const parsed = makeParsed([{ key: 'attendees', value: ['[[Alice]]', '[[Bob]]'], valueType: 'list' }]);
      const merge = makeMerge({ attendees: { type: 'list<reference>' } });
      const result = validateNode(parsed, merge);
      expect(result.warnings.filter(w => w.rule === 'invalid_reference')).toHaveLength(0);
    });
  });
});
