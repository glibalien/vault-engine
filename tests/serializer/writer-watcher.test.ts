import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { watchVault } from '../../src/sync/watcher.js';
import { writeNodeFile, deleteNodeFile } from '../../src/serializer/writer.js';
import { indexFile, deleteFile } from '../../src/sync/indexer.js';
import { resolveReferences } from '../../src/sync/resolver.js';
import { parseFile } from '../../src/parser/index.js';

function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('writer + watcher integration', () => {
  let db: Database.Database;
  let tmpVault: string;
  let handle: { close(): Promise<void>; ready: Promise<void> };

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-writer-watch-'));
    handle = watchVault(db, tmpVault);
    await handle.ready;
  });

  afterEach(async () => {
    await handle.close();
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('writeNodeFile + immediate index does not cause watcher re-index', async () => {
    const content = '---\ntitle: Engine Written\ntypes: [note]\n---\n';
    const rel = 'engine-note.md';

    // Simulate what create-node will do: write file, then index it
    writeNodeFile(tmpVault, rel, content);
    const parsed = parseFile(rel, content);
    const mtime = statSync(join(tmpVault, rel)).mtime.toISOString();
    db.transaction(() => {
      indexFile(db, parsed, rel, mtime, content);
      resolveReferences(db);
    })();

    // Write a marker file to prove watcher is active
    writeFileSync(join(tmpVault, 'marker.md'), '# Marker');
    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('marker.md') !== undefined,
    );

    // Wait for any stray events
    await new Promise((r) => setTimeout(r, 300));

    // The engine-written file should have been indexed exactly once
    // (by our direct indexFile call, not re-indexed by the watcher)
    const node = db.prepare('SELECT title FROM nodes WHERE id = ?').get(rel) as any;
    expect(node.title).toBe('Engine Written');

    // mtime unchanged proves watcher didn't re-index (it would capture a new mtime)
    const filesRow = db.prepare('SELECT mtime FROM files WHERE path = ?').get(rel) as any;
    expect(filesRow.mtime).toBe(mtime);
  });

  it('deleteNodeFile does not cause watcher to error on deleted file', async () => {
    const content = '---\ntitle: To Delete\ntypes: [note]\n---\n';
    const rel = 'to-delete.md';

    // Create and index the file
    writeNodeFile(tmpVault, rel, content);
    const parsed = parseFile(rel, content);
    const mtime = statSync(join(tmpVault, rel)).mtime.toISOString();
    db.transaction(() => {
      indexFile(db, parsed, rel, mtime, content);
    })();

    // Delete via deleteNodeFile (write-locked) and clean up DB
    deleteNodeFile(tmpVault, rel);
    db.transaction(() => {
      deleteFile(db, rel);
    })();

    // Write a marker file to prove watcher is active
    writeFileSync(join(tmpVault, 'marker.md'), '# Marker');
    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('marker.md') !== undefined,
    );

    await new Promise((r) => setTimeout(r, 300));

    // The deleted file should not exist in DB
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get(rel)).toBeUndefined();
  });
});
