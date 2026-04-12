import type Database from 'better-sqlite3';

type CheckResult =
  | { valid: true }
  | { valid: false; unknown: string[]; available: string[] };

export function checkTypesHaveSchemas(
  db: Database.Database,
  types: string[],
): CheckResult {
  if (types.length === 0) return { valid: true };
  const schemaNames = new Set(
    (db.prepare('SELECT name FROM schemas').all() as Array<{ name: string }>).map(r => r.name),
  );
  const unknown = types.filter(t => !schemaNames.has(t));
  if (unknown.length === 0) return { valid: true };
  return {
    valid: false,
    unknown,
    available: [...schemaNames].sort(),
  };
}
