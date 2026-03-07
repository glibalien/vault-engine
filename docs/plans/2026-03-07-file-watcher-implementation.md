# File Watcher Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Watch a vault directory for `.md` file changes and keep the SQLite index in sync via per-file indexing.

**Architecture:** Chokidar v5 watches the vault with `ignoreInitial: true` (initial indexing is handled by `incrementalIndex`/`rebuildIndex`). Each `add`/`change`/`unlink` event is debounced per-file (300ms default), then routed to the existing `indexFile`/`deleteFile` functions. A write-lock `Set` is stubbed for Phase 3 loop prevention.

**Tech Stack:** chokidar v5, better-sqlite3, vitest

---

### Task 1: Write lock functions

**Files:**
- Create: `src/sync/watcher.ts`
- Create: `tests/sync/watcher.test.ts`

**Step 1: Write the failing tests**

In `tests/sync/watcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { acquireWriteLock, releaseWriteLock, isWriteLocked } from '../../src/sync/watcher.js';

describe('write lock', () => {
  afterEach(() => {
    releaseWriteLock('test.md');
  });

  it('isWriteLocked returns false for unlocked path', () => {
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('isWriteLocked returns true after acquireWriteLock', () => {
    acquireWriteLock('test.md');
    expect(isWriteLocked('test.md')).toBe(true);
  });

  it('isWriteLocked returns false after releaseWriteLock', () => {
    acquireWriteLock('test.md');
    releaseWriteLock('test.md');
    expect(isWriteLocked('test.md')).toBe(false);
  });

  it('releaseWriteLock is a no-op for unlocked path', () => {
    expect(() => releaseWriteLock('nonexistent.md')).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: FAIL — module `../../src/sync/watcher.js` does not exist.

**Step 3: Write minimal implementation**

In `src/sync/watcher.ts`:

```typescript
const writeLocks = new Set<string>();

export function acquireWriteLock(relativePath: string): void {
  writeLocks.add(relativePath);
}

export function releaseWriteLock(relativePath: string): void {
  writeLocks.delete(relativePath);
}

export function isWriteLocked(relativePath: string): boolean {
  return writeLocks.has(relativePath);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/sync/watcher.ts tests/sync/watcher.test.ts
git commit -m "add write lock functions for file watcher"
```

---

### Task 2: Watcher indexes new files

**Files:**
- Modify: `src/sync/watcher.ts`
- Modify: `tests/sync/watcher.test.ts`

**Step 1: Write the failing test**

Add to `tests/sync/watcher.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { watchVault } from '../../src/sync/watcher.js';

// Helper: poll a condition until it's true or timeout
function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('watchVault', () => {
  let db: Database.Database;
  let tmpVault: string;
  let handle: { close(): Promise<void>; ready: Promise<void> } | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    tmpVault = mkdtempSync(join(tmpdir(), 'vault-watch-'));
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it('indexes a new .md file', async () => {
    handle = watchVault(db, tmpVault);
    await handle.ready;

    writeFileSync(join(tmpVault, 'test.md'), '# Hello\nWorld.');

    await waitFor(() =>
      db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') !== undefined,
    );

    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') as any;
    expect(node).toBeDefined();
    expect(node.content_text).toContain('Hello');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: FAIL — `watchVault` is not exported / does not exist.

**Step 3: Implement watchVault with add handler**

Add to `src/sync/watcher.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { parseFile } from '../parser/index.js';
import { indexFile } from './indexer.js';

export interface WatcherOptions {
  debounceMs?: number;
  ignorePaths?: string[];
}

export function watchVault(
  db: Database.Database,
  vaultPath: string,
  opts?: WatcherOptions,
): { close(): Promise<void>; ready: Promise<void> } {
  const debounceMs = opts?.debounceMs ?? 300;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const ignored: (string | RegExp)[] = [
    '**/node_modules/**',
    '**/.git/**',
    ...(opts?.ignorePaths ?? []),
  ];

  const watcher: FSWatcher = watch(vaultPath, {
    ignoreInitial: true,
    ignored: [
      ...ignored,
      // Only watch .md files — ignore everything else
      (path: string, stats?: import('node:fs').Stats) => {
        if (stats?.isDirectory()) return false;
        return !path.endsWith('.md');
      },
    ],
  });

  function debounced(relPath: string, action: () => void): void {
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        action();
      }, debounceMs),
    );
  }

  function handleAddOrChange(absPath: string): void {
    const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
    if (isWriteLocked(rel)) return;

    debounced(rel, () => {
      try {
        const raw = readFileSync(absPath, 'utf-8');
        const mtime = statSync(absPath).mtime.toISOString();
        const parsed = parseFile(rel, raw);
        indexFile(db, parsed, rel, mtime, raw);
      } catch (err) {
        console.error(`[vault-engine] failed to index ${rel}:`, err);
      }
    });
  }

  watcher.on('add', handleAddOrChange);
  watcher.on('change', handleAddOrChange);

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', resolve);
  });

  return {
    ready,
    close: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      return watcher.close();
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sync/watcher.ts tests/sync/watcher.test.ts
git commit -m "add watchVault with add event handling"
```

---

### Task 3: Watcher updates DB on file change

**Files:**
- Modify: `tests/sync/watcher.test.ts`

**Step 1: Write the failing test**

Add to the `watchVault` describe block:

```typescript
it('updates DB when a .md file is modified', async () => {
  writeFileSync(join(tmpVault, 'test.md'), '# Original');

  handle = watchVault(db, tmpVault);
  await handle.ready;

  // Wait for initial add to be processed
  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') !== undefined,
  );

  writeFileSync(join(tmpVault, 'test.md'), '# Updated\nNew content.');

  await waitFor(() => {
    const node = db.prepare('SELECT content_text FROM nodes WHERE id = ?').get('test.md') as any;
    return node?.content_text?.includes('Updated');
  });

  const node = db.prepare('SELECT content_text FROM nodes WHERE id = ?').get('test.md') as any;
  expect(node.content_text).toContain('Updated');
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS — the `change` handler is already wired in Task 2. If it fails, investigate.

**Step 3: Commit**

```bash
git add tests/sync/watcher.test.ts
git commit -m "add test for watcher change event"
```

---

### Task 4: Watcher removes DB entries on file delete

**Files:**
- Modify: `src/sync/watcher.ts`
- Modify: `tests/sync/watcher.test.ts`

**Step 1: Write the failing test**

Add to the `watchVault` describe block:

```typescript
import { unlinkSync } from 'fs';

// ... inside describe('watchVault')

it('removes node from DB when .md file is deleted', async () => {
  writeFileSync(join(tmpVault, 'test.md'), '# ToDelete');

  handle = watchVault(db, tmpVault);
  await handle.ready;

  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') !== undefined,
  );

  unlinkSync(join(tmpVault, 'test.md'));

  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md') === undefined,
  );

  expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('test.md')).toBeUndefined();
  expect(db.prepare('SELECT * FROM files WHERE path = ?').get('test.md')).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: FAIL — `unlink` handler not yet wired.

**Step 3: Add unlink handler to watchVault**

Add to `src/sync/watcher.ts`, inside `watchVault`, after the `change` listener. Also add the `deleteFile` import:

```typescript
import { indexFile, deleteFile } from './indexer.js';

// ... inside watchVault, after watcher.on('change', ...)

watcher.on('unlink', (absPath: string) => {
  const rel = relative(vaultPath, absPath).replaceAll('\\', '/');
  if (isWriteLocked(rel)) return;

  debounced(rel, () => {
    try {
      deleteFile(db, rel);
    } catch (err) {
      console.error(`[vault-engine] failed to delete ${rel}:`, err);
    }
  });
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sync/watcher.ts tests/sync/watcher.test.ts
git commit -m "add watcher unlink event handling"
```

---

### Task 5: Watcher ignores non-.md files

**Files:**
- Modify: `tests/sync/watcher.test.ts`

**Step 1: Write the test**

```typescript
it('ignores non-.md files', async () => {
  handle = watchVault(db, tmpVault);
  await handle.ready;

  writeFileSync(join(tmpVault, 'readme.txt'), 'Not markdown.');
  writeFileSync(join(tmpVault, 'data.json'), '{}');
  writeFileSync(join(tmpVault, 'real.md'), '# Real');

  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('real.md') !== undefined,
  );

  // Give extra time for any stray events
  await new Promise((r) => setTimeout(r, 200));

  const allNodes = db.prepare('SELECT id FROM nodes').all() as any[];
  expect(allNodes).toHaveLength(1);
  expect(allNodes[0].id).toBe('real.md');
});
```

**Step 2: Run test — should already pass**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS — the `ignored` filter in Task 2 already excludes non-.md files.

**Step 3: Commit**

```bash
git add tests/sync/watcher.test.ts
git commit -m "add test for watcher ignoring non-md files"
```

---

### Task 6: Write lock prevents re-indexing

**Files:**
- Modify: `tests/sync/watcher.test.ts`

**Step 1: Write the test**

```typescript
it('skips indexing when path has active write lock', async () => {
  handle = watchVault(db, tmpVault);
  await handle.ready;

  acquireWriteLock('locked.md');
  writeFileSync(join(tmpVault, 'locked.md'), '# Locked');

  // Write an unlocked file to prove the watcher is working
  writeFileSync(join(tmpVault, 'unlocked.md'), '# Unlocked');

  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('unlocked.md') !== undefined,
  );

  // Give extra time for any stray events
  await new Promise((r) => setTimeout(r, 200));

  expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('locked.md')).toBeUndefined();

  releaseWriteLock('locked.md');
});
```

**Step 2: Run test — should already pass**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS — write lock check was added in Task 2's implementation.

**Step 3: Commit**

```bash
git add tests/sync/watcher.test.ts
git commit -m "add test for write lock preventing re-indexing"
```

---

### Task 7: Watcher handles subdirectories

**Files:**
- Modify: `tests/sync/watcher.test.ts`

**Step 1: Write the test**

```typescript
it('indexes files in subdirectories', async () => {
  handle = watchVault(db, tmpVault);
  await handle.ready;

  mkdirSync(join(tmpVault, 'notes'), { recursive: true });
  writeFileSync(join(tmpVault, 'notes/deep.md'), '# Deep Note');

  await waitFor(() =>
    db.prepare('SELECT * FROM nodes WHERE id = ?').get('notes/deep.md') !== undefined,
  );

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get('notes/deep.md') as any;
  expect(node).toBeDefined();
  expect(node.file_path).toBe('notes/deep.md');
});
```

**Step 2: Run test — should already pass**

Run: `npx vitest run tests/sync/watcher.test.ts`
Expected: PASS — chokidar watches recursively by default.

**Step 3: Commit**

```bash
git add tests/sync/watcher.test.ts
git commit -m "add test for watcher handling subdirectories"
```

---

### Task 8: Module exports and docs

**Files:**
- Modify: `src/sync/index.ts`
- Modify: `CLAUDE.md`

**Step 1: Update sync module exports**

In `src/sync/index.ts`, add:

```typescript
export { watchVault, acquireWriteLock, releaseWriteLock, isWriteLocked } from './watcher.js';
export type { WatcherOptions } from './watcher.js';
```

**Step 2: Update CLAUDE.md**

Add watcher documentation to the Sync Layer section:

```markdown
- **`watcher.ts`** — `watchVault(db, vaultPath, opts?)` creates a chokidar watcher on the vault directory. Returns `{ close(), ready }`. Watches only `.md` files with `ignoreInitial: true`. Per-file debounce (default 300ms) prevents double-indexing on rapid saves. `add`/`change` events trigger `parseFile` + `indexFile`; `unlink` triggers `deleteFile`. Write lock functions (`acquireWriteLock`/`releaseWriteLock`/`isWriteLocked`) allow Phase 3 serializer to prevent re-indexing of engine-written files.
```

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/sync/index.ts CLAUDE.md
git commit -m "update sync module exports and CLAUDE.md with file watcher docs"
```
