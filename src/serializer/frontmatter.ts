const WIKI_LINK_RE = /\[\[/;
const YAML_BOOL_RE = /^(true|false|yes|no|on|off)$/i;
const YAML_NULL_RE = /^(null|Null|NULL|~)$/;
const YAML_NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// Safe: alphanumeric, spaces, hyphens, underscores, periods — no leading/trailing whitespace
const SAFE_STRING_RE = /^[a-zA-Z][a-zA-Z0-9 _.\-]*$/;

function needsQuoting(value: string): boolean {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (YAML_BOOL_RE.test(value)) return true;
  if (YAML_NULL_RE.test(value)) return true;
  if (YAML_NUMBER_RE.test(value)) return true;
  if (WIKI_LINK_RE.test(value)) return true;
  if (!SAFE_STRING_RE.test(value)) return true;
  return false;
}

function quoteString(value: string): string {
  // Escape backslashes and double quotes inside the value
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function serializeScalar(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    return needsQuoting(value) ? quoteString(value) : value;
  }
  return quoteString(String(value));
}

export function serializeFrontmatter(
  entries: Array<{ key: string; value: unknown }>,
): string {
  if (entries.length === 0) return '';
  return entries.map(({ key, value }) => `${key}: ${serializeValue(value)}`).join('\n') + '\n';
}

export function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(item => serializeScalar(item));
    return `[${items.join(', ')}]`;
  }
  return serializeScalar(value);
}
