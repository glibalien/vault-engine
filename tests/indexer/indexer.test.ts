import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, utimesSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex, indexFile, deleteNodeByPath, sha256, shouldIgnore, setExcludeDirs } from '../../src/indexer/index.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
  cleanup();
});

// ── sha256 ──────────────────────────────────────────────────────────

describe('sha256', () => {
  it('produces a 64-char hex string', () => {
    const hash = sha256('hello');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });
});

// ── shouldIgnore ────────────────────────────────────────────────────

describe('shouldIgnore', () => {
  it('allows normal .md files', () => {
    expect(shouldIgnore('note.md')).toBe(false);
    expect(shouldIgnore('folder/note.md')).toBe(false);
  });

  it('ignores non-.md files', () => {
    expect(shouldIgnore('image.png')).toBe(true);
    expect(shouldIgnore('data.json')).toBe(true);
  });

  it('ignores dotfiles and dot-directories', () => {
    expect(shouldIgnore('.hidden.md')).toBe(true);
    expect(shouldIgnore('.obsidian/config.md')).toBe(true);
  });

  it('ignores .sync-conflict files', () => {
    expect(shouldIgnore('.sync-conflict-20260410.md')).toBe(true);
  });

  it('ignores known directories', () => {
    expect(shouldIgnore('.vault-engine/cache.md')).toBe(true);
    expect(shouldIgnore('node_modules/pkg/readme.md')).toBe(true);
    expect(shouldIgnore('.git/hooks/readme.md')).toBe(true);
  });

  it('ignores custom excluded directories', () => {
    setExcludeDirs(['Templates', 'Archive/Old']);
    try {
      expect(shouldIgnore('Templates/Meeting Template.md')).toBe(true);
      expect(shouldIgnore('Templates/sub/nested.md')).toBe(true);
      expect(shouldIgnore('Archive/Old/legacy.md')).toBe(true);
      // Non-excluded paths still allowed
      expect(shouldIgnore('Archive/New/note.md')).toBe(false);
      expect(shouldIgnore('Notes/note.md')).toBe(false);
      // Segment-based: "Templates" shouldn't match "MyTemplates"
      expect(shouldIgnore('MyTemplates/file.md')).toBe(false);
    } finally {
      setExcludeDirs([]);
    }
  });
});

// ── fullIndex ───────────────────────────────────────────────────────

describe('fullIndex', () => {
  it('indexes all 13 fixture files', () => {
    const stats = fullIndex(vaultPath, db);
    expect(stats.indexed).toBe(13);
    expect(stats.errors).toBe(0);

    const count = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(count.c).toBe(13);
  });

  it('preserves node IDs on re-index', () => {
    fullIndex(vaultPath, db);
    const idsBefore = (db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as { id: string; file_path: string }[]);

    // Touch all files to force mtime change, then re-index
    for (const row of idsBefore) {
      const absPath = join(vaultPath, row.file_path);
      const future = new Date(Date.now() + 5000);
      utimesSync(absPath, future, future);
    }

    fullIndex(vaultPath, db);
    const idsAfter = (db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as { id: string; file_path: string }[]);

    expect(idsAfter.length).toBe(idsBefore.length);
    for (let i = 0; i < idsBefore.length; i++) {
      expect(idsAfter[i].id).toBe(idsBefore[i].id);
      expect(idsAfter[i].file_path).toBe(idsBefore[i].file_path);
    }
  });

  it('stores types in node_types', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type').all(node.id) as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['meeting', 'note']);
  });

  it('stores string fields in value_text', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'frontmatter-wikilinks.md'").get() as { id: string };
    const field = db.prepare("SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = 'company'").get(node.id) as { value_text: string };
    expect(field.value_text).toBe('Acme Corp');
  });

  it('stores numeric fields in value_number', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const field = db.prepare("SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = 'priority'").get(node.id) as { value_number: number };
    expect(field.value_number).toBe(1);
  });

  it('stores relationships with correct rel_types', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ? ORDER BY target').all(node.id) as { target: string; rel_type: string }[];
    expect(rels.length).toBeGreaterThan(0);

    // Body wiki-link to SQLite should have rel_type 'wiki-link'
    const sqliteRel = rels.find(r => r.target === 'SQLite');
    expect(sqliteRel).toBeDefined();
    expect(sqliteRel!.rel_type).toBe('wiki-link');
  });

  it('stores frontmatter references with field name as rel_type', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };
    const rels = db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ?').all(node.id) as { target: string; rel_type: string }[];

    // project field link → rel_type should be 'project'
    const projectRel = rels.find(r => r.target === 'Vault Engine');
    expect(projectRel).toBeDefined();
    expect(projectRel!.rel_type).toBe('project');
  });

  it('detects deleted files on re-index', () => {
    fullIndex(vaultPath, db);
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(countBefore).toBe(13);

    // Delete a file from disk
    unlinkSync(join(vaultPath, 'plain-no-frontmatter.md'));

    const stats = fullIndex(vaultPath, db);
    expect(stats.deleted).toBe(1);

    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(countAfter).toBe(12);
  });

  it('skips unchanged files on re-index', () => {
    fullIndex(vaultPath, db);

    const nodesBefore = db.prepare('SELECT id, indexed_at FROM nodes ORDER BY id').all() as { id: string; indexed_at: number }[];

    // Re-index without changes — all should be skipped (same mtime)
    const stats = fullIndex(vaultPath, db);
    expect(stats.skipped).toBe(13);
    expect(stats.indexed).toBe(0);

    const nodesAfter = db.prepare('SELECT id, indexed_at FROM nodes ORDER BY id').all() as { id: string; indexed_at: number }[];
    for (let i = 0; i < nodesBefore.length; i++) {
      expect(nodesAfter[i].indexed_at).toBe(nodesBefore[i].indexed_at);
    }
  });

  it('writes edits_log entries for file-indexed events', () => {
    fullIndex(vaultPath, db);
    const logs = db.prepare("SELECT COUNT(*) as c FROM edits_log WHERE event_type = 'file-indexed'").get() as { c: number };
    expect(logs.c).toBe(13);
  });

  it('populates FTS5 index', () => {
    fullIndex(vaultPath, db);
    // Search for a term we know exists in multi-type.md body
    const results = db.prepare("SELECT COUNT(*) as c FROM nodes_fts WHERE nodes_fts MATCH 'SQLite'").get() as { c: number };
    expect(results.c).toBeGreaterThan(0);
  });

  it('populates value_raw_text for fields containing wiki-links', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'frontmatter-wikilinks.md'").get() as { id: string };

    // project: "[[Vault Engine]]" — single string with wiki-link
    const projectField = db.prepare(
      'SELECT value_text, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get(node.id, 'project') as { value_text: string; value_raw_text: string | null };
    expect(projectField.value_text).toBe('Vault Engine'); // stripped
    expect(projectField.value_raw_text).toBe('[[Vault Engine]]');

    // people: ["[[Alice]]", "[[Bob]]"] — array with wiki-links
    const peopleField = db.prepare(
      'SELECT value_json, value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get(node.id, 'people') as { value_json: string; value_raw_text: string | null };
    expect(JSON.parse(peopleField.value_json)).toEqual(['Alice', 'Bob']); // stripped
    expect(peopleField.value_raw_text).not.toBeNull();
    const rawPeople = JSON.parse(peopleField.value_raw_text!);
    expect(rawPeople).toEqual(['[[Alice]]', '[[Bob]]']);
  });

  it('value_raw_text is null for fields without wiki-links', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'multi-type.md'").get() as { id: string };

    // status should be a plain string without wiki-links
    const field = db.prepare(
      'SELECT value_raw_text FROM node_fields WHERE node_id = ? AND field_name = ?'
    ).get(node.id, 'status') as { value_raw_text: string | null } | undefined;
    if (field) {
      expect(field.value_raw_text).toBeNull();
    }
  });

  it('handles malformed YAML without crashing', () => {
    fullIndex(vaultPath, db);
    const node = db.prepare("SELECT title FROM nodes WHERE file_path = 'malformed-yaml.md'").get() as { title: string };
    // Should fall back to filename-based title
    expect(node.title).toBe('malformed-yaml');
  });
});

// ── indexFile ────────────────────────────────────────────────────────

describe('indexFile', () => {
  it('indexes a single file', () => {
    const absPath = join(vaultPath, 'multi-type.md');
    const nodeId = indexFile(absPath, vaultPath, db);
    expect(nodeId).toBeTruthy();
    expect(typeof nodeId).toBe('string');

    const count = db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('re-indexes preserving ID', () => {
    const absPath = join(vaultPath, 'multi-type.md');
    const id1 = indexFile(absPath, vaultPath, db);

    // Modify the file and re-index
    writeFileSync(absPath, '---\ntitle: Updated\ntypes:\n  - meeting\n---\nNew body.\n', 'utf-8');
    const id2 = indexFile(absPath, vaultPath, db);

    expect(id2).toBe(id1);

    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(id1) as { title: string };
    expect(node.title).toBe('multi-type');
  });
});

// ── deleteNodeByPath ────────────────────────────────────────────────

describe('deleteNodeByPath', () => {
  it('removes a node and its cascade data', () => {
    fullIndex(vaultPath, db);
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;

    const deleted = deleteNodeByPath('multi-type.md', db);
    expect(deleted).toBe(true);

    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    expect(countAfter).toBe(countBefore - 1);

    // Types should be gone too
    const types = db.prepare("SELECT COUNT(*) as c FROM node_types WHERE node_id IN (SELECT id FROM nodes WHERE file_path = 'multi-type.md')").get() as { c: number };
    expect(types.c).toBe(0);
  });

  it('returns false for non-existent path', () => {
    expect(deleteNodeByPath('does-not-exist.md', db)).toBe(false);
  });

  it('logs file-deleted event', () => {
    fullIndex(vaultPath, db);
    deleteNodeByPath('multi-type.md', db);
    const logs = db.prepare("SELECT COUNT(*) as c FROM edits_log WHERE event_type = 'file-deleted'").get() as { c: number };
    expect(logs.c).toBeGreaterThanOrEqual(1);
  });
});
