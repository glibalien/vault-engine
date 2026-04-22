import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addNodeTypesSortOrder } from '../../src/db/migrate.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  addUndoTables(db);
  addNodeTypesSortOrder(db);
  return db;
}
