import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { checkFieldOperators } from '../../src/mcp/tools/query-nodes.js';

let db: Database.Database;

function seedGlobalFields() {
  const insert = db.prepare(
    `INSERT INTO global_fields (name, field_type, list_item_type) VALUES (?, ?, ?)`
  );
  insert.run('status', 'enum', null);
  insert.run('priority', 'number', null);
  insert.run('due', 'date', null);
  insert.run('tags', 'list', 'string');
  insert.run('project', 'list', 'reference');
  insert.run('archived', 'boolean', null);
  insert.run('assignee', 'reference', null);
}

beforeEach(() => {
  db = createTestDb();
  seedGlobalFields();
});

describe('checkFieldOperators', () => {
  it('returns no warnings for matched operators', () => {
    const w = checkFieldOperators(db, {
      status: { eq: 'open' },
      priority: { gt: 1 },
      tags: { includes: 'urgent' },
      archived: { exists: true },
    });
    expect(w).toEqual([]);
  });

  it('warns when includes is used on a scalar field', () => {
    const w = checkFieldOperators(db, { status: { includes: 'open' } });
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('FIELD_OPERATOR_MISMATCH');
    expect(w[0].severity).toBe('warning');
    expect(w[0].message).toContain('status');
    expect(w[0].message).toContain('enum');
    expect(w[0].message).toContain('includes');
  });

  it('warns when eq/ne/one_of is used on a list field', () => {
    const w = checkFieldOperators(db, {
      tags: { eq: 'urgent' },
      project: { one_of: ['A', 'B'] },
    });
    expect(w).toHaveLength(2);
    const ops = w.map(x => (x.details as { operator: string }).operator).sort();
    expect(ops).toEqual(['eq', 'one_of']);
  });

  it('warns when comparison operators are used on non-number/date fields', () => {
    const w = checkFieldOperators(db, { status: { gt: 'open' } });
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('number/date');
  });

  it('does not warn on comparison operators for date fields', () => {
    const w = checkFieldOperators(db, { due: { lt: '2026-04-20' } });
    expect(w).toEqual([]);
  });

  it('skips unknown fields silently (no warning, no error)', () => {
    const w = checkFieldOperators(db, { unknown_field: { includes: 'x' } });
    expect(w).toEqual([]);
  });

  it('does not warn on exists for any field type', () => {
    const w = checkFieldOperators(db, {
      status: { exists: false },
      tags: { exists: true },
      priority: { exists: true },
    });
    expect(w).toEqual([]);
  });

  it('does not warn on contains for any field type', () => {
    const w = checkFieldOperators(db, {
      status: { contains: 'op' },
      tags: { contains: 'urgent' },
    });
    expect(w).toEqual([]);
  });

  it('returns empty when fields is undefined or empty', () => {
    expect(checkFieldOperators(db, undefined)).toEqual([]);
    expect(checkFieldOperators(db, {})).toEqual([]);
  });
});
