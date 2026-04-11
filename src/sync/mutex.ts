export type PendingEvent = { type: 'add' | 'change' | 'unlink'; path: string };

export class IndexMutex {
  private running = false;
  private queue = new Map<string, PendingEvent>();
  private idleResolvers: Array<() => void> = [];
  processEvent: (event: PendingEvent) => Promise<void> = async () => {};

  async run(fn: () => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await fn();
      // Drain queued events
      while (this.queue.size > 0) {
        const events = [...this.queue.values()];
        this.queue.clear();
        for (const event of events) {
          await this.processEvent(event);
        }
      }
    } finally {
      this.running = false;
      this.notifyIdle();
    }
  }

  enqueue(event: PendingEvent): void {
    this.queue.set(event.path, event);
  }

  isRunning(): boolean {
    return this.running;
  }

  onIdle(): Promise<void> {
    if (!this.running && this.queue.size === 0) return Promise.resolve();
    return new Promise(resolve => {
      this.idleResolvers.push(resolve);
    });
  }

  private notifyIdle(): void {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
