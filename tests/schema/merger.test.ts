import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { createSchema } from '../../src/db/schema.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { mergeSchemaFields } from '../../src/schema/merger.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

describe('mergeSchemaFields', () => {
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

  it('returns empty result for empty types array', () => {
    const result = mergeSchemaFields(db, []);
    expect(result.fields).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it('wraps single type fields as MergedFields', () => {
    const result = mergeSchemaFields(db, ['person']);
    expect(result.conflicts).toEqual([]);
    expect(result.fields.role).toEqual({
      type: 'string',
      sources: ['person'],
    });
    expect(result.fields.email).toEqual({
      type: 'string',
      sources: ['person'],
    });
    expect(result.fields.tags).toEqual({
      type: 'list<string>',
      sources: ['person'],
    });
  });

  it('preserves required and default on single type', () => {
    const result = mergeSchemaFields(db, ['task']);
    expect(result.fields.status.required).toBe(true);
    expect(result.fields.status.default).toBe('todo');
    expect(result.fields.status.values).toEqual(
      ['todo', 'in-progress', 'blocked', 'done', 'cancelled']
    );
    expect(result.fields.status.sources).toEqual(['task']);
  });

  it('merges compatible enum fields by unioning values', () => {
    // meeting.status: enum [scheduled, completed, cancelled]
    // task.status: enum [todo, in-progress, blocked, done, cancelled]
    const result = mergeSchemaFields(db, ['meeting', 'task']);

    expect(result.fields.status.type).toBe('enum');
    expect(result.fields.status.sources).toEqual(['meeting', 'task']);
    // Union of both value sets, deduplicated
    expect(result.fields.status.values).toContain('scheduled');
    expect(result.fields.status.values).toContain('completed');
    expect(result.fields.status.values).toContain('todo');
    expect(result.fields.status.values).toContain('in-progress');
    expect(result.fields.status.values).toContain('blocked');
    expect(result.fields.status.values).toContain('done');
    // 'cancelled' appears in both — only once
    expect(
      result.fields.status.values!.filter(v => v === 'cancelled')
    ).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
  });

  it('merges required as OR — required if any schema says required', () => {
    // meeting.status: not required (no required field)
    // task.status: required: true
    const result = mergeSchemaFields(db, ['meeting', 'task']);
    expect(result.fields.status.required).toBe(true);
  });

  it('uses first alphabetical schema default for compatible fields', () => {
    // meeting (alphabetically first) has status default: 'scheduled'
    // task has status default: 'todo'
    const result = mergeSchemaFields(db, ['meeting', 'task']);
    expect(result.fields.status.default).toBe('scheduled');
  });

  it('merges disjoint fields from multiple types', () => {
    // meeting has: date, attendees, project, status
    // task has: status, assignee, due_date, priority
    const result = mergeSchemaFields(db, ['meeting', 'task']);

    // meeting-only fields
    expect(result.fields.date).toBeDefined();
    expect(result.fields.date.sources).toEqual(['meeting']);
    expect(result.fields.attendees).toBeDefined();

    // task-only fields
    expect(result.fields.assignee).toBeDefined();
    expect(result.fields.assignee.sources).toEqual(['task']);
    expect(result.fields.due_date).toBeDefined();
    expect(result.fields.priority).toBeDefined();

    // shared field
    expect(result.fields.status.sources).toEqual(['meeting', 'task']);
  });

  it('merges reference fields with same target_schema', () => {
    // meeting and work-task both have project → reference → project
    const result = mergeSchemaFields(db, ['meeting', 'work-task']);
    expect(result.fields.project.type).toBe('reference');
    expect(result.fields.project.target_schema).toBe('project');
    expect(result.fields.project.sources).toEqual(['meeting', 'work-task']);
    // No conflict
    const projectConflicts = result.conflicts.filter(c => c.field === 'project');
    expect(projectConflicts).toEqual([]);
  });
});

describe('mergeSchemaFields conflicts', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-merge-'));
    mkdirSync(join(tmpDir, '.schemas'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports conflict for same field name with different types', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  status:
    type: string
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  status:
    type: number
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['alpha', 'beta']);
    expect(result.fields.status).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('status');
    expect(result.conflicts[0].definitions).toEqual([
      { schema: 'alpha', type: 'string' },
      { schema: 'beta', type: 'number' },
    ]);
    expect(result.conflicts[0].message).toContain('incompatible types');
  });

  it('reports conflict for reference fields with different target_schema', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  owner:
    type: reference
    target_schema: person
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  owner:
    type: reference
    target_schema: project
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['alpha', 'beta']);
    expect(result.fields.owner).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('owner');
    expect(result.conflicts[0].message).toContain('target_schema');
  });

  it('reports unknown schema type in conflicts', () => {
    const result = mergeSchemaFields(db, ['nonexistent']);
    expect(result.fields).toEqual({});
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain("Unknown schema type 'nonexistent'");
  });

  it('merges known types and reports unknown ones', () => {
    writeFileSync(join(tmpDir, '.schemas', 'real.yaml'), `
name: real
fields:
  x:
    type: string
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['real', 'fake']);
    expect(result.fields.x).toBeDefined();
    expect(result.fields.x.sources).toEqual(['real']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain("Unknown schema type 'fake'");
  });

  it('non-conflicting fields survive alongside a conflicting field', () => {
    writeFileSync(join(tmpDir, '.schemas', 'alpha.yaml'), `
name: alpha
fields:
  shared:
    type: string
  unique_a:
    type: number
`);
    writeFileSync(join(tmpDir, '.schemas', 'beta.yaml'), `
name: beta
fields:
  shared:
    type: boolean
  unique_b:
    type: date
`);
    loadSchemas(db, tmpDir);

    const result = mergeSchemaFields(db, ['alpha', 'beta']);
    // Conflicting field removed
    expect(result.fields.shared).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    // Non-conflicting fields preserved
    expect(result.fields.unique_a).toBeDefined();
    expect(result.fields.unique_b).toBeDefined();
  });
});
