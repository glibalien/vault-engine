import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { parse as parseYaml } from 'yaml';
import { parseMarkdown } from '../parser/parse.js';
import { splitFrontmatter } from '../parser/frontmatter.js';
import type { WikiLink, YamlValue } from '../parser/types.js';
import { sha256 } from './hash.js';
import { shouldIgnore } from './ignore.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

const BATCH_SIZE = 100;

// ── Prepared statement cache (per call, not module-level) ──────────

interface Statements {
  getNodeByPath: Database.Statement;
  getNodeRowid: Database.Statement;
  upsertNode: Database.Statement;
  deleteFts: Database.Statement;
  insertFts: Database.Statement;
  deleteTypes: Database.Statement;
  insertType: Database.Statement;
  deleteFields: Database.Statement;
  insertField: Database.Statement;
  deleteRelationships: Database.Statement;
  insertRelationship: Database.Statement;
  insertEditLog: Database.Statement;
  deleteNode: Database.Statement;
  allFilePaths: Database.Statement;
  updateMtime: Database.Statement;
}

function prepareStatements(db: Database.Database): Statements {
  return {
    getNodeByPath: db.prepare('SELECT id, content_hash, file_mtime FROM nodes WHERE file_path = ?'),
    getNodeRowid: db.prepare('SELECT rowid FROM nodes WHERE id = ?'),
    upsertNode: db.prepare(`
      INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
      VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @indexed_at)
      ON CONFLICT(id) DO UPDATE SET
        file_path = @file_path,
        title = @title,
        body = @body,
        content_hash = @content_hash,
        file_mtime = @file_mtime,
        indexed_at = @indexed_at
    `),
    deleteFts: db.prepare('DELETE FROM nodes_fts WHERE rowid = ?'),
    insertFts: db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (@rowid, @title, @body)'),
    deleteTypes: db.prepare('DELETE FROM node_types WHERE node_id = ?'),
    insertType: db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)'),
    deleteFields: db.prepare('DELETE FROM node_fields WHERE node_id = ?'),
    insertField: db.prepare(`
      INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
      VALUES (@node_id, @field_name, @value_text, @value_number, @value_date, @value_json, @value_raw_text, @source)
    `),
    deleteRelationships: db.prepare('DELETE FROM relationships WHERE source_id = ?'),
    insertRelationship: db.prepare(
      'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)',
    ),
    insertEditLog: db.prepare(
      'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
    ),
    deleteNode: db.prepare('DELETE FROM nodes WHERE id = ?'),
    allFilePaths: db.prepare('SELECT id, file_path FROM nodes'),
    updateMtime: db.prepare('UPDATE nodes SET file_mtime = ? WHERE id = ?'),
  };
}

// ── Field value classification ─────────────────────────────────────

interface FieldColumns {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: string | null;
}

function classifyValue(v: YamlValue): FieldColumns {
  if (v === null || v === undefined) {
    return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(null) };
  }
  if (v instanceof Date) {
    return { value_text: null, value_number: null, value_date: v.toISOString(), value_json: null };
  }
  if (typeof v === 'string') {
    return { value_text: v, value_number: null, value_date: null, value_json: null };
  }
  if (typeof v === 'number') {
    return { value_text: null, value_number: v, value_date: null, value_json: null };
  }
  // boolean, array, object
  return { value_text: null, value_number: null, value_date: null, value_json: JSON.stringify(v) };
}

// ── Core index logic for a single file ─────────────────────────────

/**
 * Extract raw field texts (pre-wiki-link-stripping) from the YAML frontmatter.
 * Returns a map of field names to their raw string values for fields containing [[...]].
 * Populated unconditionally regardless of claim status (Phase 2 Principle 2).
 */
function extractRawFieldTexts(raw: string): Record<string, string> {
  const { yaml: yamlStr } = splitFrontmatter(raw);
  if (!yamlStr) return {};

  let rawParsed: unknown;
  try {
    rawParsed = parseYaml(yamlStr);
  } catch {
    return {};
  }
  if (rawParsed === null || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) return {};

  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(rawParsed as Record<string, unknown>)) {
    if (key === 'title' || key === 'types') continue;
    if (typeof rawValue === 'string' && WIKILINK_RE.test(rawValue)) {
      result[key] = rawValue;
    }
    if (Array.isArray(rawValue)) {
      const hasLinks = rawValue.some(v => typeof v === 'string' && WIKILINK_RE.test(String(v)));
      if (hasLinks) {
        result[key] = JSON.stringify(rawValue);
      }
    }
  }
  return result;
}

function doIndex(
  stmts: Statements,
  raw: string,
  filePath: string,
  absolutePath: string,
  mtime: number,
  contentHash: string,
  existingId: string | null,
): string {
  const parsed = parseMarkdown(raw, filePath);
  const rawFieldTexts = extractRawFieldTexts(raw);
  const nodeId = existingId ?? nanoid();
  const now = Date.now();

  // If re-indexing, clean up old dependent rows and FTS entry
  if (existingId !== null) {
    const rowInfo = stmts.getNodeRowid.get(existingId) as { rowid: number } | undefined;
    if (rowInfo) {
      stmts.deleteFts.run(rowInfo.rowid);
    }
    stmts.deleteTypes.run(existingId);
    stmts.deleteFields.run(existingId);
    stmts.deleteRelationships.run(existingId);
  }

  // Upsert node
  stmts.upsertNode.run({
    id: nodeId,
    file_path: filePath,
    title: parsed.title ?? null,
    body: parsed.body,
    content_hash: contentHash,
    file_mtime: mtime,
    indexed_at: now,
  });

  // Insert FTS entry using rowid from nodes table
  const rowInfo = stmts.getNodeRowid.get(nodeId) as { rowid: number };
  stmts.insertFts.run({ rowid: rowInfo.rowid, title: parsed.title ?? '', body: parsed.body });

  // Insert types
  for (const t of parsed.types) {
    stmts.insertType.run(nodeId, t);
  }

  // Insert fields
  const fieldNames = new Set<string>();
  for (const [fieldName, value] of parsed.fields) {
    fieldNames.add(fieldName);
    const cols = classifyValue(value);
    stmts.insertField.run({
      node_id: nodeId,
      field_name: fieldName,
      ...cols,
      value_raw_text: rawFieldTexts[fieldName] ?? null,
      source: 'frontmatter',
    });
  }

  // Insert relationships from wiki-links
  for (const link of parsed.wikiLinks) {
    const relType = fieldNames.has(link.context) ? link.context : 'wiki-link';
    stmts.insertRelationship.run(nodeId, link.target, relType, link.context);
  }

  // Log
  stmts.insertEditLog.run(nodeId, now, 'file-indexed', filePath);

  return nodeId;
}

// ── Walk directory ─────────────────────────────────────────────────

function walkDir(dir: string, vaultPath: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable directory — skip
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(join(current, entry.name));
      } else if (entry.isFile()) {
        const absPath = join(current, entry.name);
        const relPath = relative(vaultPath, absPath);
        if (!shouldIgnore(relPath)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

// ── Public API ─────────────────────────────────────────────────────

export interface IndexStats {
  indexed: number;
  skipped: number;
  deleted: number;
  errors: number;
}

export interface IndexerOptions {
  onNodeIndexed?: (nodeId: string) => void;
}

/**
 * Full vault index: walk all files, detect deletions, batch-index changes.
 */
export function fullIndex(vaultPath: string, db: Database.Database, options?: IndexerOptions): IndexStats {
  const stmts = prepareStatements(db);
  const stats: IndexStats = { indexed: 0, skipped: 0, deleted: 0, errors: 0 };

  // 1. Walk vault
  const diskFiles = new Set(walkDir(vaultPath, vaultPath));

  // 2. Detect deletions
  const dbNodes = stmts.allFilePaths.all() as { id: string; file_path: string }[];
  const runSql = db.exec.bind(db);

  const deleteTransaction = db.transaction(() => {
    for (const node of dbNodes) {
      if (!diskFiles.has(node.file_path)) {
        // Delete FTS entry
        const rowInfo = stmts.getNodeRowid.get(node.id) as { rowid: number } | undefined;
        if (rowInfo) {
          stmts.deleteFts.run(rowInfo.rowid);
        }
        // Log before deletion
        stmts.insertEditLog.run(node.id, Date.now(), 'file-deleted', node.file_path);
        // Delete node (cascade handles types, fields, relationships)
        stmts.deleteNode.run(node.id);
        stats.deleted++;
      }
    }
  });
  deleteTransaction();

  // 3. Index files in batches
  const files = Array.from(diskFiles);
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchTransaction = db.transaction(() => {
      for (const relPath of batch) {
        try {
          const absPath = join(vaultPath, relPath);
          const st = statSync(absPath);
          const mtime = Math.floor(st.mtimeMs);

          // Check existing node
          const existing = stmts.getNodeByPath.get(relPath) as
            | { id: string; content_hash: string; file_mtime: number }
            | undefined;

          // Mtime-first change detection
          if (existing && existing.file_mtime === mtime) {
            stats.skipped++;
            continue;
          }

          // Mtime changed — read and hash
          const raw = readFileSync(absPath, 'utf-8');
          const hash = sha256(raw);

          if (existing && existing.content_hash === hash) {
            // Content unchanged — just update mtime
            stmts.updateMtime.run(mtime, existing.id);
            stats.skipped++;
            continue;
          }

          // Full re-index
          const nodeId = doIndex(stmts, raw, relPath, absPath, mtime, hash, existing?.id ?? null);
          options?.onNodeIndexed?.(nodeId);
          stats.indexed++;
        } catch (err) {
          // Log error but don't block batch
          const msg = err instanceof Error ? err.message : String(err);
          stmts.insertEditLog.run(null, Date.now(), 'index-error', `${relPath}: ${msg}`);
          stats.errors++;
        }
      }
    });
    batchTransaction();
  }

  return stats;
}

/**
 * Index a single file (for watcher-driven updates).
 * Always re-reads, hashes, and re-indexes — no mtime check.
 */
export function indexFile(absolutePath: string, vaultPath: string, db: Database.Database, options?: IndexerOptions): string {
  const stmts = prepareStatements(db);
  const relPath = relative(vaultPath, absolutePath);
  const raw = readFileSync(absolutePath, 'utf-8');
  const hash = sha256(raw);
  const st = statSync(absolutePath);
  const mtime = Math.floor(st.mtimeMs);

  const existing = stmts.getNodeByPath.get(relPath) as { id: string } | undefined;

  const txn = db.transaction(() => {
    return doIndex(stmts, raw, relPath, absolutePath, mtime, hash, existing?.id ?? null);
  });

  const nodeId = txn();
  options?.onNodeIndexed?.(nodeId);
  return nodeId;
}

/**
 * Remove a node by its vault-relative file path.
 */
export function deleteNodeByPath(filePath: string, db: Database.Database): boolean {
  const stmts = prepareStatements(db);

  const existing = stmts.getNodeByPath.get(filePath) as { id: string } | undefined;
  if (!existing) return false;

  const txn = db.transaction(() => {
    // Delete FTS entry
    const rowInfo = stmts.getNodeRowid.get(existing.id) as { rowid: number } | undefined;
    if (rowInfo) {
      stmts.deleteFts.run(rowInfo.rowid);
    }
    // Log
    stmts.insertEditLog.run(existing.id, Date.now(), 'file-deleted', filePath);
    // Delete node (cascade)
    stmts.deleteNode.run(existing.id);
  });
  txn();

  return true;
}
