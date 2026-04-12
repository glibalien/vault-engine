import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteGate } from '../../src/sync/write-gate.js';

describe('WriteGate', () => {
  let gate: WriteGate;
  let writeFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeFn = vi.fn();
    gate = new WriteGate({ quietPeriodMs: 3000 });
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
  });

  it('fires write callback after quiet period expires', () => {
    gate.fileChanged('note.md', writeFn);
    vi.advanceTimersByTime(2000);
    expect(writeFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(writeFn).toHaveBeenCalledWith('note.md');
  });

  it('resets quiet period on subsequent changes', () => {
    gate.fileChanged('note.md', writeFn);
    vi.advanceTimersByTime(2000);
    gate.fileChanged('note.md', writeFn);
    vi.advanceTimersByTime(2000);
    expect(writeFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(writeFn).toHaveBeenCalledTimes(1);
  });

  it('cancel prevents the deferred write from firing', () => {
    gate.fileChanged('note.md', writeFn);
    vi.advanceTimersByTime(1000);
    gate.cancel('note.md');
    vi.advanceTimersByTime(5000);
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('tracks files independently', () => {
    const writeFn2 = vi.fn();
    gate.fileChanged('a.md', writeFn);
    gate.fileChanged('b.md', writeFn2);
    vi.advanceTimersByTime(3500);
    expect(writeFn).toHaveBeenCalledWith('a.md');
    expect(writeFn2).toHaveBeenCalledWith('b.md');
  });

  it('isPending returns true for files with pending writes', () => {
    expect(gate.isPending('note.md')).toBe(false);
    gate.fileChanged('note.md', writeFn);
    expect(gate.isPending('note.md')).toBe(true);
    vi.advanceTimersByTime(3500);
    expect(gate.isPending('note.md')).toBe(false);
  });
});
