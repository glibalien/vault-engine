import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/index.js';
import { resolve } from 'path';
import { serializeNode, computeFieldOrder } from '../../src/serializer/index.js';
import { parseFile } from '../../src/parser/index.js';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('serializer round-trip', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    loadSchemas(db, fixturesDir);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a task node through serialize → parse', () => {
    const fieldOrder = computeFieldOrder(['task'], db);
    const md = serializeNode({
      title: 'Review proposal',
      types: ['task'],
      fields: {
        status: 'todo',
        assignee: '[[Bob Jones]]',
        due_date: new Date('2025-03-10'),
        priority: 'high',
      },
      body: 'Review the three vendor proposals.',
      fieldOrder,
    });

    const parsed = parseFile('tasks/Review proposal.md', md);

    expect(parsed.frontmatter.title).toBe('Review proposal');
    expect(parsed.types).toEqual(['task']);
    expect(parsed.fields.find(f => f.key === 'status')?.value).toBe('todo');
    expect(parsed.fields.find(f => f.key === 'assignee')?.value).toBe('[[Bob Jones]]');
    expect(parsed.fields.find(f => f.key === 'priority')?.value).toBe('high');
    expect(parsed.contentMd).toBe('Review the three vendor proposals.');
  });

  it('round-trips a meeting node with list references', () => {
    const fieldOrder = computeFieldOrder(['meeting'], db);
    const md = serializeNode({
      title: 'Q1 Planning Meeting',
      types: ['meeting'],
      fields: {
        date: new Date('2025-03-06'),
        attendees: ['[[Alice Smith]]', '[[Bob Jones]]'],
        project: '[[CenterPoint]]',
        status: 'scheduled',
      },
      body: 'Discuss Q1 roadmap.\n\n## Action Items\n\n- [[Alice Smith]] to prepare deck',
      fieldOrder,
    });

    const parsed = parseFile('meetings/q1.md', md);

    expect(parsed.frontmatter.title).toBe('Q1 Planning Meeting');
    expect(parsed.types).toEqual(['meeting']);
    expect(parsed.fields.find(f => f.key === 'attendees')?.value).toEqual([
      '[[Alice Smith]]',
      '[[Bob Jones]]',
    ]);
    expect(parsed.fields.find(f => f.key === 'project')?.value).toBe('[[CenterPoint]]');

    // Wiki-links from body should be extracted
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    expect(bodyLinks.some(l => l.target === 'Alice Smith')).toBe(true);
  });

  it('round-trips a node with no body', () => {
    const md = serializeNode({
      title: 'Simple Note',
      types: ['note'],
      fields: {},
    });

    const parsed = parseFile('Simple Note.md', md);
    expect(parsed.frontmatter.title).toBe('Simple Note');
    expect(parsed.types).toEqual(['note']);
    expect(parsed.contentMd).toBe('');
  });

  it('round-trips a person node with tags', () => {
    const fieldOrder = computeFieldOrder(['person'], db);
    const md = serializeNode({
      title: 'Alice Smith',
      types: ['person'],
      fields: {
        role: 'Engineering Manager',
        company: 'Acme Corp',
        email: 'alice@acme.com',
        tags: ['engineering', 'leadership'],
      },
      body: 'Key contact for the [[CenterPoint]] project.',
      fieldOrder,
    });

    const parsed = parseFile('people/Alice Smith.md', md);
    expect(parsed.fields.find(f => f.key === 'role')?.value).toBe('Engineering Manager');
    expect(parsed.fields.find(f => f.key === 'tags')?.value).toEqual([
      'engineering',
      'leadership',
    ]);
  });
});
