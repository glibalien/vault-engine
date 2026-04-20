import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { performExpansion, type ExpandOptions } from '../../src/mcp/expand.js';

let db: Database.Database;

function seedNode(id: string, filePath: string, title: string, body: string, mtime = 1000) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, mtime, 2000);
}

beforeEach(() => {
  db = createTestDb();
});

describe('performExpansion — skeleton', () => {
  it('returns empty result for a root with no relationships', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    const options: ExpandOptions = { types: ['note'], direction: 'outgoing', max_nodes: 10 };
    const result = performExpansion(db, 'root', options);
    expect(result.expanded).toEqual({});
    expect(result.stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});
