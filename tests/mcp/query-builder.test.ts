import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { buildNodeQuery } from '../../src/mcp/query-builder.js';

let db: Database.Database;

function seedTestData() {
  const insertNode = db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertNode.run('n1', 'meetings/meeting.md', 'Team Meeting', 'Meeting body text', 'h1', 1000, 2000);
  insertNode.run('n2', 'notes/note.md', 'Quick Note', 'Note body text', 'h2', 2000, 3000);
  insertNode.run('n3', 'tasks/task.md', 'Fix Bug', 'Task body text', 'h3', 3000, 4000);

  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  insertType.run('n1', 'meeting');
  insertType.run('n1', 'note');
  insertType.run('n2', 'note');
  insertType.run('n3', 'task');

  const insertField = db.prepare(
    'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertField.run('n1', 'project', 'Vault Engine', null, null, null, 'frontmatter');
  insertField.run('n3', 'priority', null, 1, null, null, 'frontmatter');
  insertField.run('n2', 'old_field', 'leftover', null, null, null, 'orphan');
  // List fields stored as JSON arrays (e.g. list-of-enum)
  insertField.run('n1', 'context', null, null, null, '["work"]', 'frontmatter');
  insertField.run('n3', 'context', null, null, null, '["personal","work"]', 'frontmatter');
  // Enum field for ne testing
  insertField.run('n1', 'status', 'open', null, null, null, 'frontmatter');
  insertField.run('n2', 'status', 'done', null, null, null, 'frontmatter');
  insertField.run('n3', 'status', 'open', null, null, null, 'frontmatter');
  // Date fields stored as ISO strings in value_text (classifyValue treats them as strings)
  insertField.run('n1', 'scheduled', '2026-01-15', null, null, null, 'frontmatter');
  insertField.run('n2', 'scheduled', '2026-04-01', null, null, null, 'frontmatter');
  insertField.run('n3', 'scheduled', '2026-06-30', null, null, null, 'frontmatter');

  // Relationships now carry resolved_target_id (populated by the indexer and
  // backfilled on startup). Seed it directly so the incoming-references branch
  // — which joins on resolved_target_id = ? — returns rows as expected.
  const insertRel = db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)'
  );
  insertRel.run('n1', 'Quick Note', 'wiki-link', null, 'n2');
}

function runQuery(filter: Parameters<typeof buildNodeQuery>[0]) {
  const { sql, countSql, params } = buildNodeQuery(filter, db);
  const rows = db.prepare(sql).all(...params) as Array<{ id: string; file_path: string; title: string | null; body: string | null }>;
  const { total } = db.prepare(countSql).get(...params) as { total: number };
  return { rows, total };
}

beforeEach(() => {
  db = createTestDb();
  seedTestData();
});

describe('buildNodeQuery', () => {
  describe('return shape', () => {
    it('returns sql, countSql, and params', () => {
      const result = buildNodeQuery({});
      expect(result).toHaveProperty('sql');
      expect(result).toHaveProperty('countSql');
      expect(result).toHaveProperty('params');
      expect(Array.isArray(result.params)).toBe(true);
    });

    it('sql starts with SELECT DISTINCT n.id', () => {
      const { sql } = buildNodeQuery({});
      expect(sql).toMatch(/^SELECT DISTINCT n\.id/);
    });

    it('countSql starts with SELECT COUNT(DISTINCT n.id)', () => {
      const { countSql } = buildNodeQuery({});
      expect(countSql).toMatch(/^SELECT COUNT\(DISTINCT n\.id\)/);
    });

    it('sql includes n.body in select', () => {
      const { sql } = buildNodeQuery({});
      expect(sql).toContain('n.body');
    });
  });

  describe('empty filter', () => {
    it('returns all nodes', () => {
      const { rows, total } = runQuery({});
      expect(total).toBe(3);
      expect(rows).toHaveLength(3);
    });

    it('params array is empty', () => {
      const { params } = buildNodeQuery({});
      expect(params).toHaveLength(0);
    });
  });

  describe('path_prefix filter', () => {
    it('returns only nodes under the prefix', () => {
      const { rows, total } = runQuery({ path_prefix: 'meetings/' });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('returns empty when prefix matches nothing', () => {
      const { rows, total } = runQuery({ path_prefix: 'nonexistent/' });
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });

    it('uses LIKE with trailing wildcard in sql', () => {
      const { sql, params } = buildNodeQuery({ path_prefix: 'notes/' });
      expect(sql).toContain('n.file_path LIKE ?');
      expect(params).toContain('notes/%');
    });
  });

  describe('without_path_prefix filter', () => {
    it('excludes nodes under the prefix', () => {
      // n1 is under meetings/, n2 under notes/, n3 under tasks/
      const { rows, total } = runQuery({ without_path_prefix: 'meetings/' });
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n2', 'n3']);
    });

    it('combines with path_prefix', () => {
      // All nodes are under some prefix; exclude tasks/
      const { rows, total } = runQuery({ without_path_prefix: 'tasks/' });
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n1', 'n2']);
    });

    it('uses NOT LIKE in sql', () => {
      const { sql, params } = buildNodeQuery({ without_path_prefix: 'notes/' });
      expect(sql).toContain('n.file_path NOT LIKE ?');
      expect(params).toContain('notes/%');
    });
  });

  describe('path_dir filter', () => {
    it('matches root-level files with path_dir: ""', () => {
      // Add a root-level node for this test
      db.prepare(
        'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('n_root', 'root-note.md', 'Root Note', '', 'hr', 5000, 5000);

      const { rows, total } = runQuery({ path_dir: '' });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n_root');

      // Clean up
      db.prepare('DELETE FROM nodes WHERE id = ?').run('n_root');
    });

    it('matches files in a specific directory (not subdirs)', () => {
      // Add a nested node
      db.prepare(
        'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('n_deep', 'meetings/sub/deep.md', 'Deep', '', 'hd', 5000, 5000);

      const { rows, total } = runQuery({ path_dir: 'meetings' });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1'); // meetings/meeting.md, not meetings/sub/deep.md

      db.prepare('DELETE FROM nodes WHERE id = ?').run('n_deep');
    });

    it('returns empty when no files in specified dir', () => {
      const { total } = runQuery({ path_dir: 'nonexistent' });
      expect(total).toBe(0);
    });
  });

  describe('types filter', () => {
    it('returns nodes with the specified type', () => {
      const { rows, total } = runQuery({ types: ['task'] });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('intersection: returns only nodes with ALL types', () => {
      const { rows, total } = runQuery({ types: ['meeting', 'note'] });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('returns empty when no node has all specified types', () => {
      const { rows, total } = runQuery({ types: ['meeting', 'task'] });
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });
  });

  describe('without_types filter', () => {
    it('excludes nodes with the specified type', () => {
      const { rows, total } = runQuery({ without_types: ['note'] });
      // n1 has note, n2 has note — only n3 (task) remains
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('excludes multiple types', () => {
      const { rows, total } = runQuery({ without_types: ['note', 'task'] });
      // n1 has note, n2 has note, n3 has task — none remain
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });

    it('returns all nodes when without_types matches nothing', () => {
      const { rows, total } = runQuery({ without_types: ['nonexistent'] });
      expect(total).toBe(3);
    });

    it('uses NOT IN subquery in sql', () => {
      const { sql, params } = buildNodeQuery({ without_types: ['meeting'] });
      expect(sql).toContain('NOT IN');
      expect(sql).toContain('node_types');
      expect(params).toContain('meeting');
    });
  });

  describe('field equality filter', () => {
    it('returns nodes with text field eq', () => {
      const { rows, total } = runQuery({ fields: { project: { eq: 'Vault Engine' } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('returns nodes with numeric field eq', () => {
      const { rows, total } = runQuery({ fields: { priority: { eq: 1 } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('returns empty for non-matching eq', () => {
      const { rows, total } = runQuery({ fields: { project: { eq: 'Other Project' } } });
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });

    it('field exists: true returns nodes with that field', () => {
      const { rows, total } = runQuery({ fields: { project: { exists: true } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('field exists: false returns nodes WITHOUT that field', () => {
      const { rows, total } = runQuery({ fields: { project: { exists: false } } });
      // n2 and n3 don't have project field
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n2', 'n3']);
    });
  });

  describe('without_fields filter', () => {
    it('excludes nodes that have the specified field', () => {
      const { rows, total } = runQuery({ without_fields: ['project'] });
      // n1 has project — n2 and n3 remain
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n2', 'n3']);
    });

    it('excludes multiple field names', () => {
      const { rows, total } = runQuery({ without_fields: ['project', 'priority'] });
      // n1 has project, n3 has priority — only n2 remains
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n2');
    });

    it('returns all nodes when without_fields matches nothing', () => {
      const { rows, total } = runQuery({ without_fields: ['nonexistent_field'] });
      expect(total).toBe(3);
    });

    it('uses NOT IN subquery in sql', () => {
      const { sql, params } = buildNodeQuery({ without_fields: ['project'] });
      expect(sql).toContain('NOT IN');
      expect(sql).toContain('node_fields');
      expect(params).toContain('project');
    });
  });

  describe('ne operator', () => {
    it('excludes nodes where text field equals the value', () => {
      const { rows, total } = runQuery({ fields: { status: { ne: 'done' } } });
      // n1=open, n2=done, n3=open — ne 'done' should return n1 and n3
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n1', 'n3']);
    });

    it('excludes nodes where numeric field equals the value', () => {
      const { rows, total } = runQuery({ fields: { priority: { ne: 999 } } });
      // Only n3 has priority (=1), and 1 != 999
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('returns empty when all matching nodes equal the ne value', () => {
      const { rows, total } = runQuery({ fields: { priority: { ne: 1 } } });
      // n3 has priority=1, ne 1 excludes it; no other nodes have priority
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });
  });

  describe('includes operator (JSON array membership)', () => {
    it('returns nodes whose list field contains the value', () => {
      const { rows, total } = runQuery({ fields: { context: { includes: 'personal' } } });
      // n1=["work"], n3=["personal","work"] — only n3 includes "personal"
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('returns multiple nodes when value appears in multiple lists', () => {
      const { rows, total } = runQuery({ fields: { context: { includes: 'work' } } });
      // n1=["work"], n3=["personal","work"] — both include "work"
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n1', 'n3']);
    });

    it('returns empty when no list contains the value', () => {
      const { rows, total } = runQuery({ fields: { context: { includes: 'nonexistent' } } });
      expect(total).toBe(0);
      expect(rows).toHaveLength(0);
    });
  });

  describe('contains operator on list fields', () => {
    it('matches inside JSON array values', () => {
      const { rows, total } = runQuery({ fields: { context: { contains: 'work' } } });
      // Both n1 (["work"]) and n3 (["personal","work"]) have "work" in their JSON
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n1', 'n3']);
    });

    it('still works on scalar text fields', () => {
      const { rows, total } = runQuery({ fields: { project: { contains: 'Vault' } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });
  });

  describe('date comparison operators', () => {
    it('lte returns nodes with date on or before the threshold', () => {
      // n1=2026-01-15, n2=2026-04-01, n3=2026-06-30
      const { rows, total } = runQuery({ fields: { scheduled: { lte: '2026-04-01' } } });
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n1', 'n2']);
    });

    it('gte returns nodes with date on or after the threshold', () => {
      const { rows, total } = runQuery({ fields: { scheduled: { gte: '2026-04-01' } } });
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n2', 'n3']);
    });

    it('gt returns nodes with date strictly after the threshold', () => {
      const { rows, total } = runQuery({ fields: { scheduled: { gt: '2026-04-01' } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('lt returns nodes with date strictly before the threshold', () => {
      const { rows, total } = runQuery({ fields: { scheduled: { lt: '2026-04-01' } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('date range with gte + lte combined on same field', () => {
      const { rows, total } = runQuery({
        fields: { scheduled: { gte: '2026-02-01', lte: '2026-05-01' } },
      });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n2');
    });

    it('eq on date string matches via value_text', () => {
      const { rows, total } = runQuery({ fields: { scheduled: { eq: '2026-04-01' } } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n2');
    });
  });

  describe('multi-field filters (param ordering)', () => {
    it('includes + eq across two fields returns correct results', () => {
      // n1: context=["work"], status=open
      // n3: context=["personal","work"], status=open
      // n2: status=done (no context)
      const { rows, total } = runQuery({
        fields: { context: { includes: 'work' }, status: { eq: 'open' } },
      });
      expect(total).toBe(2);
      const ids = rows.map(r => r.id).sort();
      expect(ids).toEqual(['n1', 'n3']);
    });

    it('includes narrowing on specific value + eq', () => {
      const { rows, total } = runQuery({
        fields: { context: { includes: 'personal' }, status: { eq: 'open' } },
      });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('ne + eq across two fields', () => {
      // status ne "done" (n1=open, n3=open) + priority exists with eq 1 (n3)
      const { rows, total } = runQuery({
        fields: { status: { ne: 'done' }, priority: { eq: 1 } },
      });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });

    it('contains on list + eq on scalar', () => {
      const { rows, total } = runQuery({
        fields: { context: { contains: 'personal' }, status: { eq: 'open' } },
      });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n3');
    });
  });

  describe('combined filters', () => {
    it('types + path_prefix narrows correctly', () => {
      // n1 is in meetings/ and has type meeting
      const { rows, total } = runQuery({ types: ['meeting'], path_prefix: 'meetings/' });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('types + without_types is handled (redundant but valid)', () => {
      // ask for note type but exclude note — should return 0
      const { rows, total } = runQuery({ types: ['note'], without_types: ['note'] });
      expect(total).toBe(0);
    });

    it('without_types + without_fields', () => {
      // Exclude note type (removes n1, n2), exclude priority field (removes n3) — nothing left
      const { rows, total } = runQuery({ without_types: ['note'], without_fields: ['priority'] });
      expect(total).toBe(0);
    });

    it('path_prefix + without_fields', () => {
      // notes/ prefix → n2. n2 has old_field, not project. without_fields: [old_field] removes n2.
      const { rows, total } = runQuery({ path_prefix: 'notes/', without_fields: ['old_field'] });
      expect(total).toBe(0);
    });
  });

  describe('modified_since filter', () => {
    it('returns nodes modified at or after the timestamp', () => {
      // n1 mtime=1000, n2 mtime=2000, n3 mtime=3000 (unix seconds)
      // modified_since is parsed as a date string; use a far-past date to get all
      const { rows, total } = runQuery({ modified_since: '1970-01-01' });
      expect(total).toBe(3);
    });

    it('uses >= comparison in sql', () => {
      const { sql } = buildNodeQuery({ modified_since: '2020-01-01' });
      expect(sql).toContain('n.file_mtime >= ?');
    });
  });

  describe('references filter - outgoing', () => {
    it('returns nodes that link outgoing to target', () => {
      // n1 links to 'Quick Note' (n2)
      const { rows, total } = runQuery({ references: { target: 'Quick Note', direction: 'outgoing' } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('returns empty when no node links to target', () => {
      const { rows, total } = runQuery({ references: { target: 'Nonexistent', direction: 'outgoing' } });
      expect(total).toBe(0);
    });
  });

  describe('references filter - incoming', () => {
    it('returns nodes that are linked to (incoming) from others', () => {
      // n2 (Quick Note) is linked to by n1
      const { rows, total } = runQuery({ references: { target: 'Quick Note', direction: 'incoming' } });
      expect(total).toBe(1);
      expect(rows[0].id).toBe('n1');
    });

    it('returns empty when target does not resolve', () => {
      const { rows, total } = runQuery({ references: { target: 'Ghost Node', direction: 'incoming' } });
      expect(total).toBe(0);
    });

    it('throws when db is not provided for incoming direction', () => {
      expect(() => buildNodeQuery({ references: { target: 'x', direction: 'incoming' } })).toThrow();
    });
  });
});
