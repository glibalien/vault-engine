import { describe, it, expect } from 'vitest';
import { IndexMutex } from '../../src/sync/mutex.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('IndexMutex', () => {
  it('onIdle resolves immediately when not running', async () => {
    const mutex = new IndexMutex();
    await mutex.onIdle(); // should not hang
  });

  it('onIdle waits for in-flight run to complete', async () => {
    const mutex = new IndexMutex();
    const order: string[] = [];

    // Start a slow operation
    mutex.run(async () => {
      await delay(100);
      order.push('run-done');
    });

    // onIdle should wait for it
    await mutex.onIdle();
    order.push('idle-resolved');

    expect(order).toEqual(['run-done', 'idle-resolved']);
  });

  it('onIdle waits for queued events to drain', async () => {
    const mutex = new IndexMutex();
    const processed: string[] = [];

    mutex.processEvent = async (event) => {
      processed.push(event.path);
    };

    // Start a run and enqueue during it
    mutex.run(async () => {
      await delay(50);
      mutex.enqueue({ type: 'change', path: 'a.md' });
    });

    await mutex.onIdle();
    expect(processed).toEqual(['a.md']);
  });
});
