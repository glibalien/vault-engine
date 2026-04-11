import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createGlobalField, renameGlobalField, updateGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, deleteSchemaDefinition } from '../../src/schema/crud.js';
import { getNodeConformance } from '../../src/validation/conformance.js';

describe('full lifecycle end-to-end', () => {
  it('exercises global fields, schemas, conformance, rename, type change, and delete', () => {
    const db: Database.Database = createTestDb();

    // ── Step 1: Insert 2 task nodes with status and priority fields ────
    const insertNode = db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertNode.run('n1', 'tasks/task1.md', 'Task One', 'Body 1', 'h1', 1000, 2000);
    insertNode.run('n2', 'tasks/task2.md', 'Task Two', 'Body 2', 'h2', 1000, 2000);

    const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
    insertType.run('n1', 'task');
    insertType.run('n2', 'task');

    const insertField = db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertField.run('n1', 'status', 'open', null, null, null, 'frontmatter');
    insertField.run('n1', 'priority', '5', null, null, null, 'frontmatter');
    insertField.run('n2', 'status', 'closed', null, null, null, 'frontmatter');
    insertField.run('n2', 'priority', 'high', null, null, null, 'frontmatter');

    // ── Step 2: Create global fields ──────────────────────────────────
    createGlobalField(db, {
      name: 'status',
      field_type: 'enum',
      enum_values: ['open', 'closed', 'in-progress'],
    });
    createGlobalField(db, {
      name: 'priority',
      field_type: 'string',
    });

    // ── Step 3: Create schema for task with claims on both ────────────
    createSchemaDefinition(db, {
      name: 'task',
      display_name: 'Task',
      field_claims: [
        { field: 'status', sort_order: 1 },
        { field: 'priority', sort_order: 2 },
      ],
    });

    // ── Step 4: getNodeConformance ────────────────────────────────────
    const conformance = getNodeConformance(db, 'n1', ['task']);
    expect(conformance.types_with_schemas).toContain('task');
    const claimedNames = conformance.claimed_fields.map(f => f.field);
    expect(claimedNames).toContain('status');
    expect(claimedNames).toContain('priority');
    expect(conformance.orphan_fields).toHaveLength(0);
    expect(conformance.unfilled_claims).toHaveLength(0);

    // ── Step 5: renameGlobalField ─────────────────────────────────────
    const renameResult = renameGlobalField(db, 'status', 'state');
    expect(renameResult.affected_nodes).toBe(2);
    expect(renameResult.affected_schemas).toBe(1);

    // Verify propagation: node_fields updated
    const fieldRow = db.prepare(
      'SELECT field_name FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get('n1', 'state') as { field_name: string } | undefined;
    expect(fieldRow).toBeDefined();
    expect(fieldRow!.field_name).toBe('state');

    // Verify propagation: schema_field_claims updated
    const claimRow = db.prepare(
      'SELECT field FROM schema_field_claims WHERE schema_name = ? AND field = ?'
    ).get('task', 'state') as { field: string } | undefined;
    expect(claimRow).toBeDefined();

    // Old name should be gone
    const oldClaim = db.prepare(
      'SELECT field FROM schema_field_claims WHERE schema_name = ? AND field = ?'
    ).get('task', 'status') as { field: string } | undefined;
    expect(oldClaim).toBeUndefined();

    // ── Step 6: updateGlobalField type change preview ─────────────────
    // priority is currently 'string'. n1 has '5' (coercible to number), n2 has 'high' (not coercible)
    const preview = updateGlobalField(db, 'priority', {
      field_type: 'number',
    });

    expect(preview.preview).toBe(true);
    expect(preview.affected_nodes).toBe(2);
    expect(preview.coercible).toHaveLength(1);
    expect(preview.coercible![0].node_id).toBe('n1');
    expect(preview.coercible![0].new_value).toBe(5);
    expect(preview.uncoercible).toHaveLength(1);
    expect(preview.uncoercible![0].node_id).toBe('n2');

    // ── Step 7: updateGlobalField type change with confirm ────────────
    const applied = updateGlobalField(db, 'priority', {
      field_type: 'number',
      confirm: true,
    });

    expect(applied.preview).toBe(false);
    expect(applied.applied).toBe(true);

    // n1's priority should now be stored as number
    const n1Priority = db.prepare(
      'SELECT value_number, value_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get('n1', 'priority') as { value_number: number | null; value_text: string | null };
    expect(n1Priority.value_number).toBe(5);
    expect(n1Priority.value_text).toBeNull();

    // n2's priority should be removed (uncoercible 'high' can't satisfy number type)
    const n2Priority = db.prepare(
      'SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get('n2', 'priority');
    expect(n2Priority).toBeUndefined();

    // ── Step 8: deleteSchemaDefinition ─────────────────────────────────
    const deleteResult = deleteSchemaDefinition(db, 'task');
    expect(deleteResult.affected_nodes).toBe(2);

    // node_types should be untouched
    const typeRows = db.prepare('SELECT * FROM node_types WHERE schema_type = ?').all('task');
    expect(typeRows).toHaveLength(2);

    // Conformance should now show all fields as orphans
    const postDelete = getNodeConformance(db, 'n1', ['task']);
    expect(postDelete.types_with_schemas).toHaveLength(0);
    expect(postDelete.types_without_schemas).toContain('task');
    expect(postDelete.claimed_fields).toHaveLength(0);
    // Both 'state' and 'priority' are now orphans
    expect(postDelete.orphan_fields).toContain('state');
    expect(postDelete.orphan_fields).toContain('priority');
  });
});
