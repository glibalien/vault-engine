import { describe, it, expect } from 'vitest';
import { WriteLockManager } from '../../src/sync/write-lock.js';

describe('WriteLockManager', () => {
  it('isLocked returns false when not locked', () => {
    const wl = new WriteLockManager();
    expect(wl.isLocked('/some/path.md')).toBe(false);
  });

  it('withLock sets isLocked during execution', async () => {
    const wl = new WriteLockManager();
    let wasLocked = false;

    await wl.withLock('/some/path.md', async () => {
      wasLocked = wl.isLocked('/some/path.md');
      return 'ok';
    });

    expect(wasLocked).toBe(true);
    expect(wl.isLocked('/some/path.md')).toBe(false);
  });

  it('withLock unlocks on error', async () => {
    const wl = new WriteLockManager();

    await expect(
      wl.withLock('/some/path.md', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(wl.isLocked('/some/path.md')).toBe(false);
  });

  it('withLock returns the function result', async () => {
    const wl = new WriteLockManager();
    const result = await wl.withLock('/some/path.md', async () => 42);
    expect(result).toBe(42);
  });
});
