# Tool Surface Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the MCP tool surface so callers reason about content and identity (title, types, fields, body) while the engine owns layout (directory, filename). Enforce the invariant that title and filename always match.

**Architecture:** Six changes across three tool files (`create-node.ts`, `rename-node.ts`, `update-node.ts`) plus a shared validation helper. Each change is independently testable. The rename logic in `rename-node.ts` becomes the single source of truth for file-path derivation, and `update-node` `set_title` delegates to it.

**Tech Stack:** TypeScript, Zod, better-sqlite3, vitest

**Spec:** `Notes/Vault Engine - Tool Surface Tightening Spec.md` in vault

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/mcp/tools/title-warnings.ts` | Create | Shared: `checkTitleSafety()` and `checkBodyFrontmatter()` helpers |
| `src/mcp/tools/rename-node.ts` | Modify | Rename `new_path` → `directory`, add `.md` rejection, default to schema `default_directory` |
| `src/mcp/tools/create-node.ts` | Modify | Rename `path` → `directory`, add `override_default_directory` gate, add title/body warnings |
| `src/mcp/tools/update-node.ts` | Modify | Wire `set_title` to rename logic, rename `set_path` → `set_directory` in query mode, add `.md` rejection |
| `tests/mcp/tool-surface-tightening.test.ts` | Create | All tests for this spec |

---

### Task 1: Shared warning helpers (`title-warnings.ts`)

**Files:**
- Create: `src/mcp/tools/title-warnings.ts`
- Create: `tests/mcp/tool-surface-tightening.test.ts`

- [ ] **Step 1: Write the failing tests for `checkTitleSafety`**

```typescript
// tests/mcp/tool-surface-tightening.test.ts
import { describe, it, expect } from 'vitest';
import { checkTitleSafety, checkBodyFrontmatter } from '../../src/mcp/tools/title-warnings.js';

describe('checkTitleSafety', () => {
  it('returns no issues for clean titles', () => {
    expect(checkTitleSafety('My Normal Title')).toEqual([]);
  });

  it('flags parentheses', () => {
    const issues = checkTitleSafety('Something (with parens)');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('TITLE_WIKILINK_UNSAFE');
    expect(issues[0].characters).toContain('(');
    expect(issues[0].characters).toContain(')');
  });

  it('flags brackets', () => {
    const issues = checkTitleSafety('Has [brackets]');
    expect(issues[0].characters).toContain('[');
    expect(issues[0].characters).toContain(']');
  });

  it('flags pipe, hash, caret', () => {
    const issues = checkTitleSafety('A | B # C ^ D');
    expect(issues[0].characters).toEqual(expect.arrayContaining(['|', '#', '^']));
  });

  it('returns empty for titles with safe special chars like dashes and apostrophes', () => {
    expect(checkTitleSafety("It's a well-formed — title")).toEqual([]);
  });
});

describe('checkBodyFrontmatter', () => {
  it('returns no issue for normal body', () => {
    expect(checkBodyFrontmatter('Just some text')).toEqual([]);
  });

  it('returns no issue for empty body', () => {
    expect(checkBodyFrontmatter('')).toEqual([]);
  });

  it('flags body starting with frontmatter delimiter', () => {
    const issues = checkBodyFrontmatter('---\ntitle: oops\n---\nBody text');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('FRONTMATTER_IN_BODY');
  });

  it('does not flag horizontal rules mid-body', () => {
    expect(checkBodyFrontmatter('Some text\n\n---\n\nMore text')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: FAIL — module `title-warnings.js` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/mcp/tools/title-warnings.ts

const WIKILINK_UNSAFE = ['(', ')', '[', ']', '|', '#', '^'];

export interface ToolIssue {
  code: string;
  message: string;
  characters?: string[];
}

export function checkTitleSafety(title: string): ToolIssue[] {
  const found = WIKILINK_UNSAFE.filter(ch => title.includes(ch));
  if (found.length === 0) return [];
  return [{
    code: 'TITLE_WIKILINK_UNSAFE',
    message: `Title contains characters that may break Obsidian wiki-links: ${found.join(' ')}`,
    characters: found,
  }];
}

export function checkBodyFrontmatter(body: string): ToolIssue[] {
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    return [{
      code: 'FRONTMATTER_IN_BODY',
      message: 'Body appears to start with a YAML frontmatter block. Structured fields should be passed via the fields parameter, not embedded in body.',
    }];
  }
  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/title-warnings.ts tests/mcp/tool-surface-tightening.test.ts
git commit -m "feat: add shared title-safety and body-frontmatter warning helpers"
```

---

### Task 2: `rename-node` — param rename + validation + schema default

**Files:**
- Modify: `src/mcp/tools/rename-node.ts`
- Modify: `tests/mcp/tool-surface-tightening.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp/tool-surface-tightening.test.ts`:

```typescript
import { beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerRenameNode } from '../../src/mcp/tools/rename-node.js';
import { createTempVault } from '../helpers/vault.js';

// ── rename-node surface tightening ───────────────────────────────────

describe('rename-node surface tightening', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerRenameNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  function createNode(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: fp, title,
      types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
    });
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('rejects directory ending in .md', async () => {
    const node = createNode('Notes/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'new',
      directory: 'Notes/new.md',
    }));
    expect(result.code).toBe('INVALID_PARAMS');
    expect(result.error).toMatch(/directory.*must be a folder/i);
  });

  it('accepts directory param and derives file path from title', async () => {
    const node = createNode('Notes/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'Renamed',
      directory: 'Archive',
    }));
    expect(result.new_file_path).toBe('Archive/Renamed.md');
    expect(existsSync(join(vaultPath, 'Archive/Renamed.md'))).toBe(true);
  });

  it('defaults directory to schema default_directory when omitted', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const node = createNode('Tasks/old-task.md', 'old-task', { types: ['task'] });

    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'New Task',
    }));
    expect(result.new_file_path).toBe('Tasks/New Task.md');
  });

  it('keeps current directory when no schema and no directory param', async () => {
    const node = createNode('Somewhere/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'Renamed',
    }));
    expect(result.new_file_path).toBe('Somewhere/Renamed.md');
  });

  it('includes title safety warnings in response', async () => {
    const node = createNode('Notes/old.md', 'old');
    const result = parseResult(await handler({
      node_id: node.node_id,
      new_title: 'Something (with parens)',
    }));
    expect(result.new_file_path).toBe('Notes/Something (with parens).md');
    const issues = result.issues as Array<{ code: string }>;
    expect(issues.some(i => i.code === 'TITLE_WIKILINK_UNSAFE')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: FAIL — `directory` param not recognized, old `new_path` still in schema

- [ ] **Step 3: Modify `rename-node.ts`**

In `src/mcp/tools/rename-node.ts`, make these changes:

1. Update `paramsShape` — replace `new_path` with `directory`:

```typescript
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  new_title: z.string(),
  directory: z.string().optional(),
};
```

2. Add imports at the top:

```typescript
import { checkTitleSafety, type ToolIssue } from './title-warnings.js';
```

3. After resolving node identity (after `const oldFilePath = node.file_path;`), replace the directory/path derivation block:

```typescript
      // ── Validate directory param ──────────────────────────────────
      if (params.directory !== undefined && params.directory.endsWith('.md')) {
        return toolErrorResult('INVALID_PARAMS',
          '"directory" must be a folder path, not a filename. The filename is always derived from the node title.');
      }

      // Derive new directory: explicit param > schema default > current directory
      let newDir: string;
      if (params.directory !== undefined) {
        newDir = params.directory;
      } else {
        // Check schema default_directory for the node's first type
        const nodeType = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? LIMIT 1')
          .get(node.node_id) as { schema_type: string } | undefined;
        let schemaDefault: string | null = null;
        if (nodeType) {
          const schema = db.prepare('SELECT default_directory FROM schemas WHERE name = ?')
            .get(nodeType.schema_type) as { default_directory: string | null } | undefined;
          schemaDefault = schema?.default_directory ?? null;
        }
        newDir = schemaDefault ?? dirname(oldFilePath);
      }

      const newFilePath = newDir === '.' || newDir === ''
        ? `${params.new_title}.md`
        : `${newDir}/${params.new_title}.md`;
```

4. After the `try { const refsUpdated = txn(); ... }` block, before returning the final `toolResult`, collect issues and include them:

```typescript
      try {
        const refsUpdated = txn();
        const issues: ToolIssue[] = checkTitleSafety(params.new_title);
        return toolResult({
          node_id: node.node_id,
          old_file_path: oldFilePath,
          new_file_path: newFilePath,
          old_title: oldTitle,
          new_title: params.new_title,
          references_updated: refsUpdated,
          issues,
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Run existing rename tests to check for regressions**

Run: `npx vitest run tests/phase3/rename-batch.test.ts`
Expected: all PASS (existing tests use the lower-level `executeMutation` + direct DB calls, not the tool handler params)

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/rename-node.ts tests/mcp/tool-surface-tightening.test.ts
git commit -m "feat: rename-node uses directory param, rejects .md suffix, defaults to schema directory"
```

---

### Task 3: `create-node` — param rename + override gate + warnings

**Files:**
- Modify: `src/mcp/tools/create-node.ts`
- Modify: `tests/mcp/tool-surface-tightening.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp/tool-surface-tightening.test.ts`:

```typescript
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';

describe('create-node surface tightening', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerCreateNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('rejects directory ending in .md', async () => {
    const result = parseResult(await handler({
      title: 'Test',
      types: [],
      directory: 'Notes/test.md',
    }));
    expect(result.code).toBe('INVALID_PARAMS');
    expect(result.error).toMatch(/directory.*must be a folder/i);
  });

  it('uses schema default_directory when no directory param', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const result = parseResult(await handler({
      title: 'My Task',
      types: ['task'],
    }));
    expect(result.file_path).toBe('Tasks/My Task.md');
  });

  it('rejects directory override when schema has default_directory and override flag is missing', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const result = parseResult(await handler({
      title: 'My Task',
      types: ['task'],
      directory: 'Elsewhere',
    }));
    expect(result.code).toBe('INVALID_PARAMS');
    expect(result.error).toMatch(/override_default_directory/);
  });

  it('allows directory override when override_default_directory is true', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', default_directory: 'Tasks', field_claims: [{ field: 'status' }] });
    const result = parseResult(await handler({
      title: 'My Task',
      types: ['task'],
      directory: 'Elsewhere',
      override_default_directory: true,
    }));
    expect(result.file_path).toBe('Elsewhere/My Task.md');
  });

  it('allows directory on schema-less nodes without override flag', async () => {
    const result = parseResult(await handler({
      title: 'Loose Note',
      types: [],
      directory: 'Scratch',
    }));
    expect(result.file_path).toBe('Scratch/Loose Note.md');
  });

  it('includes title safety warning in response', async () => {
    const result = parseResult(await handler({
      title: 'Something (bad)',
      types: [],
    }));
    expect(result.file_path).toBe('Something (bad).md');
    const issues = result.issues as Array<{ code: string }>;
    expect(issues.some(i => i.code === 'TITLE_WIKILINK_UNSAFE')).toBe(true);
  });

  it('includes frontmatter-in-body warning in response', async () => {
    const result = parseResult(await handler({
      title: 'Test Note',
      types: [],
      body: '---\ntitle: oops\n---\nContent',
    }));
    expect(result.node_id).toBeDefined();
    const issues = result.issues as Array<{ code: string }>;
    expect(issues.some(i => i.code === 'FRONTMATTER_IN_BODY')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: FAIL — `directory` param not recognized

- [ ] **Step 3: Modify `create-node.ts`**

1. Update `paramsShape` — replace `path` with `directory` + `override_default_directory`:

```typescript
const paramsShape = {
  title: z.string(),
  types: z.array(z.string()).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
  body: z.string().default(''),
  directory: z.string().optional(),
  override_default_directory: z.boolean().default(false),
  dry_run: z.boolean().default(false),
};
```

2. Add imports:

```typescript
import { checkTitleSafety, checkBodyFrontmatter, type ToolIssue } from './title-warnings.js';
```

3. Replace the destructuring and file-path derivation block (lines 38–79) with:

```typescript
      const { title, types, fields, body, directory, override_default_directory, dry_run: dryRun } = params;

      // ── Type-schema check (Stage 1 gate) ──────────────────────────
      // ... (unchanged) ...

      // ── Validate directory param ──────────────────────────────────
      if (directory !== undefined && directory.endsWith('.md')) {
        return toolErrorResult('INVALID_PARAMS',
          '"directory" must be a folder path, not a filename. The filename is always derived from the node title.');
      }

      // Derive file path
      let filePath: string;

      // Get schema default_directory for the first type
      let schemaDefaultDir: string | null = null;
      if (types.length >= 1) {
        const schema = db.prepare('SELECT filename_template, default_directory FROM schemas WHERE name = ?')
          .get(types[0]) as { filename_template: string | null; default_directory: string | null } | undefined;
        schemaDefaultDir = schema?.default_directory ?? null;

        // Check override gate: if schema has a default and caller is overriding, require the flag
        if (directory !== undefined && schemaDefaultDir && !override_default_directory) {
          return toolErrorResult('INVALID_PARAMS',
            `Type "${types[0]}" routes to "${schemaDefaultDir}/" via schema. Pass override_default_directory: true to place this node elsewhere.`);
        }

        // Derive filename from template or title
        let fileName = `${title}.md`;
        if (schema?.filename_template) {
          const derived = evaluateTemplate(schema.filename_template, title, fields);
          if (derived === null) {
            return toolErrorResult('INVALID_PARAMS', 'Filename template has unresolved variables');
          }
          fileName = derived;
        }

        const dir = directory ?? schemaDefaultDir ?? '';
        filePath = dir ? `${dir}/${fileName}` : fileName;
      } else {
        // No types — use directory param or vault root
        const dir = directory ?? '';
        filePath = dir ? `${dir}/${title}.md` : `${title}.md`;
      }
```

4. In the success response (both dry-run and real), merge in warning issues. For the non-dry-run success path, change the return to:

```typescript
        const titleIssues = checkTitleSafety(title);
        const bodyIssues = checkBodyFrontmatter(body);
        const extraIssues = [...titleIssues, ...bodyIssues];

        return toolResult({
          node_id: result.node_id,
          file_path: result.file_path,
          title,
          types,
          coerced_state: result.validation.coerced_state,
          issues: [...result.validation.issues, ...extraIssues],
          orphan_fields: result.validation.orphan_fields,
        });
```

Do the same for the dry-run response — append `extraIssues` to the issues array.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Run existing create-node tests for regressions**

Run: `npx vitest run tests/mcp/type-safety.test.ts tests/phase3/tools.test.ts`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/create-node.ts tests/mcp/tool-surface-tightening.test.ts
git commit -m "feat: create-node uses directory param with override gate, adds title/body warnings"
```

---

### Task 4: `update-node` — `set_title` triggers rename + `set_directory` in query mode

**Files:**
- Modify: `src/mcp/tools/update-node.ts`
- Modify: `tests/mcp/tool-surface-tightening.test.ts`

This is the most complex change. `set_title` in single-node mode must now rename the file and rewrite references, using the same logic as `rename-node`.

- [ ] **Step 1: Extract reusable rename logic from `rename-node.ts`**

The wiki-link rewrite and reference-update logic in `rename-node.ts` needs to be callable from `update-node.ts`. Extract a shared function. Add to `src/mcp/tools/rename-node.ts`:

```typescript
/** Core rename logic: rename file, update DB, rewrite references. Runs inside caller's transaction. */
export function executeRename(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  node: { node_id: string; file_path: string; title: string },
  newTitle: string,
  newFilePath: string,
  syncLogger?: SyncLogger,
): { refsUpdated: number } {
  const oldTitle = node.title;
  const oldFilePath = node.file_path;

  // Find all referencing nodes using full five-tier resolution
  const distinctTargets = db.prepare('SELECT DISTINCT target FROM relationships').all() as { target: string }[];
  const targetsPointingToNode: string[] = [];
  for (const { target } of distinctTargets) {
    const resolved = resolveTarget(db, target);
    if (resolved && resolved.id === node.node_id) {
      targetsPointingToNode.push(target);
    }
  }

  const referencingNodeIds = new Set<string>();
  if (targetsPointingToNode.length > 0) {
    const placeholders = targetsPointingToNode.map(() => '?').join(',');
    const refs = db.prepare(
      `SELECT DISTINCT source_id FROM relationships WHERE target IN (${placeholders}) AND source_id != ?`
    ).all(...targetsPointingToNode, node.node_id) as { source_id: string }[];
    for (const r of refs) referencingNodeIds.add(r.source_id);
  }

  // 1. Rename file on disk
  if (newFilePath !== oldFilePath) {
    const oldAbs = join(vaultPath, oldFilePath);
    const newAbs = join(vaultPath, newFilePath);
    if (existsSync(oldAbs)) {
      const newDir = dirname(newAbs);
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
      renameSync(oldAbs, newAbs);
    }
  }

  // 2. Update the renamed node's DB state
  db.prepare('UPDATE nodes SET file_path = ?, title = ? WHERE id = ?').run(
    newFilePath, newTitle, node.node_id,
  );

  // 3. Re-render the renamed node at new path
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
  const fields: Record<string, unknown> = {};
  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  for (const row of fieldRows) {
    fields[row.field_name] = reconstructValue(row);
  }
  const body = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

  executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: node.node_id,
    file_path: newFilePath,
    title: newTitle,
    types,
    fields,
    body,
  }, syncLogger);

  // 4. Update references in referencing nodes
  let refsUpdated = 0;
  for (const refNodeId of referencingNodeIds) {
    const refNode = db.prepare('SELECT file_path, title, body FROM nodes WHERE id = ?').get(refNodeId) as { file_path: string; title: string; body: string };
    const refTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
      .all(refNodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);
    const refFields: Record<string, unknown> = {};
    const refFieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
      .all(refNodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
    for (const row of refFieldRows) {
      refFields[row.field_name] = reconstructValue(row);
    }

    let changed = false;
    for (const [fieldName, value] of Object.entries(refFields)) {
      if (typeof value === 'string' && value === oldTitle) {
        refFields[fieldName] = newTitle;
        changed = true;
      } else if (Array.isArray(value)) {
        const newArr = value.map(v => (typeof v === 'string' && v === oldTitle) ? newTitle : v);
        if (JSON.stringify(newArr) !== JSON.stringify(value)) {
          refFields[fieldName] = newArr;
          changed = true;
        }
      }
    }

    const newBody = rewriteBodyWikiLinks(refNode.body, targetsPointingToNode, newTitle);
    if (newBody !== refNode.body) changed = true;

    if (changed) {
      executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: refNodeId,
        file_path: refNode.file_path,
        title: refNode.title,
        types: refTypes,
        fields: refFields,
        body: newBody,
      }, syncLogger);
      refsUpdated++;
    }
  }

  return { refsUpdated };
}
```

Then refactor the `rename-node` tool handler to call `executeRename` inside its transaction, instead of duplicating the logic.

- [ ] **Step 2: Write the failing tests for `set_title` rename behavior**

Append to `tests/mcp/tool-surface-tightening.test.ts`:

```typescript
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';

describe('update-node set_title renames file', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerUpdateNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  function createNode(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: fp, title,
      types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
    });
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('set_title renames the file on disk', async () => {
    const node = createNode('Notes/Original.md', 'Original');
    const result = parseResult(await handler({
      node_id: node.node_id,
      set_title: 'Renamed',
    }));
    expect(result.file_path).toBe('Notes/Renamed.md');
    expect(existsSync(join(vaultPath, 'Notes/Renamed.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Notes/Original.md'))).toBe(false);
  });

  it('set_title updates wiki-link references', async () => {
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });

    const target = createNode('Notes/Old Name.md', 'Old Name');
    createNode('Notes/Referencing.md', 'Referencing', {
      types: ['task'],
      fields: { project: 'Old Name' },
      body: 'See [[Old Name]] for details.',
    });

    await handler({
      node_id: target.node_id,
      set_title: 'New Name',
    });

    // Check referencing node's field was updated
    const refFields = db.prepare('SELECT value_text FROM node_fields WHERE node_id = (SELECT id FROM nodes WHERE title = ?) AND field_name = ?')
      .get('Referencing', 'project') as { value_text: string };
    expect(refFields.value_text).toBe('New Name');
  });

  it('set_title returns conflict error when target path exists', async () => {
    createNode('Notes/A.md', 'A');
    createNode('Notes/B.md', 'B');
    const result = parseResult(await handler({
      title: 'A',
      set_title: 'B',
    }));
    expect(result.code).toBe('CONFLICT');
  });

  it('set_title with same title is a no-op', async () => {
    const node = createNode('Notes/Same.md', 'Same');
    const result = parseResult(await handler({
      node_id: node.node_id,
      set_title: 'Same',
    }));
    // Should succeed without error — title unchanged, no rename needed
    expect(result.file_path).toBe('Notes/Same.md');
  });
});
```

- [ ] **Step 3: Write the failing tests for `set_directory` in query mode**

Append to `tests/mcp/tool-surface-tightening.test.ts`:

```typescript
describe('update-node query mode set_directory', () => {
  let vaultPath: string;
  let cleanupVault: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  function parseResult(result: unknown): Record<string, unknown> {
    const r = result as { content: Array<{ type: string; text: string }> };
    return JSON.parse(r.content[0].text);
  }

  function captureHandler() {
    let captured: (args: Record<string, unknown>) => Promise<unknown>;
    const fakeServer = {
      tool: (_name: string, _desc: string, _schema: unknown, h: (...args: unknown[]) => unknown) => {
        captured = (args) => h(args) as Promise<unknown>;
      },
    } as unknown as McpServer;
    registerUpdateNode(fakeServer, db, writeLock, vaultPath);
    return captured!;
  }

  function createNode(fp: string, title: string, opts: { types?: string[]; fields?: Record<string, unknown>; body?: string } = {}) {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: fp, title,
      types: opts.types ?? [], fields: opts.fields ?? {}, body: opts.body ?? '',
    });
  }

  beforeEach(() => {
    ({ vaultPath, cleanup: cleanupVault } = createTempVault());
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    writeLock = new WriteLockManager();
    handler = captureHandler();
  });

  afterEach(() => {
    db.close();
    cleanupVault();
  });

  it('rejects set_directory ending in .md', async () => {
    const result = parseResult(await handler({
      query: { types: ['task'] },
      set_directory: 'Archive/foo.md',
      dry_run: true,
    }));
    expect(result.code).toBe('INVALID_PARAMS');
    expect(result.error).toMatch(/directory.*must be a folder/i);
  });

  it('set_directory moves files in query mode', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    createNode('Tasks/A.md', 'A', { types: ['task'] });

    const result = parseResult(await handler({
      query: { types: ['task'] },
      set_directory: 'Archive',
      dry_run: false,
      confirm_large_batch: true,
    }));
    expect(result.updated).toBe(1);
    expect(existsSync(join(vaultPath, 'Archive/A.md'))).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: FAIL

- [ ] **Step 5: Modify `update-node.ts` — wire `set_title` to rename logic**

1. Add imports:

```typescript
import { executeRename } from './rename-node.js';
import { checkTitleSafety, type ToolIssue } from './title-warnings.js';
```

2. In `paramsShape`, rename `set_path` to `set_directory`:

```typescript
  set_directory: z.string().optional(),
```

3. In the single-node mode, after computing `finalTitle` (line 132), add rename logic. Replace the section from `const finalTitle` through the `executeMutation` call:

```typescript
      const finalTitle = set_title ?? node.title;
      const titleChanged = set_title !== undefined && set_title !== node.title;

      // If title changed, derive new file path and check for conflicts
      let effectiveFilePath = node.file_path;
      if (titleChanged) {
        const currentDir = dirname(node.file_path);
        const newDir = currentDir === '.' ? '' : currentDir;
        const newFilePath = newDir ? `${newDir}/${finalTitle}.md` : `${finalTitle}.md`;

        // Conflict check
        if (newFilePath !== node.file_path) {
          const conflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(newFilePath) as { id: string; title: string } | undefined;
          if (conflict) {
            return toolErrorResult('CONFLICT', `Cannot rename — file "${newFilePath}" already exists (node: ${conflict.title}). Use rename-node with a different directory to resolve.`);
          }
          if (existsSync(join(vaultPath, newFilePath))) {
            return toolErrorResult('CONFLICT', `Cannot rename — file "${newFilePath}" already exists on disk.`);
          }
        }
        effectiveFilePath = newFilePath;
      }
```

For the dry-run response, use `effectiveFilePath`. For the non-dry-run path, when `titleChanged` is true, use `executeRename` instead of plain `executeMutation`. When `titleChanged` is false, use the existing `executeMutation` path:

```typescript
      if (dryRun) {
        const { claimsByType, globalFields } = loadSchemaContext(db, finalTypes);
        const validation = validateProposedState(finalFields, finalTypes, claimsByType, globalFields);
        const titleIssues = titleChanged ? checkTitleSafety(finalTitle) : [];
        return toolResult({
          dry_run: true,
          preview: {
            node_id: node.node_id,
            file_path: effectiveFilePath,
            title: finalTitle,
            types: finalTypes,
            coerced_state: validation.coerced_state,
            issues: [...validation.issues, ...titleIssues],
            orphan_fields: validation.orphan_fields,
          },
        });
      }

      try {
        // If title changed, do a full rename (file + references)
        if (titleChanged) {
          // First apply field/type/body changes via mutation
          const result = executeMutation(db, writeLock, vaultPath, {
            source: 'tool',
            node_id: node.node_id,
            file_path: node.file_path,
            title: node.title,  // keep old title for now — rename handles the switch
            types: finalTypes,
            fields: finalFields,
            body: finalBody,
          }, syncLogger);

          // Then rename (file + DB + references)
          const txn = db.transaction(() => {
            return executeRename(db, writeLock, vaultPath, {
              node_id: node.node_id,
              file_path: node.file_path,
              title: node.title,
            }, finalTitle, effectiveFilePath, syncLogger);
          });
          const { refsUpdated } = txn();

          const titleIssues = checkTitleSafety(finalTitle);
          return toolResult({
            node_id: node.node_id,
            file_path: effectiveFilePath,
            title: finalTitle,
            types: finalTypes,
            coerced_state: result.validation.coerced_state,
            issues: [...result.validation.issues, ...titleIssues],
            orphan_fields: result.validation.orphan_fields,
            references_updated: refsUpdated,
          });
        }

        // No title change — standard mutation
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
          title: finalTitle,
          types: finalTypes,
          fields: finalFields,
          body: finalBody,
        }, syncLogger);

        return toolResult({
          node_id: result.node_id,
          file_path: result.file_path,
          title: finalTitle,
          types: finalTypes,
          coerced_state: result.validation.coerced_state,
          issues: result.validation.issues,
          orphan_fields: result.validation.orphan_fields,
        });
```

4. In query mode, rename all `set_path` references to `set_directory`. Update `QueryModeOps`:

```typescript
interface QueryModeOps {
  set_fields?: Record<string, unknown>;
  add_types?: string[];
  remove_types?: string[];
  set_directory?: string;
}
```

Update the single-node mode guard:

```typescript
      if (hasIdentity && params.set_directory !== undefined) {
        return toolErrorResult('INVALID_PARAMS', 'set_directory is not supported in single-node mode. Use rename-node to move individual files.');
      }
```

Update the `hasOp` check and query-mode call:

```typescript
        const hasOp = params.set_fields !== undefined || params.add_types !== undefined || params.remove_types !== undefined || params.set_directory !== undefined;
        // ...
        return handleQueryMode(db, writeLock, vaultPath, params.query!, {
          set_fields: params.set_fields,
          add_types: params.add_types,
          remove_types: params.remove_types,
          set_directory: params.set_directory,
        }, dryRun, params.confirm_large_batch, syncLogger);
```

Add `.md` rejection at the top of query-mode handling:

```typescript
      if (params.set_directory !== undefined && params.set_directory.endsWith('.md')) {
        return toolErrorResult('INVALID_PARAMS',
          '"set_directory" must be a folder path, not a filename. The filename is always derived from the node title.');
      }
```

Update `computeNewPath` and all references from `set_path` to `set_directory`:

```typescript
function computeNewPath(currentFilePath: string, title: string, ops: QueryModeOps): { newFilePath: string; newDir: string; moved: boolean } | null {
  if (ops.set_directory === undefined) return null;
  const targetDir = ops.set_directory === '.' ? '' : ops.set_directory;
  const newFilePath = targetDir === '' ? `${title}.md` : `${targetDir}/${title}.md`;
  if (newFilePath === currentFilePath) return null;
  return { newFilePath, newDir: targetDir, moved: true };
}
```

Also update the error messages that reference `set_path` to say `set_directory`.

- [ ] **Step 6: Add `CONFLICT` to the `ErrorCode` union type**

In `src/mcp/tools/errors.ts`, add `'CONFLICT'`:

```typescript
export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR' | 'VALIDATION_FAILED' | 'UNKNOWN_TYPE' | 'EXTRACTOR_UNAVAILABLE' | 'AMBIGUOUS_FILENAME' | 'CONFLICT';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/tool-surface-tightening.test.ts`
Expected: all tests PASS

- [ ] **Step 8: Run existing update-node tests for regressions**

Run: `npx vitest run tests/mcp/update-node-query.test.ts tests/mcp/type-safety.test.ts`
Expected: all PASS (query tests use `set_path` — they will need updating if the param name changed at the Zod level. If they fail, update the test calls from `set_path` to `set_directory`.)

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools/update-node.ts src/mcp/tools/rename-node.ts src/mcp/tools/errors.ts tests/mcp/tool-surface-tightening.test.ts
git commit -m "feat: set_title renames files, set_path renamed to set_directory with .md rejection"
```

---

### Task 5: Update existing tests for param renames

**Files:**
- Modify: `tests/mcp/update-node-query.test.ts`

- [ ] **Step 1: Find and replace `set_path` with `set_directory` in existing tests**

Run: `grep -rn 'set_path' tests/`

Replace all occurrences of `set_path` with `set_directory` in test files that call the tool handler with this parameter.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test: update existing tests for set_path → set_directory rename"
```

---

### Task 6: Update tool descriptions

**Files:**
- Modify: `src/mcp/tools/create-node.ts` (tool description string)
- Modify: `src/mcp/tools/rename-node.ts` (tool description string)
- Modify: `src/mcp/tools/update-node.ts` (tool description string)

- [ ] **Step 1: Update `create-node` description**

Change the description from mentioning `path` to `directory`:

```typescript
'Create a new node and write it to disk. Every type in types must have a defined schema — call list-schemas to see available types. For general-purpose notes and reference material, use type note. File location is derived from the type\'s schema (default_directory + filename_template). To override the schema directory, pass directory with override_default_directory: true. Use dry_run: true to validate types and fields before generating long body content — this catches errors without wasting work.',
```

- [ ] **Step 2: Update `rename-node` description**

```typescript
'Rename a node: updates title, file path, and all wiki-link references vault-wide. The filename is always derived from new_title. Pass directory to move the file; omit it to use the schema default_directory or keep the current directory.',
```

- [ ] **Step 3: Update `update-node` description**

Update any references to `set_path` in the description to `set_directory`. Mention that `set_title` renames the file and updates references.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/create-node.ts src/mcp/tools/rename-node.ts src/mcp/tools/update-node.ts
git commit -m "docs: update tool descriptions for directory param and set_title rename behavior"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean compilation, no errors

- [ ] **Step 3: Smoke test with dev server**

Run: `npm run dev`

Test the following via MCP calls:
1. `create-node` with a typed node — verify it uses schema `default_directory`
2. `create-node` with `directory` on a typed node without `override_default_directory` — verify rejection
3. `rename-node` with `directory: "Something.md"` — verify `.md` rejection
4. `update-node` with `set_title` — verify file is renamed on disk
5. `create-node` with parentheses in title — verify `TITLE_WIKILINK_UNSAFE` warning
6. `create-node` with frontmatter in body — verify `FRONTMATTER_IN_BODY` warning
