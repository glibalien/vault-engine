import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function loadVecExtension(db: Database.Database): void {
  sqliteVec.load(db);
}

export function createVecTable(db: Database.Database, dimensions: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    )
  `);
}

export function getVecDimensions(db: Database.Database): number | null {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
  ).get();
  if (!row) return null;

  const sqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
  ).get() as { sql: string } | undefined;
  if (!sqlRow) return null;

  const match = sqlRow.sql.match(/FLOAT\[(\d+)\]/i);
  return match ? parseInt(match[1], 10) : null;
}

export function dropVecTable(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS vec_chunks');
}
