import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { inferFieldType } from '../../src/discovery/infer-field-type.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ── helpers ──────────────────────────────────────────────────────────

function insertNode(id: string): void {
  db.prepare(
    `INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`,
  ).run(id, `/${id}.md`, id);
}

function insertNumberField(nodeId: string, fieldName: string, value: number): void {
  db.prepare(
    `INSERT INTO node_fields (node_id, field_name, value_number) VALUES (?, ?, ?)`,
  ).run(nodeId, fieldName, value);
}

function insertTextField(nodeId: string, fieldName: string, value: string): void {
  db.prepare(
    `INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)`,
  ).run(nodeId, fieldName, value);
}

// ── tests ─────────────────────────────────────────────────────────────

describe('inferFieldType', () => {
  it('infers number with high confidence when all values are numeric', () => {
    for (let i = 1; i <= 10; i++) {
      insertNode(`n${i}`);
      insertNumberField(`n${i}`, 'priority', i);
    }

    const result = inferFieldType(db, 'priority');

    expect(result.proposed_type).toBe('number');
    expect(result.confidence).toBeCloseTo(1.0);
    expect(result.evidence.type_distribution['number']).toBe(10);
    expect(result.evidence.dissenters).toHaveLength(0);
    expect(result.evidence.sample_values.length).toBeGreaterThan(0);
    expect(result.evidence.sample_values.length).toBeLessThanOrEqual(10);
  });

  it('infers string for varied text values', () => {
    const values = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
    for (let i = 1; i <= 10; i++) {
      insertNode(`n${i}`);
      insertTextField(`n${i}`, 'label', values[i - 1]);
    }

    const result = inferFieldType(db, 'label');

    expect(result.proposed_type).toBe('string');
    expect(result.confidence).toBeCloseTo(1.0);
    expect(result.evidence.type_distribution['string']).toBe(10);
    expect(result.evidence.distinct_values).toBe(10);
  });

  it('suggests enum for few distinct string values across many nodes', () => {
    // 10 nodes, 3 distinct statuses → distinct/total = 0.3, with 10 total ≥ 5
    const statuses = ['open', 'closed', 'in-progress'];
    for (let i = 1; i <= 10; i++) {
      insertNode(`n${i}`);
      insertTextField(`n${i}`, 'status', statuses[(i - 1) % 3]);
    }

    const result = inferFieldType(db, 'status');

    expect(result.proposed_type).toBe('enum');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.evidence.distinct_values).toBe(3);
  });

  it('returns empty result for nonexistent field', () => {
    const result = inferFieldType(db, 'no_such_field');

    expect(result.confidence).toBe(0);
    expect(result.proposed_type).toBe('string');
    expect(result.evidence.distinct_values).toBe(0);
    expect(result.evidence.sample_values).toHaveLength(0);
    expect(result.evidence.type_distribution).toEqual({});
    expect(result.evidence.dissenters).toHaveLength(0);
  });
});
