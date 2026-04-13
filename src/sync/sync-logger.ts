import type Database from 'better-sqlite3';

export class SyncLogger {
  private insertCount = 0;
  private readonly retentionMs: number;
  private readonly stmt: ReturnType<Database.Database['prepare']>;

  constructor(private db: Database.Database) {
    const hours = parseInt(process.env.SYNC_LOG_RETENTION_HOURS ?? '24', 10);
    this.retentionMs = (isNaN(hours) ? 24 : hours) * 3_600_000;
    this.stmt = db.prepare(
      'INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)',
    );
    this.prune();
  }

  watcherEvent(filePath: string, hash: string, size: number): void {
    this.log(filePath, 'watcher-event', 'watcher', { hash, size });
  }

  parseRetry(filePath: string, attempt: number, error: string): void {
    this.log(filePath, 'parse-retry', 'watcher', { attempt, error });
  }

  deferredWriteScheduled(filePath: string): void {
    this.log(filePath, 'deferred-write-scheduled', 'watcher', {});
  }

  deferredWriteCancelled(filePath: string, reason: string): void {
    this.log(filePath, 'deferred-write-cancelled', 'watcher', { reason });
  }

  deferredWriteFired(filePath: string, intendedHash: string): void {
    this.log(filePath, 'deferred-write-fired', 'watcher', { intended_hash: intendedHash });
  }

  deferredWriteSkipped(filePath: string, reason: string, intendedHash?: string, diskHash?: string): void {
    const details: Record<string, string> = { reason };
    if (intendedHash !== undefined) details.intended_hash = intendedHash;
    if (diskHash !== undefined) details.disk_hash = diskHash;
    this.log(filePath, 'deferred-write-skipped', 'watcher', details);
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

  private prune(): void {
    this.db.prepare('DELETE FROM sync_log WHERE timestamp < ?').run(Date.now() - this.retentionMs);
  }
}
