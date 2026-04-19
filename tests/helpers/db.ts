import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  // vault-stats reads the undo tables unconditionally; match production startup
  // (src/index.ts calls addUndoTables(db) on boot) so tests don't have to
  // remember to add them individually.
  addUndoTables(db);
  return db;
}
