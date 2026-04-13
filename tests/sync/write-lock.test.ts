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

  describe('markRecentWrite', () => {
    it('isLocked returns true for recently-written paths', () => {
      const wl = new WriteLockManager();
      wl.markRecentWrite('/tmp/test.md');
      expect(wl.isLocked('/tmp/test.md')).toBe(true);
    });

    it('isLocked returns false after TTL expires', async () => {
      const wl = new WriteLockManager({ recentWriteTtlMs: 50 });
      wl.markRecentWrite('/tmp/test.md');
      expect(wl.isLocked('/tmp/test.md')).toBe(true);
      await new Promise(r => setTimeout(r, 80));
      expect(wl.isLocked('/tmp/test.md')).toBe(false);
    });

    it('does not interfere with active locks', () => {
      const wl = new WriteLockManager();
      wl.withLockSync('/tmp/test.md', () => {
        expect(wl.isLocked('/tmp/test.md')).toBe(true);
      });
      expect(wl.isLocked('/tmp/test.md')).toBe(false);
    });

    it('clearRecentWrites clears all entries', () => {
      const wl = new WriteLockManager();
      wl.markRecentWrite('/tmp/a.md');
      wl.markRecentWrite('/tmp/b.md');
      wl.clearRecentWrites();
      expect(wl.isLocked('/tmp/a.md')).toBe(false);
      expect(wl.isLocked('/tmp/b.md')).toBe(false);
    });
  });
});
