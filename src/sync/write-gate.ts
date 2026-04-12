export interface WriteGateOptions {
  quietPeriodMs?: number;
}

type WriteCallback = (filePath: string) => void;

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  callback: WriteCallback;
}

export class WriteGate {
  private readonly quietPeriodMs: number;
  private pending = new Map<string, PendingWrite>();

  constructor(options?: WriteGateOptions) {
    this.quietPeriodMs = options?.quietPeriodMs ?? 3000;
  }

  /**
   * Record that a file changed externally. Resets the quiet-period timer.
   * When the timer expires, `callback` is called with the file path.
   */
  fileChanged(filePath: string, callback: WriteCallback): void {
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      callback(filePath);
    }, this.quietPeriodMs);

    this.pending.set(filePath, { timer, callback });
  }

  /**
   * Cancel any pending write for a file.
   */
  cancel(filePath: string): void {
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(filePath);
    }
  }

  /**
   * True if a deferred write is pending for this file.
   */
  isPending(filePath: string): boolean {
    return this.pending.has(filePath);
  }

  /**
   * Clean up all timers.
   */
  dispose(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
