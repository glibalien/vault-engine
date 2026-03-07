import { createHash } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { relative, join, basename } from 'node:path';
import type Database from 'better-sqlite3';
import type { ParsedFile } from '../parser/index.js';
import { parseFile } from '../parser/index.js';

function globMd(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(join(entry.parentPath, entry.name));
    }
  }
  return results;
}

function stringifyValue(value: unknown, valueType: string): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function deriveTitle(parsed: ParsedFile, relativePath: string): string {
  if (parsed.frontmatter.title && typeof parsed.frontmatter.title === 'string') {
    return parsed.frontmatter.title;
  }
  return basename(relativePath, '.md');
}

export function indexFile(
  db: Database.Database,
  parsed: ParsedFile,
  relativePath: string,
  mtime: string,
  raw: string,
): void {
  // Delete existing child rows
  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(relativePath);
  db.prepare('DELETE FROM node_types WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM fields WHERE node_id = ?').run(relativePath);

  // Upsert node
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, file_path, node_type, content_text, content_md, title, depth)
    VALUES (?, ?, 'file', ?, ?, ?, 0)
  `).run(relativePath, relativePath, parsed.contentText, parsed.contentMd, deriveTitle(parsed, relativePath));

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

  // Insert relationships
  const insertRel = db.prepare(`
    INSERT INTO relationships (source_id, target_id, rel_type, context)
    VALUES (?, ?, ?, ?)
  `);
  for (const link of parsed.wikiLinks) {
    insertRel.run(
      relativePath,
      link.target,
      link.field ?? 'wiki-link',
      link.context ?? null,
    );
  }

  // Upsert files row
  const hash = createHash('sha256').update(raw).digest('hex');
  db.prepare(`
    INSERT OR REPLACE INTO files (path, mtime, hash)
    VALUES (?, ?, ?)
  `).run(relativePath, mtime, hash);
}

export function deleteFile(db: Database.Database, relativePath: string): void {
  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(relativePath);
  db.prepare('DELETE FROM fields WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM node_types WHERE node_id = ?').run(relativePath);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(relativePath);
  db.prepare('DELETE FROM files WHERE path = ?').run(relativePath);
}

export function incrementalIndex(
  db: Database.Database,
  vaultPath: string,
): { indexed: number; skipped: number; deleted: number } {
  const mdFiles = globMd(vaultPath);

  const run = db.transaction(() => {
    // Load existing file records into a map
    const existingFiles = new Map<string, { mtime: string; hash: string }>();
    const rows = db.prepare('SELECT path, mtime, hash FROM files').all() as Array<{ path: string; mtime: string; hash: string }>;
    for (const row of rows) {
      existingFiles.set(row.path, { mtime: row.mtime, hash: row.hash });
    }

    let indexed = 0;
    let skipped = 0;

    for (const absPath of mdFiles) {
      const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
      const mtime = statSync(absPath).mtime.toISOString();
      const existing = existingFiles.get(rel);

      // Mark as seen
      existingFiles.delete(rel);

      if (existing && existing.mtime === mtime) {
        // Mtime matches — skip
        skipped++;
        continue;
      }

      const raw = readFileSync(absPath, 'utf-8');

      if (existing) {
        // Mtime differs — check hash
        const hash = createHash('sha256').update(raw).digest('hex');
        if (hash === existing.hash) {
          // Content unchanged — just update mtime
          db.prepare('UPDATE files SET mtime = ? WHERE path = ?').run(mtime, rel);
          skipped++;
          continue;
        }
      }

      // New file or content changed — parse and index
      try {
        const parsed = parseFile(rel, raw);
        indexFile(db, parsed, rel, mtime, raw);
        indexed++;
      } catch {
        // Skip files that fail to parse
      }
    }

    // Delete files that are in DB but no longer on disk
    let deleted = 0;
    for (const [path] of existingFiles) {
      deleteFile(db, path);
      deleted++;
    }

    return { indexed, skipped, deleted };
  });

  return run();
}

export function rebuildIndex(
  db: Database.Database,
  vaultPath: string,
): { filesIndexed: number } {
  const mdFiles = globMd(vaultPath);

  const run = db.transaction(() => {
    // Clear all tables (children before parents for FK order)
    db.prepare('DELETE FROM relationships').run();
    db.prepare('DELETE FROM fields').run();
    db.prepare('DELETE FROM node_types').run();
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM files').run();

    let filesIndexed = 0;
    for (const absPath of mdFiles) {
      const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
      const raw = readFileSync(absPath, 'utf-8');
      const mtime = statSync(absPath).mtime.toISOString();

      try {
        const parsed = parseFile(rel, raw);
        indexFile(db, parsed, rel, mtime, raw);
        filesIndexed++;
      } catch {
        // Skip files that fail to parse
      }
    }

    return { filesIndexed };
  });

  return run();
}
