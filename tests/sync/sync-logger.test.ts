import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';

let db: Database.Database;
let logger: SyncLogger;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  logger = new SyncLogger(db);
});

afterEach(() => {
  db.close();
});

function getRows(): Array<{ file_path: string; event: string; source: string; details: string }> {
  return db.prepare('SELECT file_path, event, source, details FROM sync_log ORDER BY id').all() as Array<{
    file_path: string; event: string; source: string; details: string;
  }>;
}

describe('SyncLogger', () => {
  it('watcherEvent logs with hash and size', () => {
    logger.watcherEvent('note.md', 'abc123', 1024);
    const rows = getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe('note.md');
    expect(rows[0].event).toBe('watcher-event');
    expect(rows[0].source).toBe('watcher');
    expect(JSON.parse(rows[0].details)).toEqual({ hash: 'abc123', size: 1024 });
  });

  it('parseRetry logs attempt and error', () => {
    logger.parseRetry('note.md', 2, 'bad YAML');
    const rows = getRows();
    expect(rows[0].event).toBe('parse-retry');
    expect(JSON.parse(rows[0].details)).toEqual({ attempt: 2, error: 'bad YAML' });
  });

  it('deferredWriteScheduled logs event', () => {
    logger.deferredWriteScheduled('note.md');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-scheduled');
    expect(rows[0].source).toBe('watcher');
  });

  it('deferredWriteCancelled logs reason', () => {
    logger.deferredWriteCancelled('note.md', 'tool-write');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-cancelled');
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'tool-write' });
  });

  it('deferredWriteFired logs intended hash', () => {
    logger.deferredWriteFired('note.md', 'hash123');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-fired');
    expect(JSON.parse(rows[0].details)).toEqual({ intended_hash: 'hash123' });
  });

  it('deferredWriteSkipped logs reason with optional hashes', () => {
    logger.deferredWriteSkipped('note.md', 'stale-file', 'aaa', 'bbb');
    const rows = getRows();
    expect(rows[0].event).toBe('deferred-write-skipped');
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'stale-file', intended_hash: 'aaa', disk_hash: 'bbb' });
  });

  it('deferredWriteSkipped omits hashes when not provided', () => {
    logger.deferredWriteSkipped('note.md', 'node-deleted');
    const rows = getRows();
    expect(JSON.parse(rows[0].details)).toEqual({ reason: 'node-deleted' });
  });

  it('fileWritten logs source and hash', () => {
    logger.fileWritten('note.md', 'tool', 'xyz789');
    const rows = getRows();
    expect(rows[0].event).toBe('file-written');
    expect(rows[0].source).toBe('tool');
    expect(JSON.parse(rows[0].details)).toEqual({ hash: 'xyz789' });
  });

  it('noop logs source', () => {
    logger.noop('note.md', 'watcher');
    const rows = getRows();
    expect(rows[0].event).toBe('noop');
    expect(rows[0].source).toBe('watcher');
  });

  it('prunes old entries on construction', () => {
    // Insert a row with old timestamp directly
    db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now() - 100_000_000, 'old.md', 'watcher-event', 'watcher', '{}');

    // Creating a new logger triggers pruning
    const logger2 = new SyncLogger(db);
    const rows = db.prepare('SELECT * FROM sync_log WHERE file_path = ?').all('old.md');
    expect(rows).toHaveLength(0);
  });

  it('prunes every 1000 inserts', () => {
    // Insert an old row
    db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now() - 100_000_000, 'old.md', 'watcher-event', 'watcher', '{}');

    // Insert 1000 rows to trigger prune
    for (let i = 0; i < 1000; i++) {
      logger.noop(`file-${i}.md`, 'watcher');
    }

    const oldRows = db.prepare('SELECT * FROM sync_log WHERE file_path = ?').all('old.md');
    expect(oldRows).toHaveLength(0);
  });
});
