import type Database from 'better-sqlite3';

export class SyncLogger {
  private insertCount = 0;
  private readonly retentionMs: number;
  private readonly stmt: Database.Statement;

  constructor(private db: Database.Database) {
    const hours = parseInt(process.env.SYNC_LOG_RETENTION_HOURS ?? '24', 10);
    this.retentionMs = (isNaN(hours) ? 24 : hours) * 3_600_000;
    this.stmt = db.prepare(
      'INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)',
    );
    this.pruneStmt = db.prepare('DELETE FROM sync_log WHERE timestamp < ?');
    this.prune();
  }

  watcherEvent(filePath: string, hash: string, size: number): void {
    this.log(filePath, 'watcher-event', 'watcher', { hash, size });
  }

  parseRetry(filePath: string, attempt: number, error: string): void {
    this.log(filePath, 'parse-retry', 'watcher', { attempt, error });
  }

  fileWritten(filePath: string, source: string, hash: string): void {
    this.log(filePath, 'file-written', source, { hash });
  }

  noop(filePath: string, source: string): void {
    this.log(filePath, 'noop', source, {});
  }

  private log(filePath: string, event: string, source: string, details: Record<string, unknown>): void {
    this.stmt.run(Date.now(), filePath, event, source, JSON.stringify(details));
    if (++this.insertCount % 1000 === 0) this.prune();
  }

  private readonly pruneStmt: Database.Statement;

  private prune(): void {
    this.pruneStmt.run(Date.now() - this.retentionMs);
  }
}
