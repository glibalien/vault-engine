import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { watch, type FSWatcher } from 'chokidar';
import { sha256 } from '../indexer/hash.js';
import { shouldIgnore } from '../indexer/ignore.js';
import { indexFile, deleteNodeByPath } from '../indexer/indexer.js';
import { parseMarkdown } from '../parser/parse.js';
import { splitFrontmatter } from '../parser/frontmatter.js';
import { executeMutation } from '../pipeline/execute.js';
import { populateDefaults } from '../pipeline/populate-defaults.js';
import { reconstructValue } from '../pipeline/classify-value.js';
import type { IndexMutex } from './mutex.js';
import type { WriteLockManager } from './write-lock.js';
import type { SyncLogger } from './sync-logger.js';
import type { EmbeddingIndexer } from '../search/indexer.js';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;

export interface WatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
}

interface PendingTimer {
  debounce: ReturnType<typeof setTimeout>;
  maxWait: ReturnType<typeof setTimeout>;
}

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  options?: WatcherOptions,
): FSWatcher {
  const debounceMs = options?.debounceMs ?? 2500;
  const maxWaitMs = options?.maxWaitMs ?? 5000;
  const pendingTimers = new Map<string, PendingTimer>();
  const retryCount = new Map<string, number>();

  // Wire mutex.processEvent to handle queued events during indexing
  mutex.processEvent = async (event) => {
    if (event.type === 'unlink') {
      const relPath = relative(vaultPath, join(vaultPath, event.path));
      deleteNodeByPath(relPath, db);
    } else {
      const absPath = join(vaultPath, event.path);
      processFileChange(absPath, relative(vaultPath, absPath), db, writeLock, vaultPath, syncLogger, embeddingIndexer);
    }
  };

  function scheduleIndex(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Clear existing debounce timer if any
    const existing = pendingTimers.get(absPath);
    if (existing) {
      clearTimeout(existing.debounce);
    }

    const fire = () => {
      const timers = pendingTimers.get(absPath);
      if (timers) {
        clearTimeout(timers.debounce);
        clearTimeout(timers.maxWait);
        pendingTimers.delete(absPath);
      }

      // Check write lock
      if (writeLock.isLocked(absPath)) return;

      // Hash check: skip if content unchanged
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        // File may have been deleted between event and fire
        return;
      }
      const hash = sha256(content);
      syncLogger?.watcherEvent(relPath, hash, content.length);
      const row = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(relPath) as
        | { content_hash: string }
        | undefined;
      if (row && row.content_hash === hash) return;

      // Parse check: if YAML is broken, this may be Obsidian's truncation
      // window (documented bug where growing files are temporarily truncated
      // on disk for 1-2s). Re-enqueue with a retry delay instead of
      // processing garbage.
      const parseCheck = parseMarkdown(content, relPath);
      if (parseCheck.parseError !== null) {
        const retryKey = absPath;
        const retries = (retryCount.get(retryKey) ?? 0) + 1;
        if (retries <= 3) {
          retryCount.set(retryKey, retries);
          syncLogger?.parseRetry(relPath, retries, parseCheck.parseError ?? 'unknown');
          const retryTimer = setTimeout(fire, 2000);
          pendingTimers.set(absPath, { debounce: retryTimer, maxWait: retryTimer });
          return;
        }
        // Max retries exceeded — fall through to processFileChange
        // which will log the parse error and preserve DB state
        retryCount.delete(retryKey);
      } else {
        retryCount.delete(absPath);
      }

      // Process through mutex via write pipeline
      mutex.run(async () => {
        processFileChange(absPath, relPath, db, writeLock, vaultPath, syncLogger, embeddingIndexer);
      });
    };

    const debounceTimer = setTimeout(fire, debounceMs);

    if (existing) {
      // Keep existing maxWait timer, just reset debounce
      pendingTimers.set(absPath, { debounce: debounceTimer, maxWait: existing.maxWait });
    } else {
      // First event for this path: set up max-wait timer too
      const maxWaitTimer = setTimeout(fire, maxWaitMs);
      pendingTimers.set(absPath, { debounce: debounceTimer, maxWait: maxWaitTimer });
    }
  }

  function handleUnlink(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Clear any pending timers for this file
    const timers = pendingTimers.get(absPath);
    if (timers) {
      clearTimeout(timers.debounce);
      clearTimeout(timers.maxWait);
      pendingTimers.delete(absPath);
    }

    if (writeLock.isLocked(absPath)) return;

    if (mutex.isRunning()) {
      mutex.enqueue({ type: 'unlink', path: relPath });
    } else {
      mutex.run(async () => {
        deleteNodeByPath(relPath, db);
      });
    }
  }

  const watcher = watch(vaultPath, {
    ignoreInitial: true,
    ignored: [/(^|[/\\])\./, '**/node_modules/**'],
  });

  watcher.on('add', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    scheduleIndex(filePath);
  });

  watcher.on('change', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    scheduleIndex(filePath);
  });

  watcher.on('unlink', (filePath: string) => {
    const relPath = relative(vaultPath, filePath);
    if (shouldIgnore(relPath)) return;
    handleUnlink(filePath);
  });

  return watcher;
}

/**
 * Process a file change through the Phase 3 write pipeline.
 * Parses the file, diffs against DB state, populates defaults for
 * newly-added types, and calls executeMutation.
 */
export function processFileChange(
  absPath: string,
  relPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    return;
  }

  const parsed = parseMarkdown(content, relPath);

  // Handle parse errors
  if (parsed.parseError !== null) {
    const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined;
    if (existing) {
      // Existing node: preserve DB state, log parse error
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        existing.id,
        Date.now(),
        'parse-error',
        JSON.stringify({
          source: 'watcher',
          file_path: relPath,
          error: parsed.parseError,
          db_state: 'preserved',
        }),
      );
    } else {
      // New file with parse error: create minimal node with body-only
      // (Phase 1 fallback behavior)
      const fallbackNodeId = indexFile(absPath, vaultPath, db);
      embeddingIndexer?.enqueue({ node_id: fallbackNodeId, source_type: 'node' });
      embeddingIndexer?.processOne().catch(() => {});
    }
    return;
  }

  // Convert parsed fields from Map to Record
  const parsedFields: Record<string, unknown> = {};
  for (const [key, value] of parsed.fields) {
    parsedFields[key] = value;
  }

  // Extract raw field texts for wiki-link preservation
  const rawFieldTexts = extractRawFieldTexts(content);

  // Load current DB state for diff
  const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined;
  const nodeId = existing?.id ?? null;

  // Detect type additions and populate defaults
  if (nodeId) {
    const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

    const newTypes = parsed.types.filter(t => !currentTypes.includes(t));
    if (newTypes.length > 0) {
      // Load current fields from DB for default population
      const currentFields: Record<string, unknown> = {};
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }

      // Merge parsed fields on top of current fields (parsed wins)
      const mergedForDefaults = { ...currentFields, ...parsedFields };

      // Populate defaults for the full new type set
      const { defaults } = populateDefaults(db, parsed.types, mergedForDefaults);

      // Add defaults for fields not already in parsed output
      for (const [field, value] of Object.entries(defaults)) {
        if (!(field in parsedFields)) {
          parsedFields[field] = value;
        }
      }
    }
  } else {
    // New file: all types are "newly added"
    const { defaults } = populateDefaults(db, parsed.types, parsedFields);
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in parsedFields)) {
        parsedFields[field] = value;
      }
    }
  }

  const sourceContentHash = sha256(content);

  try {
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: nodeId,
      file_path: relPath,
      title: parsed.title ?? relPath.replace(/\.md$/, ''),
      types: parsed.types,
      fields: parsedFields,
      body: parsed.body,
      raw_field_texts: rawFieldTexts,
      source_content_hash: sourceContentHash,
      db_only: true,
    });

    embeddingIndexer?.enqueue({ node_id: result.node_id, source_type: 'node' });
    embeddingIndexer?.processOne().catch(() => {});
  } catch {
    // Pipeline errors on watcher path are unexpected but shouldn't crash
  }
}

/**
 * Extract raw field texts (pre-wiki-link-stripping) from YAML frontmatter.
 */
function extractRawFieldTexts(raw: string): Record<string, string> {
  const { yaml: yamlStr } = splitFrontmatter(raw);
  if (!yamlStr) return {};

  let rawParsed: unknown;
  try {
    rawParsed = parseYaml(yamlStr, { uniqueKeys: false });
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
