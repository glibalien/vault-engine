import { describe, it, expect } from 'vitest';
import { resolveDefaultValue, type FileContext } from '../../src/validation/resolve-default.js';

const ctx: FileContext = {
  mtimeMs: new Date('2025-01-20T14:45:00').getTime(),
  createdAtMs: new Date('2024-03-15T10:30:00').getTime(),
};

describe('resolveDefaultValue', () => {
  // ── Non-token passthrough ──────────────────────────────────────────
  it('returns non-string values unchanged', () => {
    expect(resolveDefaultValue(42, ctx)).toBe(42);
    expect(resolveDefaultValue(null, ctx)).toBe(null);
    expect(resolveDefaultValue(true, ctx)).toBe(true);
    expect(resolveDefaultValue(['a'], ctx)).toEqual(['a']);
  });

  it('returns non-token strings unchanged', () => {
    expect(resolveDefaultValue('open', ctx)).toBe('open');
    expect(resolveDefaultValue('$unknown', ctx)).toBe('$unknown');
    expect(resolveDefaultValue('ctime:YYYY', ctx)).toBe('ctime:YYYY');
  });

  // ── $ctime (from DB created_at) ───────────────────────────────────
  it('$ctime with default format', () => {
    expect(resolveDefaultValue('$ctime', ctx)).toBe('2024-03-15');
  });

  it('$ctime with explicit format', () => {
    expect(resolveDefaultValue('$ctime:YYYY-MM-DD', ctx)).toBe('2024-03-15');
  });

  it('$ctime with time format', () => {
    expect(resolveDefaultValue('$ctime:YYYY-MM-DDTHH:mm', ctx)).toBe('2024-03-15T10:30');
  });

  it('$ctime with null createdAtMs falls back to $now', () => {
    const noCreated: FileContext = { mtimeMs: ctx.mtimeMs, createdAtMs: null };
    const result = resolveDefaultValue('$ctime', noCreated);
    const nowResult = resolveDefaultValue('$now', noCreated);
    expect(result).toBe(nowResult);
  });

  // ── $mtime ─────────────────────────────────────────────────────────
  it('$mtime with default format', () => {
    expect(resolveDefaultValue('$mtime', ctx)).toBe('2025-01-20');
  });

  it('$mtime with explicit format', () => {
    expect(resolveDefaultValue('$mtime:YYYY-MM-DDTHH:mm:ss', ctx)).toBe('2025-01-20T14:45:00');
  });

  it('$mtime with MM/DD/YYYY format', () => {
    expect(resolveDefaultValue('$mtime:MM/DD/YYYY', ctx)).toBe('01/20/2025');
  });

  // ── $now ───────────────────────────────────────────────────────────
  it('$now resolves to current date', () => {
    const result = resolveDefaultValue('$now', null) as string;
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(result).toBe(expected);
  });

  it('$now ignores fileCtx and uses Date.now()', () => {
    const result = resolveDefaultValue('$now', ctx) as string;
    expect(result).not.toBe('2024-03-15');
    expect(result).not.toBe('2025-01-20');
  });

  // ── Null FileContext fallback ──────────────────────────────────────
  it('$ctime with null fileCtx falls back to $now', () => {
    const withCtx = resolveDefaultValue('$now', null);
    const withoutCtx = resolveDefaultValue('$ctime', null);
    expect(withoutCtx).toBe(withCtx);
  });

  it('$mtime with null fileCtx falls back to $now', () => {
    const withCtx = resolveDefaultValue('$now', null);
    const withoutCtx = resolveDefaultValue('$mtime', null);
    expect(withoutCtx).toBe(withCtx);
  });

  // ── Format tokens ─────────────────────────────────────────────────
  it('format with seconds', () => {
    expect(resolveDefaultValue('$mtime:HH:mm:ss', ctx)).toBe('14:45:00');
  });

  it('format with only year', () => {
    expect(resolveDefaultValue('$ctime:YYYY', ctx)).toBe('2024');
  });
});
