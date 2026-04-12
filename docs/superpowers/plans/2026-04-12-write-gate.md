# Write Gate — Quiet-Period Write Strategy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered per-event conflict guards (cosmetic-skip, stale-file guard, needsFileWrite flag) with a unified WriteGate module that defers file writes until a file has been stable for a quiet period, while always keeping the DB current.

**Architecture:** A new `WriteGate` module tracks per-file activity timestamps and owns all file-write decisions. The pipeline is split into two phases: DB-update (always immediate) and file-write (deferred until the quiet period expires). The watcher debounce increases from 500ms to 2500ms to align with Obsidian's 2s save cycle. Parse failures from Obsidian's truncation window trigger a retry instead of an error.

**Tech Stack:** TypeScript, better-sqlite3, chokidar, vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/sync/write-gate.ts` | Per-file activity tracking, quiet-period timer, write-decision logic |
| Modify | `src/sync/watcher.ts` | Remove cosmetic-skip, increase debounce, add parse-retry, use WriteGate |
| Modify | `src/pipeline/execute.ts` | Remove stale-file guard + needsFileWrite + cosmetic-skip, accept `db_only` flag, return deferred-write callback |
| Modify | `src/pipeline/types.ts` | Add `db_only` field to ProposedMutation, add `DeferredWrite` to PipelineResult |
| Modify | `src/sync/reconciler.ts` | Use WriteGate for file-write decisions |
| Create | `tests/sync/write-gate.test.ts` | Unit tests for WriteGate |
| Modify | `tests/sync/watcher.test.ts` | Update debounce timing, add parse-retry test |
| Modify | `tests/pipeline/execute.test.ts` | Update for db_only mode, remove stale-file guard tests, add new equivalents |

---

## Background: What We're Replacing

The current codebase has **five independent guards** scattered across two files that each make a narrow write-vs-skip decision. This plan consolidates them:

| Current guard | Location | Fate |
|---------------|----------|------|
| **Cosmetic-skip** (title-only) | `watcher.ts:222-229` | **Remove.** WriteGate quiet period handles this — if only cosmetic changes are pending, the deferred write will eventually fire and apply them safely after the file stabilizes. |
| **Stale-file guard** | `execute.ts:220-246` | **Remove.** WriteGate's quiet-period check replaces this. A file that changed since parse time will have a fresh `lastExternalChange` timestamp, so the deferred write won't fire yet. |
| **needsFileWrite flag** | `execute.ts:254-259` | **Remove.** The pipeline always runs db_only on watcher path. WriteGate decides when to write the file separately. |
| **No-op hash check** | `execute.ts:199-218` | **Keep.** This is a cheap optimization that prevents unnecessary DB transactions. It fires before any DB work and is independent of the WriteGate. |
| **Write lock** | `write-lock.ts` | **Keep.** Still needed so the watcher ignores filesystem events from our own writes. |

---

### Task 1: WriteGate Module

**Files:**
- Create: `src/sync/write-gate.ts`
- Test: `tests/sync/write-gate.test.ts`

The WriteGate tracks per-file "last external change" timestamps and manages deferred write timers. When a file's quiet period expires, it fires a callback to render and write the file from current DB state.

- [ ] **Step 1: Write the failing test — basic quiet period**

```typescript
// tests/sync/write-gate.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteGate } from '../../src/sync/write-gate.js';

describe('WriteGate', () => {
  let gate: WriteGate;
  const writeFn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    gate = new WriteGate({ quietPeriodMs: 3000 });
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
  });

  it('fires write callback after quiet period expires', () => {
    gate.fileChanged('note.md', writeFn);

    // Not yet
    vi.advanceTimersByTime(2000);
    expect(writeFn).not.toHaveBeenCalled();

    // Quiet period expires
    vi.advanceTimersByTime(1500);
    expect(writeFn).toHaveBeenCalledWith('note.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/write-gate.test.ts`
Expected: FAIL — cannot resolve `../../src/sync/write-gate.js`

- [ ] **Step 3: Implement WriteGate — core quiet-period logic**

```typescript
// src/sync/write-gate.ts

export interface WriteGateOptions {
  quietPeriodMs?: number;
}

type WriteCallback = (filePath: string) => void;

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  callback: WriteCallback;
}

export class WriteGate {
  private readonly quietPeriodMs: number;
  private pending = new Map<string, PendingWrite>();

  constructor(options?: WriteGateOptions) {
    this.quietPeriodMs = options?.quietPeriodMs ?? 3000;
  }

  /**
   * Record that a file changed externally. Resets the quiet-period timer.
   * When the timer expires, `callback` is called with the file path.
   */
  fileChanged(filePath: string, callback: WriteCallback): void {
    // Cancel any existing timer for this file
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      callback(filePath);
    }, this.quietPeriodMs);

    this.pending.set(filePath, { timer, callback });
  }

  /**
   * Cancel any pending write for a file. Use when the file was deleted
   * or when a tool write supersedes the deferred watcher write.
   */
  cancel(filePath: string): void {
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(filePath);
    }
  }

  /**
   * True if a deferred write is pending for this file.
   */
  isPending(filePath: string): boolean {
    return this.pending.has(filePath);
  }

  /**
   * Clean up all timers.
   */
  dispose(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/write-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test — activity reset extends quiet period**

```typescript
// Add to tests/sync/write-gate.test.ts, inside the describe block

  it('resets quiet period on subsequent changes', () => {
    gate.fileChanged('note.md', writeFn);

    // 2s in, file changes again
    vi.advanceTimersByTime(2000);
    gate.fileChanged('note.md', writeFn);

    // 2s after the SECOND change — not enough
    vi.advanceTimersByTime(2000);
    expect(writeFn).not.toHaveBeenCalled();

    // 3s after the second change — fires
    vi.advanceTimersByTime(1500);
    expect(writeFn).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 6: Run test to verify it passes (already implemented)**

Run: `npx vitest run tests/sync/write-gate.test.ts`
Expected: PASS — the `fileChanged` method already clears the existing timer before setting a new one.

- [ ] **Step 7: Write the failing test — cancel prevents write**

```typescript
  it('cancel prevents the deferred write from firing', () => {
    gate.fileChanged('note.md', writeFn);

    vi.advanceTimersByTime(1000);
    gate.cancel('note.md');

    vi.advanceTimersByTime(5000);
    expect(writeFn).not.toHaveBeenCalled();
  });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/sync/write-gate.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing test — independent files track independently**

```typescript
  it('tracks files independently', () => {
    const writeFn2 = vi.fn();
    gate.fileChanged('a.md', writeFn);
    gate.fileChanged('b.md', writeFn2);

    vi.advanceTimersByTime(3500);

    expect(writeFn).toHaveBeenCalledWith('a.md');
    expect(writeFn2).toHaveBeenCalledWith('b.md');
  });
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run tests/sync/write-gate.test.ts`
Expected: PASS

- [ ] **Step 11: Write the failing test — tool write cancels pending watcher write**

This tests the pattern where a tool write should supersede a deferred watcher write.

```typescript
  it('isPending returns true for files with pending writes', () => {
    expect(gate.isPending('note.md')).toBe(false);
    gate.fileChanged('note.md', writeFn);
    expect(gate.isPending('note.md')).toBe(true);

    vi.advanceTimersByTime(3500);
    expect(gate.isPending('note.md')).toBe(false);
  });
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npx vitest run tests/sync/write-gate.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/sync/write-gate.ts tests/sync/write-gate.test.ts
git commit -m "feat: add WriteGate module for quiet-period file write deferral"
```

---

### Task 2: Split Pipeline Into DB-Update and File-Write Phases

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/pipeline/execute.ts`
- Test: `tests/pipeline/execute.test.ts`

The pipeline currently does DB-update and file-write in a single transaction. We split this so the watcher path can do DB-update immediately and defer the file-write to the WriteGate. The tool path continues to do both immediately (tools don't have the same Obsidian timing issues).

- [ ] **Step 1: Update types — add db_only flag and DeferredWrite**

Add to `src/pipeline/types.ts`:

```typescript
export interface ProposedMutation {
  source: 'tool' | 'watcher';
  node_id: string | null;
  file_path: string;
  title: string;
  types: string[];
  fields: Record<string, unknown>;
  body: string;
  raw_field_texts?: Record<string, string>;
  source_content_hash?: string;
  has_populated_defaults?: boolean;
  title_from_frontmatter?: boolean;
  db_only?: boolean;  // NEW: when true, skip file write, return deferred write info
}

/** Returned when db_only is true and the pipeline would have written the file. */
export interface DeferredWrite {
  file_content: string;
  rendered_hash: string;
}

export interface PipelineResult {
  node_id: string;
  file_path: string;
  validation: ValidationResult;
  rendered_hash: string;
  edits_logged: number;
  file_written: boolean;
  deferred_write?: DeferredWrite;  // NEW: present when db_only=true and write was needed
}
```

- [ ] **Step 2: Run existing tests to verify nothing breaks yet**

Run: `npx vitest run tests/pipeline/execute.test.ts`
Expected: PASS — we only added optional fields, no behavior change yet.

- [ ] **Step 3: Write the failing test — db_only mode updates DB but skips file**

```typescript
// Add to tests/pipeline/execute.test.ts

describe('executeMutation — db_only mode', () => {
  it('updates DB but does not write file when db_only is true', () => {
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      db_only: true,
      body: 'Some content.',
    }));

    expect(result.file_written).toBe(false);
    expect(result.deferred_write).toBeDefined();
    expect(result.deferred_write!.file_content).toContain('Some content.');

    // DB IS populated
    const node = db.prepare('SELECT title, body FROM nodes WHERE id = ?')
      .get(result.node_id) as { title: string; body: string };
    expect(node.title).toBe('Test Node');
    expect(node.body).toBe('Some content.');

    // File does NOT exist on disk
    expect(existsSync(join(vaultPath, 'test-node.md'))).toBe(false);
  });

  it('returns no deferred_write when rendered matches DB hash (no-op)', () => {
    // Create node via tool first
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());

    // Same data via watcher db_only — should be no-op
    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'watcher',
      node_id: created.node_id,
      db_only: true,
    }));

    expect(result.file_written).toBe(false);
    expect(result.deferred_write).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "db_only"`
Expected: FAIL — `deferred_write` is undefined because db_only is not implemented yet.

- [ ] **Step 5: Implement db_only mode in execute.ts**

Modify the Stage 6 section of `executeMutation` in `src/pipeline/execute.ts`. The key change: when `mutation.db_only` is true, skip the `atomicWriteFile` call entirely, but still do all the DB work. Return the rendered content in `deferred_write` so the caller can write it later.

Replace the current Stage 6 block (the `writeLock.withLockSync` call at line 262 through the end of the transaction function) with:

```typescript
    // ── Stage 6: Write (under write lock) ───────────────────────────
    return writeLock.withLockSync(absPath, () => {
      // Generate node_id for new nodes
      const nodeId = mutation.node_id ?? nanoid();
      const now = Date.now();

      // DB-only mode: skip file write, return deferred info
      const shouldWriteFile = !mutation.db_only && needsFileWrite;
      if (shouldWriteFile) {
        atomicWriteFile(absPath, fileContent, tmpDir);
      }

      // When skipping file write, store the source file's hash so the
      // watcher recognizes the unchanged file and doesn't re-trigger.
      const contentHash = shouldWriteFile
        ? renderedHash
        : (mutation.source_content_hash ?? renderedHash);

      // Upsert nodes row
      db.prepare(`
        INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at)
        VALUES (@id, @file_path, @title, @body, @content_hash, @file_mtime, @indexed_at)
        ON CONFLICT(id) DO UPDATE SET
          file_path = @file_path,
          title = @title,
          body = @body,
          content_hash = @content_hash,
          file_mtime = @file_mtime,
          indexed_at = @indexed_at
      `).run({
        id: nodeId,
        file_path: mutation.file_path,
        title: mutation.title,
        body: mutation.body,
        content_hash: contentHash,
        file_mtime: now,
        indexed_at: now,
      });

      // Delete and reinsert node_types
      db.prepare('DELETE FROM node_types WHERE node_id = ?').run(nodeId);
      const insertType = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
      for (const t of mutation.types) {
        insertType.run(nodeId, t);
      }

      // Delete and reinsert node_fields
      db.prepare('DELETE FROM node_fields WHERE node_id = ?').run(nodeId);
      const insertField = db.prepare(`
        INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
        VALUES (@node_id, @field_name, @value_text, @value_number, @value_date, @value_json, @value_raw_text, @source)
      `);
      for (const [fieldName, value] of Object.entries(finalFields)) {
        if (value === null || value === undefined) continue;
        const cols = classifyValue(value);
        const rawText = finalRawFieldTexts[fieldName]
          ?? (mutation.raw_field_texts?.[fieldName] ?? null);
        insertField.run({
          node_id: nodeId,
          field_name: fieldName,
          ...cols,
          value_raw_text: rawText,
          source: 'frontmatter',
        });
      }

      // Delete and reinsert relationships
      db.prepare('DELETE FROM relationships WHERE source_id = ?').run(nodeId);
      const insertRel = db.prepare(
        'INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
      );
      const rels = deriveRelationships(finalFields, mutation.body, globalFields, orphanRawValues);
      for (const rel of rels) {
        insertRel.run(nodeId, rel.target, rel.rel_type, rel.context);
      }

      // Update FTS
      const rowInfo = db.prepare('SELECT rowid FROM nodes WHERE id = ?').get(nodeId) as { rowid: number } | undefined;
      if (rowInfo) {
        db.prepare('DELETE FROM nodes_fts WHERE rowid = ?').run(rowInfo.rowid);
        db.prepare('INSERT INTO nodes_fts (rowid, title, body) VALUES (@rowid, @title, @body)').run({
          rowid: rowInfo.rowid,
          title: mutation.title,
          body: mutation.body,
        });
      }

      // Write edits log entries
      const logEntries = buildDeviationEntries(
        nodeId,
        mutation.source,
        validation.coerced_state,
        validation.issues,
        mutation.types,
        Object.keys(retainedValues).length > 0 ? retainedValues : undefined,
        defaultedFields.length > 0 ? defaultedFields : undefined,
      );
      const editsLogged = writeEditsLogEntries(db, logEntries);

      // Build deferred_write when db_only skipped a file that needed writing
      const deferredWrite = (mutation.db_only && needsFileWrite)
        ? { file_content: fileContent, rendered_hash: renderedHash }
        : undefined;

      return {
        node_id: nodeId,
        file_path: mutation.file_path,
        validation,
        rendered_hash: contentHash,
        edits_logged: editsLogged,
        file_written: shouldWriteFile,
        deferred_write: deferredWrite,
      };
    });
```

Also update the `DeferredWrite` import at the top and the return type handling after the transaction.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/pipeline/execute.test.ts -t "db_only"`
Expected: PASS

- [ ] **Step 7: Run full pipeline test suite to verify no regressions**

Run: `npx vitest run tests/pipeline/execute.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/execute.ts tests/pipeline/execute.test.ts
git commit -m "feat: add db_only mode to pipeline for deferred file writes"
```

---

### Task 3: Remove Stale-File Guard and Cosmetic-Skip From Pipeline

**Files:**
- Modify: `src/pipeline/execute.ts`
- Modify: `tests/pipeline/execute.test.ts`

Now that the watcher will use `db_only` + WriteGate, the stale-file guard and the `needsFileWrite` cosmetic-skip logic in execute.ts are no longer needed on the watcher path. The WriteGate handles these concerns externally. We remove them to simplify the pipeline.

**Important:** The no-op hash check (lines 199-218) stays. It's a cheap optimization that prevents unnecessary DB work when nothing changed at all.

- [ ] **Step 1: Remove stale-file guard from execute.ts**

Delete lines 220-246 of `src/pipeline/execute.ts` (the `// Stale-file guard` block). This block checks `mutation.source_content_hash` against the current file and returns early with `_stale: true`. With the WriteGate, the watcher path uses `db_only: true`, so the pipeline never writes the file directly — the stale-file scenario is handled by the WriteGate's quiet period instead.

- [ ] **Step 2: Simplify needsFileWrite — remove watcher-specific cosmetic checks**

Replace the current `needsFileWrite` computation (lines 254-259) with:

```typescript
    const needsFileWrite = !mutation.db_only;
```

The old logic (`mutation.source !== 'watcher' || defaultedFields.length > 0 || ...`) was the pipeline trying to decide whether the watcher should write. That decision now belongs to the WriteGate. The pipeline's job is simple: if `db_only` is false (tool path), write the file. If `db_only` is true (watcher path), don't.

- [ ] **Step 3: Remove source_content_hash from ProposedMutation**

In `src/pipeline/types.ts`, remove the `source_content_hash` field from `ProposedMutation`. It was only used by the stale-file guard and the content_hash fallback. Update the content_hash computation in Stage 6:

```typescript
      const contentHash = shouldWriteFile ? renderedHash : renderedHash;
```

Wait — we still need the source hash for the DB `content_hash` column when we skip writing. When `db_only` is true, the DB should store the *source file's* hash (so the watcher recognizes the file hasn't changed). So keep `source_content_hash` in ProposedMutation but only for this purpose:

```typescript
      const contentHash = shouldWriteFile
        ? renderedHash
        : (mutation.source_content_hash ?? renderedHash);
```

This stays as-is. **Do not remove `source_content_hash`** — it serves the DB hash storage purpose.

- [ ] **Step 4: Remove the `_stale` handling after the transaction**

In the post-transaction handling (lines 373-384), remove the `_stale` check. The `_noop` check can stay since the no-op hash check is still present.

Replace:
```typescript
  if ((result as PipelineResult & { _noop?: boolean })._noop ||
      (result as PipelineResult & { _stale?: boolean })._stale) {
```

With:
```typescript
  if ((result as PipelineResult & { _noop?: boolean })._noop) {
```

- [ ] **Step 5: Update stale-file guard tests**

In `tests/pipeline/execute.test.ts`, the `executeMutation — stale-file guard` describe block has three tests. Update them:

- **"aborts write when file changed since parsing"**: Remove this test entirely. The stale-file scenario is now handled by the WriteGate, not the pipeline.
- **"proceeds past stale guard when source_content_hash matches"**: Remove this test. The guard no longer exists.
- **"tool path ignores source_content_hash"**: Keep this test but simplify — it just verifies tool path always writes.

Replace the entire `describe('executeMutation — stale-file guard')` block with:

```typescript
describe('executeMutation — tool path always writes file', () => {
  it('tool path writes file regardless of prior state', () => {
    const created = executeMutation(db, writeLock, vaultPath, makeMutation());

    const result = executeMutation(db, writeLock, vaultPath, makeMutation({
      source: 'tool',
      node_id: created.node_id,
      body: 'Updated via tool.',
    }));

    expect(result.file_written).toBe(true);
  });
});
```

- [ ] **Step 6: Update watcher path tests for db_only**

In the `executeMutation — watcher path` describe block, update the existing tests. The watcher path now always uses `db_only: true`, so tests need to reflect that file writes come from the deferred callback, not from the pipeline directly.

Update **"watcher absorbs valid edit"** — this test already expects `file_written: false`, just add `db_only: true` to the mutation and verify `deferred_write` is undefined (no substantive changes).

Update **"watcher skips file write when no substantive changes"** — add `db_only: true`, expect `deferred_write` to be undefined.

Update **"watcher writes file when defaults are added"** — add `db_only: true`, expect `deferred_write` to be defined with content containing the defaults. The file is NOT written by the pipeline; the test verifies the deferred_write content instead.

Update **"watcher writes file when values are coerced"** — same pattern: `db_only: true`, check `deferred_write`.

Update **"watcher retains DB value for rejected field"** — add `db_only: true`, check `deferred_write` contains the retained value.

- [ ] **Step 7: Run full pipeline test suite**

Run: `npx vitest run tests/pipeline/execute.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/execute.ts src/pipeline/types.ts tests/pipeline/execute.test.ts
git commit -m "refactor: remove stale-file guard and cosmetic-skip from pipeline

WriteGate now owns file-write timing decisions. Pipeline's job is
DB-update (always) and file-write (only when db_only is false).
Keeps no-op hash check as a DB-level optimization."
```

---

### Task 4: Add Parse-Retry to Watcher

**Files:**
- Modify: `src/sync/watcher.ts`
- Modify: `tests/sync/watcher.test.ts`

Obsidian has a documented bug where writing a file that grows in size causes a 1-2 second window where the on-disk content is truncated. If the watcher reads during this window, YAML parsing fails. Instead of logging a parse error and preserving stale DB state, we retry after a short delay.

- [ ] **Step 1: Write the failing test — parse retry on YAML failure**

```typescript
// Add to tests/sync/watcher.test.ts, in a new describe block

describe('processFileChange — parse retry', () => {
  let vaultPath: string;
  let dbPath: string;
  let db: Database.Database;
  let writeLock: WriteLockManager;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-retry-test-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    dbPath = join(vaultPath, '.vault-engine', 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('retries when file content is truncated (parse error on first read)', () => {
    const filePath = join(vaultPath, 'note.md');

    // First write: truncated content (simulates Obsidian mid-write)
    writeFileSync(filePath, '---\ntitle: No', 'utf-8');
    fullIndex(vaultPath, db);

    // Now write valid content (simulates Obsidian finishing the write)
    writeFileSync(filePath, '---\ntitle: Note Title\n---\nBody text.\n', 'utf-8');

    // Process the valid file — should succeed
    processFileChange(filePath, 'note.md', db, writeLock, vaultPath);

    const node = db.prepare("SELECT title FROM nodes WHERE file_path = 'note.md'")
      .get() as { title: string } | undefined;
    expect(node?.title).toBe('Note Title');
  });
});
```

Note: The full retry mechanism involves the watcher re-enqueueing the file, which we test at the integration level. The unit test above verifies that `processFileChange` handles the happy path after a retry.

- [ ] **Step 2: Run test to verify it passes (already works)**

Run: `npx vitest run tests/sync/watcher.test.ts -t "parse retry"`
Expected: PASS — this test just verifies processFileChange works with valid content. The actual retry logic is in the watcher's `scheduleIndex` and we test it at integration level.

- [ ] **Step 3: Add retry logic to watcher's fire function**

In `src/sync/watcher.ts`, modify the `fire` function inside `scheduleIndex`. After reading the file content, if `parseMarkdown` returns a `parseError`, instead of immediately processing (which logs the error and preserves stale DB state), re-enqueue the file with a 2-second delay:

```typescript
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
        return;
      }
      const hash = sha256(content);
      const row = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(relPath) as
        | { content_hash: string }
        | undefined;
      if (row && row.content_hash === hash) return;

      // Parse check: if YAML is broken, this may be Obsidian's truncation
      // window. Re-enqueue with a retry delay instead of processing garbage.
      const parseCheck = parseMarkdown(content, relPath);
      if (parseCheck.parseError !== null) {
        const retryKey = `${absPath}:retries`;
        const retries = (retryCount.get(retryKey) ?? 0) + 1;
        if (retries <= 3) {
          retryCount.set(retryKey, retries);
          const retryTimer = setTimeout(fire, 2000);
          pendingTimers.set(absPath, {
            debounce: retryTimer,
            maxWait: retryTimer,
          });
          return;
        }
        // Max retries exceeded — fall through to processFileChange
        // which will log the parse error and preserve DB state
        retryCount.delete(retryKey);
      } else {
        retryCount.delete(`${absPath}:retries`);
      }

      // Process through mutex via write pipeline
      mutex.run(async () => {
        processFileChange(absPath, relPath, db, writeLock, vaultPath);
      });
    };
```

Add a `retryCount` map at the top of `startWatcher`:

```typescript
  const retryCount = new Map<string, number>();
```

- [ ] **Step 4: Run full watcher test suite**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/watcher.ts tests/sync/watcher.test.ts
git commit -m "feat: add parse-retry to watcher for Obsidian truncation window

When YAML parsing fails, retry up to 3 times with 2s delay before
falling back to parse-error logging. Handles Obsidian's documented
bug where growing files are temporarily truncated on disk."
```

---

### Task 5: Wire WriteGate Into Watcher

**Files:**
- Modify: `src/sync/watcher.ts`
- Modify: `tests/sync/watcher.test.ts`

This is the main integration task. The watcher switches from calling `executeMutation` with file-write capability to calling it with `db_only: true`, then using the WriteGate to defer the file write.

- [ ] **Step 1: Remove cosmetic-skip from processFileChange**

Delete lines 222-229 of `src/sync/watcher.ts` (the `if (!parsed.titleFromFrontmatter)` cosmetic-skip block). This was preventing the pipeline from running at all for cosmetic-only changes. With the new approach, the pipeline always runs (to keep DB current), and the WriteGate decides when to write.

- [ ] **Step 2: Update watcher to accept and use WriteGate**

Modify `startWatcher` signature to accept a `WriteGate`:

```typescript
import { WriteGate } from './write-gate.js';

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock: WriteLockManager,
  writeGate: WriteGate,
  options?: WatcherOptions,
): FSWatcher {
```

- [ ] **Step 3: Update processFileChange to use db_only + WriteGate callback**

Modify `processFileChange` to accept a `WriteGate` parameter and use `db_only: true`:

```typescript
export function processFileChange(
  absPath: string,
  relPath: string,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  writeGate?: WriteGate,
): void {
```

Replace the `executeMutation` call at the end of `processFileChange` (lines 269-286):

```typescript
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
      has_populated_defaults: hasPopulatedDefaults,
      title_from_frontmatter: parsed.titleFromFrontmatter,
      db_only: writeGate !== undefined,
    });

    // If the pipeline produced a deferred write, hand it to the WriteGate
    if (result.deferred_write && writeGate) {
      writeGate.fileChanged(relPath, () => {
        // Re-render from current DB state at write time (not the stale
        // rendered content from parse time). This is the key insight:
        // by the time the quiet period expires, the DB may have been
        // updated again. We want the latest state.
        try {
          executeMutation(db, writeLock, vaultPath, {
            source: 'watcher',
            node_id: result.node_id,
            file_path: relPath,
            title: (db.prepare('SELECT title FROM nodes WHERE id = ?')
              .get(result.node_id) as { title: string }).title,
            types: (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
              .all(result.node_id) as { schema_type: string }[]).map(r => r.schema_type),
            fields: rebuildFieldsFromDb(db, result.node_id),
            body: (db.prepare('SELECT body FROM nodes WHERE id = ?')
              .get(result.node_id) as { body: string }).body,
            raw_field_texts: rebuildRawTextsFromDb(db, result.node_id),
            db_only: false,  // Actually write this time
          });
        } catch {
          // Write failed — file may have been deleted, node removed, etc.
          // Safe to ignore; reconciler will catch inconsistencies.
        }
      });
    }
  } catch {
    // Pipeline errors on watcher path are unexpected but shouldn't crash
  }
```

- [ ] **Step 4: Add helper functions to rebuild state from DB**

Add these at the bottom of `src/sync/watcher.ts`:

```typescript
function rebuildFieldsFromDb(db: Database.Database, nodeId: string): Record<string, unknown> {
  const rows = db.prepare(
    'SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?'
  ).all(nodeId) as Array<{
    field_name: string;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    value_json: string | null;
  }>;

  const fields: Record<string, unknown> = {};
  for (const row of rows) {
    fields[row.field_name] = reconstructValue(row);
  }
  return fields;
}

function rebuildRawTextsFromDb(db: Database.Database, nodeId: string): Record<string, string> {
  const rows = db.prepare(
    'SELECT field_name, value_raw_text FROM node_fields WHERE node_id = ? AND value_raw_text IS NOT NULL'
  ).all(nodeId) as Array<{ field_name: string; value_raw_text: string }>;

  const texts: Record<string, string> = {};
  for (const row of rows) {
    texts[row.field_name] = row.value_raw_text;
  }
  return texts;
}
```

- [ ] **Step 5: Update watcher call sites — mutex.processEvent and scheduleIndex**

Update the `mutex.processEvent` handler to pass `writeGate`:

```typescript
  mutex.processEvent = async (event) => {
    if (event.type === 'unlink') {
      const relPath = relative(vaultPath, join(vaultPath, event.path));
      deleteNodeByPath(relPath, db);
    } else {
      const absPath = join(vaultPath, event.path);
      processFileChange(absPath, relative(vaultPath, absPath), db, writeLock, vaultPath, writeGate);
    }
  };
```

Update the `fire` function's `mutex.run` call:

```typescript
      mutex.run(async () => {
        processFileChange(absPath, relPath, db, writeLock, vaultPath, writeGate);
      });
```

- [ ] **Step 6: Cancel pending writes on file deletion**

In the `handleUnlink` function, cancel any pending WriteGate timer:

```typescript
  function handleUnlink(absPath: string): void {
    const relPath = relative(vaultPath, absPath);

    // Cancel any pending deferred write
    writeGate.cancel(relPath);

    // Clear any pending timers for this file
    // ... (rest unchanged)
  }
```

- [ ] **Step 7: Increase debounce from 500ms to 2500ms**

Change the default debounce:

```typescript
  const debounceMs = options?.debounceMs ?? 2500;
```

Keep `maxWaitMs` at 5000ms — this ensures files are processed within 5s even under sustained editing.

- [ ] **Step 8: Update watcher tests**

Update `tests/sync/watcher.test.ts`:

1. Update `DEBOUNCE_MS` from 50 to 100 (tests use fast timers anyway)
2. Update `beforeEach` to create a `WriteGate` and pass it to `startWatcher`
3. Update the cosmetic-skip tests — the cosmetic-skip in `processFileChange` is gone, but the WriteGate defers the write instead. Verify DB is updated immediately, file write is deferred.

```typescript
import { WriteGate } from '../../src/sync/write-gate.js';

// In beforeEach:
    const writeGate = new WriteGate({ quietPeriodMs: 50 }); // fast for tests
    watcher = startWatcher(vaultPath, db, mutex, writeLock, writeGate, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
    });
```

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
git add src/sync/watcher.ts tests/sync/watcher.test.ts
git commit -m "feat: wire WriteGate into watcher, remove cosmetic-skip

Watcher now uses db_only mode for all mutations. File writes are
deferred to the WriteGate's quiet period. Deferred writes re-render
from current DB state, not stale parse-time state. Debounce
increased from 500ms to 2500ms to match Obsidian's save cycle."
```

---

### Task 6: Update Reconciler to Use WriteGate

**Files:**
- Modify: `src/sync/reconciler.ts`

The reconciler calls `processFileChange` directly. Update it to pass the WriteGate so reconciler-triggered writes also get deferred.

- [ ] **Step 1: Update reconciler to accept WriteGate**

```typescript
import type { WriteGate } from './write-gate.js';

export function startReconciler(
  vaultPath: string,
  db: Database.Database,
  mutex: IndexMutex,
  writeLock?: WriteLockManager,
  writeGate?: WriteGate,
  options?: ReconcilerOptions,
): { stop: () => void } {
```

Update the `processFileChange` call inside `sweep`:

```typescript
          if (writeLock) {
            processFileChange(absPath, relPath, db, writeLock, vaultPath, writeGate);
          }
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/sync/reconciler.ts
git commit -m "refactor: pass WriteGate through reconciler to processFileChange"
```

---

### Task 7: Update Service Entrypoint and Tool Write Path

**Files:**
- Modify: `src/index.ts` (or wherever the service wires up watcher + reconciler)

The WriteGate needs to be instantiated at startup and passed to both the watcher and reconciler. Tool writes should cancel any pending WriteGate timer for the same file (tool writes are authoritative and immediate).

- [ ] **Step 1: Find and read the service entrypoint**

Read `src/index.ts` to understand how the watcher and reconciler are started.

- [ ] **Step 2: Instantiate WriteGate at startup**

```typescript
import { WriteGate } from './sync/write-gate.js';

const writeGate = new WriteGate({ quietPeriodMs: 3000 });
```

Pass it to `startWatcher` and `startReconciler`.

- [ ] **Step 3: Wire tool writes to cancel pending WriteGate timers**

In tool handlers that call `executeMutation` directly (the MCP tool implementations), after a successful mutation, cancel any pending WriteGate timer for that file:

```typescript
// After executeMutation succeeds on tool path:
writeGate.cancel(mutation.file_path);
```

This prevents a stale deferred watcher write from overwriting a fresh tool write. The watcher will see the tool's file write, hash-check it, and skip re-processing.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Manual integration test**

Run: `npm run dev`

1. Create a node via MCP tool — file should appear immediately
2. Edit the file in a text editor — DB should update within ~2.5s (debounce), file write deferred ~3s more
3. Rapidly edit the file 5 times — DB updates after each debounce, but file write fires once after the last edit + quiet period
4. Check edits_log for normal operation (no stale-file-skipped entries since that guard is gone)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: instantiate WriteGate at startup, cancel on tool writes"
```

---

### Task 8: Clean Up Dead Code and Update CLAUDE.md

**Files:**
- Modify: `src/pipeline/execute.ts` — remove `_stale` type annotations and dead branches
- Modify: `CLAUDE.md` — update conventions section

- [ ] **Step 1: Remove _stale type annotations from execute.ts**

The `_stale` property on PipelineResult was only used by the stale-file guard. Clean up any remaining references.

- [ ] **Step 2: Update CLAUDE.md conventions**

Replace the existing watcher-related conventions with:

```markdown
- **WriteGate quiet period**: the watcher does NOT write files immediately. It updates the DB on every change, then defers file writes until the file has been stable for 3 seconds (quiet period). This prevents clobbering Obsidian mid-edit and handles the truncation window. Tool writes are immediate and cancel any pending deferred write.
- **Watcher debounce**: 2.5 seconds (matches Obsidian's 2s save cycle). Max-wait 5 seconds.
- **Parse retry**: if YAML parsing fails (e.g. Obsidian truncation bug), the watcher retries up to 3 times with 2s delay before logging a parse error.
```

Remove the old conventions:
- "Watcher write-skip" convention
- "Watcher cosmetic-skip" convention

- [ ] **Step 3: Run full test suite one final time**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/execute.ts CLAUDE.md
git commit -m "chore: clean up dead code, update CLAUDE.md conventions

Remove _stale type annotations and dead branches. Update watcher
conventions to document WriteGate quiet-period approach."
```

---

## Summary of Changes

### Added
- `src/sync/write-gate.ts` — WriteGate module (per-file activity tracking + quiet-period timers)
- `tests/sync/write-gate.test.ts` — WriteGate unit tests
- Parse-retry logic in watcher (handles Obsidian truncation window)
- `db_only` mode in pipeline (DB-update without file-write)
- `DeferredWrite` in pipeline results

### Removed
- Cosmetic-skip in `watcher.ts:222-229` (replaced by WriteGate)
- Stale-file guard in `execute.ts:220-246` (replaced by WriteGate)
- `needsFileWrite` watcher-specific logic in `execute.ts:254-259` (replaced by `db_only` flag)
- `_stale` return path in pipeline

### Changed
- Watcher debounce: 500ms → 2500ms
- `startWatcher` and `startReconciler` accept `WriteGate` parameter
- `processFileChange` uses `db_only: true` when WriteGate is provided
- Deferred writes re-render from current DB state (not stale parse-time state)
- Tool writes cancel pending deferred writes for the same file
