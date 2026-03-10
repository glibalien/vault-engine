import { describe, it, expect } from 'vitest';
import { serializeValue, serializeFrontmatter } from '../../src/serializer/frontmatter.js';

describe('serializeValue', () => {
  it('serializes plain strings unquoted', () => {
    expect(serializeValue('todo')).toBe('todo');
  });

  it('serializes strings with spaces unquoted', () => {
    expect(serializeValue('in progress')).toBe('in progress');
  });

  it('serializes wiki-link strings double-quoted', () => {
    expect(serializeValue('[[Alice Smith]]')).toBe('"[[Alice Smith]]"');
  });

  it('serializes strings with colons double-quoted', () => {
    expect(serializeValue('note: important')).toBe('"note: important"');
  });

  it('serializes strings with hash double-quoted', () => {
    expect(serializeValue('section #1')).toBe('"section #1"');
  });

  it('serializes empty string double-quoted', () => {
    expect(serializeValue('')).toBe('""');
  });

  it('serializes numbers bare', () => {
    expect(serializeValue(3)).toBe('3');
    expect(serializeValue(3.14)).toBe('3.14');
  });

  it('serializes booleans bare', () => {
    expect(serializeValue(true)).toBe('true');
    expect(serializeValue(false)).toBe('false');
  });

  it('serializes Date as YYYY-MM-DD', () => {
    expect(serializeValue(new Date('2025-03-06'))).toBe('2025-03-06');
  });

  it('serializes arrays inline with unquoted safe items', () => {
    expect(serializeValue(['meeting', 'task'])).toBe('[meeting, task]');
  });

  it('serializes arrays with wiki-link items double-quoted', () => {
    expect(serializeValue(['[[Alice Smith]]', '[[Bob Jones]]'])).toBe(
      '["[[Alice Smith]]", "[[Bob Jones]]"]',
    );
  });

  it('serializes mixed arrays quoting only items that need it', () => {
    expect(serializeValue(['safe', '[[ref]]', 'also-safe'])).toBe(
      '[safe, "[[ref]]", also-safe]',
    );
  });

  it('serializes number arrays bare', () => {
    expect(serializeValue([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('quotes strings with leading or trailing whitespace', () => {
    expect(serializeValue('foo ')).toBe('"foo "');
    expect(serializeValue(' bar')).toBe('" bar"');
  });

  it('quotes strings that look like YAML booleans', () => {
    expect(serializeValue('true')).toBe('"true"');
    expect(serializeValue('false')).toBe('"false"');
    expect(serializeValue('yes')).toBe('"yes"');
    expect(serializeValue('no')).toBe('"no"');
  });

  it('quotes strings that look like YAML null', () => {
    expect(serializeValue('null')).toBe('"null"');
    expect(serializeValue('Null')).toBe('"Null"');
    expect(serializeValue('NULL')).toBe('"NULL"');
    expect(serializeValue('~')).toBe('"~"');
  });

  it('quotes strings that look like numbers', () => {
    expect(serializeValue('123')).toBe('"123"');
    expect(serializeValue('3.14')).toBe('"3.14"');
  });

  it('quotes strings with curly braces', () => {
    expect(serializeValue('{foo}')).toBe('"{foo}"');
  });

  it('quotes strings with square brackets (non-wiki-link)', () => {
    expect(serializeValue('[item]')).toBe('"[item]"');
  });
});

describe('serializeFrontmatter', () => {
  it('serializes ordered entries as YAML lines', () => {
    const result = serializeFrontmatter([
      { key: 'title', value: 'Review proposal' },
      { key: 'status', value: 'todo' },
    ]);
    expect(result).toBe('title: Review proposal\nstatus: todo\n');
  });

  it('handles mixed value types', () => {
    const result = serializeFrontmatter([
      { key: 'title', value: 'Q1 Meeting' },
      { key: 'types', value: ['meeting', 'task'] },
      { key: 'date', value: new Date('2025-03-06') },
      { key: 'attendees', value: ['[[Alice Smith]]', '[[Bob Jones]]'] },
      { key: 'status', value: 'todo' },
      { key: 'billable', value: false },
      { key: 'priority', value: 3 },
    ]);
    const lines = result.split('\n');
    expect(lines[0]).toBe('title: Q1 Meeting');
    expect(lines[1]).toBe('types: [meeting, task]');
    expect(lines[2]).toBe('date: 2025-03-06');
    expect(lines[3]).toBe('attendees: ["[[Alice Smith]]", "[[Bob Jones]]"]');
    expect(lines[4]).toBe('status: todo');
    expect(lines[5]).toBe('billable: false');
    expect(lines[6]).toBe('priority: 3');
  });

  it('returns empty string for empty entries', () => {
    expect(serializeFrontmatter([])).toBe('');
  });
});
