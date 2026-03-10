# rename-node Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `rename-node` MCP tool that renames a node, moves its file, and updates every wiki-link reference to it across the vault.

**Architecture:** Two pure helper functions handle reference text replacement (body via AST positions, frontmatter via regex). The `renameNode` orchestrator in `server.ts` coordinates: validate → find refs → update source + referencing files → write all → re-index in transaction. Follows existing mutation tool patterns.

**Tech Stack:** unified/remark (MDAST parsing for position extraction), better-sqlite3, vitest, MCP SDK

**Spec:** `docs/plans/2026-03-10-rename-node-design.md`

---

## Chunk 1: Reference Update Helpers

### Task 1: `updateBodyReferences` helper

**Files:**
- Create: `src/mcp/rename-helpers.ts`
- Create: `tests/mcp/rename-helpers.test.ts`

- [ ] **Step 1: Write failing tests for `updateBodyReferences`**

```typescript
// tests/mcp/rename-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { updateBodyReferences } from '../../src/mcp/rename-helpers.js';

describe('updateBodyReferences', () => {
  it('replaces a single wiki-link target', () => {
    const body = 'See [[Alice]] for details.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Smith]] for details.');
  });

  it('preserves alias when renaming target', () => {
    const body = 'Contact [[Alice|the boss]] today.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('Contact [[Alice Smith|the boss]] today.');
  });

  it('matches case-insensitively', () => {
    const body = 'See [[alice]] and [[ALICE]] here.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Smith]] and [[Alice Smith]] here.');
  });

  it('replaces multiple occurrences in one body', () => {
    const body = 'First [[Alice]], then [[Alice]] again.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('First [[Alice Smith]], then [[Alice Smith]] again.');
  });

  it('does not replace substring matches', () => {
    const body = 'See [[Alice Cooper]] and [[Alice]].';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Cooper]] and [[Alice Smith]].');
  });

  it('returns body unchanged when no matches', () => {
    const body = 'See [[Bob]] for details.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Bob]] for details.');
  });

  it('handles empty body', () => {
    expect(updateBodyReferences('', 'Alice', 'Alice Smith')).toBe('');
  });

  it('handles link at start of body', () => {
    const body = '[[Alice]] is here.';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('[[Alice Smith]] is here.');
  });

  it('handles link at end of body', () => {
    const body = 'See [[Alice]]';
    const result = updateBodyReferences(body, 'Alice', 'Alice Smith');
    expect(result).toBe('See [[Alice Smith]]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/rename-helpers.test.ts`
Expected: FAIL — module `../../src/mcp/rename-helpers.js` not found

- [ ] **Step 3: Write implementation**

```typescript
// src/mcp/rename-helpers.ts
import { parseMarkdown } from '../parser/markdown.js';
import { extractWikiLinksFromMdast } from '../parser/wiki-links.js';

export function updateBodyReferences(body: string, oldTitle: string, newTitle: string): string {
  if (!body) return body;

  const mdast = parseMarkdown(body);
  const links = extractWikiLinksFromMdast(mdast);

  // Filter links matching old title (case-insensitive, exact match)
  const matching = links
    .filter(l => l.target.toLowerCase() === oldTitle.toLowerCase())
    .filter(l => l.position?.start.offset != null && l.position?.end.offset != null);

  if (matching.length === 0) return body;

  // Sort by offset descending so replacements don't shift earlier positions
  matching.sort((a, b) => b.position!.start.offset! - a.position!.start.offset!);

  let result = body;
  for (const link of matching) {
    const start = link.position!.start.offset!;
    const end = link.position!.end.offset!;
    const replacement = link.alias
      ? `[[${newTitle}|${link.alias}]]`
      : `[[${newTitle}]]`;
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/rename-helpers.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/rename-helpers.ts tests/mcp/rename-helpers.test.ts
git commit -m "add updateBodyReferences helper with unit tests"
```

---

### Task 2: `updateFrontmatterReferences` helper

**Files:**
- Modify: `src/mcp/rename-helpers.ts`
- Modify: `tests/mcp/rename-helpers.test.ts`

- [ ] **Step 1: Write failing tests for `updateFrontmatterReferences`**

Add to `tests/mcp/rename-helpers.test.ts`:

```typescript
import { updateBodyReferences, updateFrontmatterReferences } from '../../src/mcp/rename-helpers.js';

describe('updateFrontmatterReferences', () => {
  it('replaces reference in a scalar string field', () => {
    const fields = { assignee: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ assignee: '[[Alice Smith]]' });
  });

  it('replaces references in array field values', () => {
    const fields = { reviewers: ['[[Alice]]', '[[Bob]]'] };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ reviewers: ['[[Alice Smith]]', '[[Bob]]'] });
  });

  it('preserves alias in frontmatter references', () => {
    const fields = { lead: '[[Alice|project lead]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ lead: '[[Alice Smith|project lead]]' });
  });

  it('does not modify non-reference string fields', () => {
    const fields = { status: 'in-progress', assignee: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ status: 'in-progress', assignee: '[[Alice Smith]]' });
  });

  it('preserves non-string values unchanged', () => {
    const fields = { count: 5, done: true, assignee: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ count: 5, done: true, assignee: '[[Alice Smith]]' });
  });

  it('matches case-insensitively', () => {
    const fields = { assignee: '[[alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ assignee: '[[Alice Smith]]' });
  });

  it('does not replace substring matches', () => {
    const fields = { person: '[[Alice Cooper]]', other: '[[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ person: '[[Alice Cooper]]', other: '[[Alice Smith]]' });
  });

  it('handles multiple references in one string', () => {
    const fields = { note: 'From [[Alice]] to [[Alice]]' };
    const result = updateFrontmatterReferences(fields, 'Alice', 'Alice Smith');
    expect(result).toEqual({ note: 'From [[Alice Smith]] to [[Alice Smith]]' });
  });

  it('returns empty object for empty input', () => {
    expect(updateFrontmatterReferences({}, 'Alice', 'Alice Smith')).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run tests/mcp/rename-helpers.test.ts`
Expected: `updateFrontmatterReferences` tests FAIL — function not exported

- [ ] **Step 3: Write implementation**

Add to `src/mcp/rename-helpers.ts`:

```typescript
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceInValue(value: unknown, re: RegExp, newTitle: string): unknown {
  if (typeof value === 'string') {
    return value.replace(re, (_match: string, alias?: string) =>
      alias ? `[[${newTitle}${alias}]]` : `[[${newTitle}]]`
    );
  }
  if (Array.isArray(value)) {
    return value.map(item => replaceInValue(item, re, newTitle));
  }
  return value;
}

export function updateFrontmatterReferences(
  fields: Record<string, unknown>,
  oldTitle: string,
  newTitle: string,
): Record<string, unknown> {
  const escaped = escapeRegExp(oldTitle);
  const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, 'gi');

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = replaceInValue(value, re, newTitle);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/rename-helpers.test.ts`
Expected: All 18 tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/mcp/rename-helpers.ts tests/mcp/rename-helpers.test.ts
git commit -m "add updateFrontmatterReferences helper with unit tests"
```

---

## Chunk 2: rename-node Tool

### Task 3: Error handling + tool registration

**Files:**
- Modify: `src/mcp/server.ts` (add imports, `renameNode` skeleton, tool registration)
- Create: `tests/mcp/rename-node.test.ts`

- [ ] **Step 1: Write failing error-handling tests**

```typescript
// tests/mcp/rename-node.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('rename-node', () => {
  let db: Database.Database;
  let client: Client;
  let cleanup: () => Promise<void>;
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);

    const server = createServer(db, vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(clientTransport);
    cleanup = async () => {
      await client.close();
      await server.close();
      db.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  async function createTestNode(args: Record<string, unknown>) {
    const result = await client.callTool({ name: 'create-node', arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  async function callRename(args: Record<string, unknown>) {
    return client.callTool({ name: 'rename-node', arguments: args });
  }

  function parseResult(result: Awaited<ReturnType<typeof callRename>>) {
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns error when node does not exist in DB', async () => {
    const result = await callRename({ node_id: 'nonexistent.md', new_title: 'New' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('Node not found');
  });

  it('returns error when file missing from disk', async () => {
    // Create node, then delete its file manually
    await createTestNode({ title: 'Ghost' });
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await callRename({ node_id: 'Ghost.md', new_title: 'New Ghost' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('File not found on disk');
  });

  it('returns error when new path already exists', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Alice Smith' });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('already exists');
  });

  it('returns current node as no-op when title unchanged and no new_path', async () => {
    await createTestNode({ title: 'Alice' });
    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.node.id).toBe('Alice.md');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/rename-node.test.ts`
Expected: FAIL — `rename-node` tool not registered

- [ ] **Step 3: Add imports to `server.ts`**

Add to the import section of `src/mcp/server.ts`:

After the existing `indexFile` import (line 15), add `deleteFile`:
```typescript
import { indexFile, deleteFile } from '../sync/indexer.js';
```

After the existing serializer import (line 14), add `deleteNodeFile`:
```typescript
import { serializeNode, computeFieldOrder, generateFilePath, writeNodeFile, deleteNodeFile, sanitizeSegment } from '../serializer/index.js';
```

Add new import for rename helpers:
```typescript
import { updateBodyReferences, updateFrontmatterReferences } from './rename-helpers.js';
```

- [ ] **Step 4: Write `renameNode` skeleton + tool registration**

Add the `renameNode` function inside `createServer`, after the `addRelationship` function (after line 501). Also add the tool registration after the `add-relationship` tool registration block (after line 521):

```typescript
  function renameNode(params: {
    node_id: string;
    new_title: string;
    new_path?: string;
  }) {
    const { node_id, new_title, new_path: explicitNewPath } = params;

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node_id) as
      | { id: string; title: string }
      | undefined;
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${node_id}` }],
        isError: true,
      };
    }

    // Check file exists on disk
    const absPath = join(vaultPath, node_id);
    if (!existsSync(absPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File not found on disk: ${node_id}. Database and filesystem are out of sync.`,
        }],
        isError: true,
      };
    }

    // Read + parse existing file
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(node_id, raw);
    const oldTitle = typeof parsed.frontmatter.title === 'string'
      ? parsed.frontmatter.title
      : node_id.replace(/\.md$/, '').split('/').pop()!;
    const types = parsed.types;

    // No-op: same title, no explicit new path
    if (new_title === oldTitle && !explicitNewPath) {
      return returnCurrentNode(node_id);
    }

    // Extract existing fields (exclude meta-keys)
    const existingFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'title' || key === 'types') continue;
      existingFields[key] = value;
    }

    // Derive new path
    const newPath = explicitNewPath ?? generateFilePath(new_title, types, existingFields, db);

    // Check new path doesn't collide (unless same path)
    if (newPath !== node_id && existsSync(join(vaultPath, newPath))) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: File already exists at ${newPath}. Use a different title or provide an explicit new_path.`,
        }],
        isError: true,
      };
    }

    // TODO: implement rename pipeline (Tasks 4-5)
    return returnCurrentNode(node_id);
  }

  server.tool(
    'rename-node',
    'Rename a node and update all wiki-link references to it across the vault.',
    {
      node_id: z.string().describe('Vault-relative file path of the node to rename, e.g. "people/alice.md"'),
      new_title: z.string().describe('New title for the node'),
      new_path: z.string().optional()
        .describe('Explicit new file path. If omitted, derived from new_title via schema filename_template.'),
    },
    async (params) => {
      try {
        return renameNode(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/rename-node.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/rename-node.test.ts
git commit -m "add rename-node error handling and tool registration"
```

---

### Task 4: Source file rename (happy path)

**Files:**
- Modify: `src/mcp/server.ts` (replace TODO with core pipeline)
- Modify: `tests/mcp/rename-node.test.ts`

- [ ] **Step 1: Write failing tests for source file rename**

Add to `tests/mcp/rename-node.test.ts`:

```typescript
  it('renames source file — title changes and file moves', async () => {
    await createTestNode({ title: 'Alice', fields: { status: 'active' } });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);

    // New node at new path
    expect(parsed.node.id).toBe('Alice Smith.md');
    expect(parsed.old_path).toBe('Alice.md');
    expect(parsed.new_path).toBe('Alice Smith.md');

    // New file exists, old file deleted
    expect(existsSync(join(vaultPath, 'Alice Smith.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Alice.md'))).toBe(false);

    // New file has updated title
    const content = readFileSync(join(vaultPath, 'Alice Smith.md'), 'utf-8');
    expect(content).toContain('title: Alice Smith');

    // Fields preserved
    expect(content).toContain('status: active');

    // DB updated: old node gone, new node exists
    const oldNode = db.prepare('SELECT id FROM nodes WHERE id = ?').get('Alice.md');
    expect(oldNode).toBeUndefined();
    const newNode = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get('Alice Smith.md') as { id: string; title: string };
    expect(newNode.title).toBe('Alice Smith');
  });

  it('uses explicit new_path when provided', async () => {
    await createTestNode({ title: 'Alice' });

    const result = await callRename({
      node_id: 'Alice.md',
      new_title: 'Alice Smith',
      new_path: 'people/alice-smith.md',
    });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);

    expect(parsed.node.id).toBe('people/alice-smith.md');
    expect(existsSync(join(vaultPath, 'people/alice-smith.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Alice.md'))).toBe(false);
  });

  it('handles self-references in body', async () => {
    await createTestNode({
      title: 'Alice',
      body: 'This is [[Alice]] talking about herself.',
    });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();

    const content = readFileSync(join(vaultPath, 'Alice Smith.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
  });

  it('handles self-references in frontmatter fields', async () => {
    await createTestNode({
      title: 'Alice',
      fields: { see_also: '[[Alice]]' },
    });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();

    const content = readFileSync(join(vaultPath, 'Alice Smith.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
  });
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run tests/mcp/rename-node.test.ts`
Expected: New tests FAIL — renameNode returns current node (TODO stub), not the renamed node

- [ ] **Step 3: Replace TODO with core rename pipeline**

Replace the `// TODO: implement rename pipeline (Tasks 4-5)` line and the `return returnCurrentNode(node_id);` below it in the `renameNode` function with:

```typescript
    // Find referencing files (excluding self)
    const referencingRows = db.prepare(`
      SELECT DISTINCT source_id FROM relationships
      WHERE (resolved_target_id = ? OR LOWER(target_id) = LOWER(?))
        AND source_id != ?
    `).all(node_id, oldTitle, node_id) as Array<{ source_id: string }>;

    // Update source file: self-references first (while content has old title), then serialize with new title
    const updatedSourceFields = updateFrontmatterReferences(existingFields, oldTitle, new_title);
    const sourceBody = updateBodyReferences(parsed.contentMd, oldTitle, new_title);

    const fieldOrder = computeFieldOrder(types, db);
    const sourceContent = serializeNode({
      title: new_title,
      types,
      fields: updatedSourceFields,
      body: sourceBody || undefined,
      fieldOrder,
    });

    // Write new file, delete old
    writeNodeFile(vaultPath, newPath, sourceContent);
    if (newPath !== node_id) {
      deleteNodeFile(vaultPath, node_id);
    }

    // Update referencing files
    const updatedRefs: Array<{ path: string; content: string }> = [];
    for (const { source_id } of referencingRows) {
      const refAbsPath = join(vaultPath, source_id);
      if (!existsSync(refAbsPath)) continue;

      const refRaw = readFileSync(refAbsPath, 'utf-8');
      const refParsed = parseFile(source_id, refRaw);

      // Update body references
      const refBody = updateBodyReferences(refParsed.contentMd, oldTitle, new_title);

      // Update frontmatter references (exclude meta-keys)
      const refFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(refParsed.frontmatter)) {
        if (key === 'title' || key === 'types') continue;
        refFields[key] = value;
      }
      const refUpdatedFields = updateFrontmatterReferences(refFields, oldTitle, new_title);

      const refTitle = typeof refParsed.frontmatter.title === 'string'
        ? refParsed.frontmatter.title
        : source_id.replace(/\.md$/, '').split('/').pop()!;

      const refFieldOrder = computeFieldOrder(refParsed.types, db);
      const refContent = serializeNode({
        title: refTitle,
        types: refParsed.types,
        fields: refUpdatedFields,
        body: refBody || undefined,
        fieldOrder: refFieldOrder,
      });

      writeNodeFile(vaultPath, source_id, refContent);
      updatedRefs.push({ path: source_id, content: refContent });
    }

    // Re-index everything in one transaction
    db.transaction(() => {
      if (newPath !== node_id) {
        deleteFile(db, node_id);
      }

      const newStat = statSync(join(vaultPath, newPath));
      const sourceParsed = parseFile(newPath, sourceContent);
      indexFile(db, sourceParsed, newPath, newStat.mtime.toISOString(), sourceContent);

      for (const { path, content } of updatedRefs) {
        const refStat = statSync(join(vaultPath, path));
        const refParsed = parseFile(path, content);
        indexFile(db, refParsed, path, refStat.mtime.toISOString(), content);
      }

      resolveReferences(db);
    })();

    // Return hydrated node
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(newPath) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    };

    const [node] = hydrateNodes([row]);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          node,
          old_path: node_id,
          new_path: newPath,
          references_updated: updatedRefs.length,
        }),
      }],
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/rename-node.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp/rename-node.test.ts
git commit -m "add rename-node core pipeline with source file rename"
```

---

### Task 5: Vault-wide reference refactoring + edge cases

**Files:**
- Modify: `tests/mcp/rename-node.test.ts`

- [ ] **Step 1: Write failing tests for cross-file reference updates**

Add to `tests/mcp/rename-node.test.ts`:

```typescript
  it('updates body references in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Meeting Notes',
      body: 'Attendees: [[Alice]] and [[Bob]].',
    });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.references_updated).toBe(1);

    // Referencing file updated
    const content = readFileSync(join(vaultPath, 'Meeting Notes.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
    // Other links preserved
    expect(content).toContain('[[Bob]]');
  });

  it('updates frontmatter references in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Task',
      fields: { assignee: '[[Alice]]', status: 'open' },
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Task.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).not.toContain('[[Alice]]');
    expect(content).toContain('status: open');
  });

  it('updates list field references in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Project',
      fields: { members: ['[[Alice]]', '[[Bob]]'] },
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Project.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).toContain('[[Bob]]');
  });

  it('preserves aliases in referencing files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({
      title: 'Notes',
      body: 'Spoke with [[Alice|the boss]] today.',
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Notes.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith|the boss]]');
  });

  it('updates multiple referencing files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'File A', body: 'See [[Alice]].' });
    await createTestNode({ title: 'File B', body: 'Ask [[Alice]].' });
    await createTestNode({ title: 'File C', body: 'No references here.' });

    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    const parsed = parseResult(result);
    expect(parsed.references_updated).toBe(2);

    expect(readFileSync(join(vaultPath, 'File A.md'), 'utf-8')).toContain('[[Alice Smith]]');
    expect(readFileSync(join(vaultPath, 'File B.md'), 'utf-8')).toContain('[[Alice Smith]]');
    // File C unchanged
    expect(readFileSync(join(vaultPath, 'File C.md'), 'utf-8')).not.toContain('Alice Smith');
  });

  it('does not match substring wiki-links in other files', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Alice Cooper' });
    await createTestNode({
      title: 'Notes',
      body: 'See [[Alice]] and [[Alice Cooper]].',
    });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    const content = readFileSync(join(vaultPath, 'Notes.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
    expect(content).toContain('[[Alice Cooper]]');
  });

  it('updates resolved references in DB after rename', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Task', body: '[[Alice]]' });

    await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });

    // Check relationships table: target_id updated to new title, resolved to new path
    const rels = db.prepare(`
      SELECT target_id, resolved_target_id FROM relationships
      WHERE source_id = ?
    `).all('Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const aliceRel = rels.find(r => r.target_id === 'Alice Smith');
    expect(aliceRel).toBeDefined();
    expect(aliceRel!.resolved_target_id).toBe('Alice Smith.md');
  });

  it('catches unresolved references via target_id text match', async () => {
    await createTestNode({ title: 'Alice', fields: { tag: 'a' } });
    await createTestNode({ title: 'Task', body: '[[Alice]]' });

    // Insert a second "Alice" to create ambiguity, then re-resolve to make reference unresolved
    db.prepare(`INSERT INTO nodes (id, file_path, node_type, content_text, title) VALUES (?, ?, 'file', '', ?)`).run(
      'other/Alice.md', 'other/Alice.md', 'Alice'
    );
    db.prepare('UPDATE relationships SET resolved_target_id = NULL WHERE source_id = ?').run('Task.md');

    // The reference is now unresolved, but target_id = "Alice" still matches
    const result = await callRename({ node_id: 'Alice.md', new_title: 'Alice Smith' });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.references_updated).toBe(1);

    const content = readFileSync(join(vaultPath, 'Task.md'), 'utf-8');
    expect(content).toContain('[[Alice Smith]]');
  });

  it('moves file without changing title when only new_path provided', async () => {
    await createTestNode({ title: 'Alice' });
    await createTestNode({ title: 'Task', body: '[[Alice]]' });

    const result = await callRename({
      node_id: 'Alice.md',
      new_title: 'Alice',
      new_path: 'people/Alice.md',
    });
    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.new_path).toBe('people/Alice.md');
    expect(existsSync(join(vaultPath, 'people/Alice.md'))).toBe(true);
    expect(existsSync(join(vaultPath, 'Alice.md'))).toBe(false);

    // References unchanged (title didn't change, so body text stays [[Alice]])
    const taskContent = readFileSync(join(vaultPath, 'Task.md'), 'utf-8');
    expect(taskContent).toContain('[[Alice]]');
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/rename-node.test.ts`
Expected: All tests PASS (the implementation from Task 4 already handles cross-file references)

If any tests fail, debug and fix the implementation accordingly.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/rename-node.test.ts
git commit -m "add rename-node reference refactoring and edge case tests"
```

---

## Post-Implementation

After all tasks complete:
1. Run `npm test` — all tests pass
2. Run `npx tsc --noEmit` — no type errors
3. Verify the tool count is now 11 (7 read + 4 mutation)
