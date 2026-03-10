import { describe, it, expect } from 'vitest';
import { serializeNode } from '../../src/serializer/node-to-file.js';

describe('serializeNode', () => {
  it('serializes a minimal node with title and types only', () => {
    const result = serializeNode({
      title: 'My Note',
      types: ['note'],
      fields: {},
    });
    expect(result).toBe('---\ntitle: My Note\ntypes: [note]\n---\n');
  });

  it('serializes a node with fields and body', () => {
    const result = serializeNode({
      title: 'Review proposal',
      types: ['task'],
      fields: {
        status: 'todo',
        assignee: '[[Bob Jones]]',
        due_date: new Date('2025-03-10'),
        priority: 'high',
      },
      body: 'Review the three vendor proposals.',
    });
    const lines = result.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('title: Review proposal');
    expect(lines[2]).toBe('types: [task]');
    // fields in alphabetical order (no fieldOrder provided)
    expect(lines[3]).toBe('assignee: "[[Bob Jones]]"');
    expect(lines[4]).toBe('due_date: 2025-03-10');
    expect(lines[5]).toBe('priority: high');
    expect(lines[6]).toBe('status: todo');
    expect(lines[7]).toBe('---');
    expect(lines[8]).toBe('');
    expect(lines[9]).toBe('Review the three vendor proposals.');
  });

  it('respects fieldOrder for schema-defined ordering', () => {
    const result = serializeNode({
      title: 'Review proposal',
      types: ['task'],
      fields: {
        status: 'todo',
        assignee: '[[Bob Jones]]',
        due_date: new Date('2025-03-10'),
        priority: 'high',
      },
      fieldOrder: ['status', 'assignee', 'due_date', 'priority'],
    });
    const lines = result.split('\n');
    expect(lines[2]).toBe('types: [task]');
    expect(lines[3]).toBe('status: todo');
    expect(lines[4]).toBe('assignee: "[[Bob Jones]]"');
    expect(lines[5]).toBe('due_date: 2025-03-10');
    expect(lines[6]).toBe('priority: high');
  });

  it('puts schema-ordered fields first, then remaining alphabetically', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['task'],
      fields: {
        status: 'todo',
        custom_note: 'extra info',
        assignee: '[[Alice]]',
        zebra: 'last',
      },
      fieldOrder: ['status', 'assignee'],
    });
    const lines = result.split('\n');
    expect(lines[3]).toBe('status: todo');
    expect(lines[4]).toBe('assignee: "[[Alice]]"');
    expect(lines[5]).toBe('custom_note: extra info');
    expect(lines[6]).toBe('zebra: last');
  });

  it('skips fieldOrder entries not present in fields', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['task'],
      fields: { status: 'todo' },
      fieldOrder: ['status', 'assignee', 'priority'],
    });
    const lines = result.split('\n');
    expect(lines[3]).toBe('status: todo');
    expect(lines[4]).toBe('---');
  });

  it('omits fields with null or undefined values', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['task'],
      fields: { status: 'todo', removed: null, also_gone: undefined },
    });
    expect(result).not.toContain('removed');
    expect(result).not.toContain('also_gone');
  });

  it('produces no blank line when body is absent', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['note'],
      fields: {},
    });
    expect(result).toBe('---\ntitle: Test\ntypes: [note]\n---\n');
  });

  it('produces no blank line when body is empty string', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['note'],
      fields: {},
      body: '',
    });
    expect(result).toBe('---\ntitle: Test\ntypes: [note]\n---\n');
  });

  it('ends with trailing newline', () => {
    const result = serializeNode({
      title: 'Test',
      types: ['note'],
      fields: {},
      body: 'Some content',
    });
    expect(result.endsWith('\n')).toBe(true);
  });
});
