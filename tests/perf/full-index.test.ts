import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';

const REAL_VAULT = resolve(homedir(), 'Documents', 'archbrain');

describe('performance', () => {
  it('indexes the real vault in under 60 seconds', async () => {
    if (!existsSync(REAL_VAULT)) {
      console.log('Skipping: real vault not found at', REAL_VAULT);
      return;
    }

    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const start = Date.now();
    fullIndex(REAL_VAULT, db);
    const elapsed = Date.now() - start;

    const count = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    console.log(`Indexed ${count} nodes in ${elapsed}ms`);

    expect(elapsed).toBeLessThan(60_000);
    expect(count).toBeGreaterThan(0);
    db.close();
  });
});
