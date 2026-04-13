export interface WriteLockOptions {
  recentWriteTtlMs?: number;
}

export class WriteLockManager {
  private locks = new Set<string>();
  private recentWrites = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;

  constructor(options?: WriteLockOptions) {
    this.ttlMs = options?.recentWriteTtlMs ?? 5000;
  }

  isLocked(filePath: string): boolean {
    return this.locks.has(filePath) || this.recentWrites.has(filePath);
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

  markRecentWrite(filePath: string): void {
    const existing = this.recentWrites.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.recentWrites.delete(filePath);
    }, this.ttlMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.recentWrites.set(filePath, timer);
  }

  clearRecentWrites(): void {
    for (const timer of this.recentWrites.values()) {
      clearTimeout(timer);
    }
    this.recentWrites.clear();
  }
}
