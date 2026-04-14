export interface FileContext {
  mtimeMs: number;
  createdAtMs?: number | null;
}

const TOKEN_RE = /^\$(ctime|mtime|now)(?::(.+))?$/;
const DEFAULT_FORMAT = 'YYYY-MM-DD';

/**
 * If `defaultValue` is a date token ($ctime, $mtime, $now), resolve it
 * to a formatted date string. Otherwise return unchanged.
 *
 * $ctime reads from the DB `created_at` column (via fileCtx.createdAtMs),
 * NOT from filesystem birthtime (which is unreliable with atomic writes).
 */
export function resolveDefaultValue(
  defaultValue: unknown,
  fileCtx: FileContext | null,
): unknown {
  if (typeof defaultValue !== 'string') return defaultValue;

  const match = defaultValue.match(TOKEN_RE);
  if (!match) return defaultValue;

  const [, token, formatStr] = match;
  const format = formatStr || DEFAULT_FORMAT;

  let timestampMs: number;
  switch (token) {
    case 'ctime':
      timestampMs = fileCtx?.createdAtMs ?? Date.now();
      break;
    case 'mtime':
      timestampMs = fileCtx?.mtimeMs ?? Date.now();
      break;
    case 'now':
      timestampMs = Date.now();
      break;
    default:
      return defaultValue;
  }

  return formatDate(new Date(timestampMs), format);
}

function formatDate(date: Date, format: string): string {
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  };

  let result = format;
  // Replace longest tokens first to avoid partial matches
  for (const [token, value] of Object.entries(tokens)) {
    result = result.replaceAll(token, value);
  }
  return result;
}
