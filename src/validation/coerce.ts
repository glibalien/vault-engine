// src/validation/coerce.ts

import type { FieldType } from './types.js';

export interface CoercionSuccess {
  ok: true;
  value: unknown;
  changed: boolean;
}

export interface CoercionFailure {
  ok: false;
  reason: string;
  from_type: string;
  to_type: string;
  closest_matches?: string[];
  element_errors?: Array<{ index: number; value: unknown; reason: string }>;
}

export type CoercionResult = CoercionSuccess | CoercionFailure;

interface CoercionOptions {
  enum_values?: string[];
  list_item_type?: FieldType;
}

function success(value: unknown, changed: boolean): CoercionSuccess {
  return { ok: true, value, changed };
}

function failure(
  reason: string,
  from_type: string,
  to_type: string,
  extra?: Partial<Pick<CoercionFailure, 'closest_matches' | 'element_errors'>>,
): CoercionFailure {
  return { ok: false, reason, from_type, to_type, ...extra };
}

function detectType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  return typeof value;
}

// ── string → number ──────────────────────────────────────────────────

function stringToNumber(value: string): CoercionResult {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'Infinity' || trimmed === '-Infinity' || trimmed === 'NaN') {
    return failure(`Cannot convert "${value}" to number`, 'string', 'number');
  }
  const n = Number(trimmed);
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    return failure(`Cannot convert "${value}" to number`, 'string', 'number');
  }
  return success(n, true);
}

// ── string → date ────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^\d{4}-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

function stringToDate(value: string): CoercionResult {
  const trimmed = value.trim();
  const dateOnlyMatch = DATE_ONLY_RE.exec(trimmed);
  const dateTimeMatch = DATE_TIME_RE.exec(trimmed);

  if (!dateOnlyMatch && !dateTimeMatch) {
    return failure(`Invalid date format: "${value}"`, 'string', 'date');
  }

  const match = dateOnlyMatch || dateTimeMatch;
  const month = parseInt(match![1], 10);
  const day = parseInt(match![2], 10);

  if (month < 1 || month > 12) {
    return failure(`Impossible date (month ${month}): "${value}"`, 'string', 'date');
  }

  // Validate the day by constructing a Date and checking it round-trips
  const datePortion = trimmed.slice(0, 10);
  const checkDate = new Date(datePortion + 'T00:00:00Z');

  if (Number.isNaN(checkDate.getTime())) {
    return failure(`Invalid date: "${value}"`, 'string', 'date');
  }

  if (checkDate.getUTCDate() !== day || checkDate.getUTCMonth() + 1 !== month) {
    return failure(`Impossible date (day ${day}): "${value}"`, 'string', 'date');
  }

  return success(trimmed, true);
}

// ── string → boolean ────────────────────────────────────────────────

function stringToBoolean(value: string): CoercionResult {
  const lower = value.trim().toLowerCase();
  if (lower === 'true' || lower === 'yes') return success(true, true);
  if (lower === 'false' || lower === 'no') return success(false, true);
  return failure(
    `Cannot convert "${value}" to boolean. Accepted: true/false/yes/no`,
    'string',
    'boolean',
  );
}

// ── string → enum ───────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function closestMatches(value: string, candidates: string[], max = 3): string[] {
  const lower = value.toLowerCase();
  return candidates
    .map((c) => ({ c, d: levenshtein(lower, c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.c);
}

function toEnum(value: unknown, enumValues: string[]): CoercionResult {
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();

  for (const ev of enumValues) {
    if (ev === trimmed) return success(ev, typeof value !== 'string' || str !== trimmed);
    if (ev.toLowerCase() === trimmed.toLowerCase()) return success(ev, true);
  }

  return failure(
    `"${trimmed}" is not a valid enum value`,
    detectType(value),
    'enum',
    { closest_matches: closestMatches(trimmed, enumValues) },
  );
}

// ── string → reference ──────────────────────────────────────────────

function stringToReference(value: string): CoercionResult {
  const trimmed = value.trim();
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    return success(trimmed, false);
  }
  return success(`[[${trimmed}]]`, true);
}

// ── list coercion ───────────────────────────────────────────────────

function coerceList(value: unknown, itemType?: FieldType): CoercionResult {
  if (!Array.isArray(value)) {
    // single value → list: try wrapping
    if (itemType) {
      const elementResult = coerceValue(value, itemType);
      if (elementResult.ok) {
        return success([elementResult.value], true);
      }
      return failure(
        `Cannot wrap value into list: ${elementResult.reason}`,
        detectType(value),
        'list',
      );
    }
    return failure(`Cannot convert ${detectType(value)} to list`, detectType(value), 'list');
  }

  // Already an array — if no item type, pass through
  if (!itemType) return success(value, false);

  const errors: Array<{ index: number; value: unknown; reason: string }> = [];
  const coerced: unknown[] = [];
  let anyChanged = false;

  for (let i = 0; i < value.length; i++) {
    const r = coerceValue(value[i], itemType);
    if (r.ok) {
      coerced.push(r.value);
      if (r.changed) anyChanged = true;
    } else {
      errors.push({ index: i, value: value[i], reason: r.reason });
    }
  }

  if (errors.length > 0) {
    return failure(
      `${errors.length} list element(s) failed coercion`,
      'list',
      `list<${itemType}>`,
      { element_errors: errors },
    );
  }

  return success(coerced, anyChanged);
}

// ── main function ───────────────────────────────────────────────────

export function coerceValue(
  value: unknown,
  targetType: FieldType,
  options?: CoercionOptions,
): CoercionResult {
  // null / undefined passthrough
  if (value === null || value === undefined) {
    return success(null, false);
  }

  const srcType = detectType(value);

  // ── list ──
  if (targetType === 'list') {
    return coerceList(value, options?.list_item_type);
  }

  // ── enum ──
  if (targetType === 'enum') {
    if (!options?.enum_values) {
      return failure('No enum_values provided', srcType, 'enum');
    }
    return toEnum(value, options.enum_values);
  }

  // ── identity checks ──
  if (targetType === 'string' && typeof value === 'string') return success(value, false);
  if (targetType === 'number' && typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return failure(`Non-finite number: ${value}`, 'number', 'number');
    }
    return success(value, false);
  }
  if (targetType === 'boolean' && typeof value === 'boolean') return success(value, false);
  if (targetType === 'reference' && typeof value === 'string') {
    return stringToReference(value);
  }

  // ── string source coercions ──
  if (typeof value === 'string') {
    switch (targetType) {
      case 'number': return stringToNumber(value);
      case 'date': return stringToDate(value);
      case 'boolean': return stringToBoolean(value);
      default: break;
    }
  }

  // ── number → string ──
  if (typeof value === 'number' && targetType === 'string') {
    return success(String(value), true);
  }

  // ── Date object → string ──
  if (value instanceof Date && targetType === 'string') {
    return success(value.toISOString(), true);
  }

  // ── boolean → string ──
  if (typeof value === 'boolean' && targetType === 'string') {
    return success(String(value), true);
  }

  return failure(
    `Cannot coerce ${srcType} to ${targetType}`,
    srcType,
    targetType,
  );
}
