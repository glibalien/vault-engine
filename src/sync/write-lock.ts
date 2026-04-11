export class WriteLockManager {
  private locks = new Set<string>();

  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    this.locks.add(filePath);
    try {
      return await fn();
    } finally {
      this.locks.delete(filePath);
    }
  }

  withLockSync<T>(filePath: string, fn: () => T): T {
    this.locks.add(filePath);
    try {
      return fn();
    } finally {
      this.locks.delete(filePath);
    }
  }
}
