import type Database from 'better-sqlite3';
import type { ParsedFile } from '../parser/index.js';

function stringifyValue(value: unknown, valueType: string): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function indexFile(
  db: Database.Database,
  parsed: ParsedFile,
  relativePath: string,
  mtime: string,
): void {
  // Delete existing child rows
  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(relativePath);
  db.prepare('DELETE FROM node_types WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM fields WHERE node_id = ?').run(relativePath);

  // Upsert node
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, depth)
    VALUES (?, ?, 'file', ?, ?, 0)
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd);

  // Insert node_types
  const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const type of parsed.types) {
    insertType.run(relativePath, type);
  }

  // Insert fields
  const insertField = db.prepare(`
    INSERT INTO fields (node_id, key, value_text, value_type, value_number, value_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const field of parsed.fields) {
    insertField.run(
      relativePath,
      field.key,
      stringifyValue(field.value, field.valueType),
      field.valueType,
      field.valueType === 'number' ? Number(field.value) : null,
      field.valueType === 'date' && field.value instanceof Date
        ? field.value.toISOString()
        : null,
    );
  }
}
