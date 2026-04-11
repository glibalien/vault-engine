import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { listFieldValues } from '../../src/discovery/list-field-values.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ── helpers ──────────────────────────────────────────────────────────

function insertNode(id: string, type?: string): void {
  db.prepare(
    `INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`,
  ).run(id, `/${id}.md`, id);
  if (type) {
    db.prepare(
      `INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)`,
    ).run(id, type);
  }
}

function insertTextField(nodeId: string, fieldName: string, value: string): void {
  db.prepare(
    `INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)`,
  ).run(nodeId, fieldName, value);
}

function insertNumberField(nodeId: string, fieldName: string, value: number): void {
  db.prepare(
    `INSERT INTO node_fields (node_id, field_name, value_number) VALUES (?, ?, ?)`,
  ).run(nodeId, fieldName, value);
}

// ── tests ─────────────────────────────────────────────────────────────

describe('listFieldValues', () => {
  it('returns distinct values with counts sorted by count DESC', () => {
    insertNode('n1');
    insertNode('n2');
    insertNode('n3');
    insertTextField('n1', 'status', 'open');
    insertTextField('n2', 'status', 'open');
    insertTextField('n3', 'status', 'closed');

    const result = listFieldValues(db, 'status');

    expect(result.total_nodes).toBe(3);
    expect(result.total_distinct).toBe(2);
    expect(result.values).toHaveLength(2);
    expect(result.values[0]).toEqual({ value: 'open', count: 2 });
    expect(result.values[1]).toEqual({ value: 'closed', count: 1 });
  });

  it('filters by type when types option is provided', () => {
    insertNode('n1', 'Task');
    insertNode('n2', 'Task');
    insertNode('n3', 'Project');
    insertTextField('n1', 'status', 'open');
    insertTextField('n2', 'status', 'closed');
    insertTextField('n3', 'status', 'open');

    const result = listFieldValues(db, 'status', { types: ['Task'] });

    expect(result.total_nodes).toBe(2);
    expect(result.total_distinct).toBe(2);
    // only n1 and n2 (both Tasks) should be counted
    const openEntry = result.values.find(v => v.value === 'open');
    const closedEntry = result.values.find(v => v.value === 'closed');
    expect(openEntry?.count).toBe(1);
    expect(closedEntry?.count).toBe(1);
  });

  it('respects the limit option', () => {
    insertNode('n1');
    insertNode('n2');
    insertNode('n3');
    insertTextField('n1', 'tag', 'alpha');
    insertTextField('n2', 'tag', 'beta');
    insertTextField('n3', 'tag', 'gamma');

    const result = listFieldValues(db, 'tag', { limit: 2 });

    expect(result.values).toHaveLength(2);
    expect(result.total_distinct).toBe(3);
  });

  it('returns empty result for nonexistent field', () => {
    const result = listFieldValues(db, 'does_not_exist');

    expect(result.total_nodes).toBe(0);
    expect(result.total_distinct).toBe(0);
    expect(result.values).toHaveLength(0);
  });

  it('handles number values', () => {
    insertNode('n1');
    insertNode('n2');
    insertNode('n3');
    insertNumberField('n1', 'priority', 1);
    insertNumberField('n2', 'priority', 2);
    insertNumberField('n3', 'priority', 1);

    const result = listFieldValues(db, 'priority');

    expect(result.total_nodes).toBe(3);
    expect(result.total_distinct).toBe(2);
    expect(result.values[0]).toEqual({ value: 1, count: 2 });
    expect(result.values[1]).toEqual({ value: 2, count: 1 });
  });
});
