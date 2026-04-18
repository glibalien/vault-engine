import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';

let vault: string;
let db: Database.Database;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'rel-resolve-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

describe('indexer populates resolved_target_id at insert', () => {
  it('sets resolved_target_id when a target resolves, leaves NULL when it does not', async () => {
    writeFileSync(join(vault, 'Writer.md'), '# Writer\n\nLinks to [[Acme Corp]] and [[Nonexistent]].\n');
    writeFileSync(join(vault, 'Acme Corp.md'), '# Acme Corp\n');
    await fullIndex(vault, db);

    const rels = db.prepare(
      'SELECT target, resolved_target_id FROM relationships WHERE source_id = (SELECT id FROM nodes WHERE file_path = ?)'
    ).all('Writer.md') as Array<{ target: string; resolved_target_id: string | null }>;

    const acme = rels.find(r => r.target === 'Acme Corp');
    const nope = rels.find(r => r.target === 'Nonexistent');
    expect(acme?.resolved_target_id).not.toBeNull();
    expect(nope?.resolved_target_id).toBeNull();
  });
});
