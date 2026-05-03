import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { StaleNodeError } from '../../src/pipeline/execute.js';
import { buildStaleNodeEnvelope } from '../../src/mcp/tools/stale-helpers.js';

function setupDbWithNode(): { db: Database.Database; nodeId: string } {
  const db = new Database(':memory:');
  db.prepare(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL,
      title TEXT, body TEXT, content_hash TEXT,
      file_mtime INTEGER, indexed_at INTEGER, created_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1
    )
  `).run();
  db.prepare('CREATE TABLE node_types (node_id TEXT, schema_type TEXT)').run();
  db.prepare(`
    CREATE TABLE node_fields (
      node_id TEXT, field_name TEXT, value_text TEXT,
      value_number REAL, value_date TEXT, value_json TEXT, source TEXT
    )
  `).run();
  db.prepare('INSERT INTO nodes (id, file_path, title, body, version) VALUES (?, ?, ?, ?, ?)')
    .run('abc', 'abc.md', 'My Node', 'body text', 8);
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('abc', 'note');
  return { db, nodeId: 'abc' };
}

describe('buildStaleNodeEnvelope', () => {
  it('returns a STALE_NODE error envelope with current_node populated', () => {
    const { db } = setupDbWithNode();
    const err = new StaleNodeError('abc', 7, 8);
    const result = buildStaleNodeEnvelope(db, err);
    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('STALE_NODE');
    expect(parsed.error.details.current_version).toBe(8);
    expect(parsed.error.details.expected_version).toBe(7);
    expect(parsed.error.details.current_node).toMatchObject({
      id: 'abc',
      title: 'My Node',
      version: 8,
      types: ['note'],
    });
    db.close();
  });

  it('omits current_node when the node no longer exists', () => {
    const { db } = setupDbWithNode();
    db.prepare('DELETE FROM nodes WHERE id = ?').run('abc');
    const err = new StaleNodeError('abc', 7, 8);
    const result = buildStaleNodeEnvelope(db, err);
    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(parsed.error.code).toBe('STALE_NODE');
    expect(parsed.error.details.current_node).toBeUndefined();
    db.close();
  });
});
