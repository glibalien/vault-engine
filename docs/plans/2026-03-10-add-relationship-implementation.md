# `add-relationship` Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `add-relationship` MCP tool that links nodes via frontmatter fields or body wiki-links, delegating to the existing `updateNode` pipeline.

**Architecture:** A thin `addRelationship` helper inside the `createServer` closure (same pattern as `createNode`/`updateNode`). Routes relationships to frontmatter or body based on schema fields, then delegates to `updateNode`. Deduplication makes the operation idempotent.

**Tech Stack:** TypeScript, vitest, MCP SDK (Zod schemas), better-sqlite3

**Spec:** `docs/plans/2026-03-10-add-relationship-design.md`

---

## File Structure

- **Modify:** `src/mcp/server.ts` — Add `addRelationship` helper + `add-relationship` tool registration
- **Create:** `tests/mcp/add-relationship.test.ts` — All tests for the new tool

## Chunk 1: Implementation

### Task 1: Tool registration + error handling

**Files:**
- Create: `tests/mcp/add-relationship.test.ts`
- Modify: `src/mcp/server.ts:373` (after `updateNode`, before tool registrations)

- [ ] **Step 1: Write error handling tests**

Create `tests/mcp/add-relationship.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSchema } from '../../src/db/schema.js';
import { createServer } from '../../src/mcp/server.js';

describe('add-relationship', () => {
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
    const result = await client.callTool({
      name: 'create-node',
      arguments: args,
    });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  }

  it('returns error when source node does not exist', async () => {
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'nonexistent.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Node not found');
    expect(text).toContain('nonexistent.md');
  });

  it('returns error when file is missing on disk but exists in DB', async () => {
    await createTestNode({ title: 'Ghost' });
    rmSync(join(vaultPath, 'Ghost.md'));

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Ghost.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('File not found on disk');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: FAIL — `add-relationship` tool not registered, MCP call errors.

- [ ] **Step 3: Implement `addRelationship` helper stub + tool registration**

In `src/mcp/server.ts`, after the `updateNode` function (line 373), add:

```typescript
  function addRelationship(params: {
    source_id: string;
    target: string;
    rel_type: string;
  }) {
    const { source_id, target: rawTarget, rel_type } = params;

    // Normalize target to [[...]] syntax
    const target = rawTarget.startsWith('[[') ? rawTarget : `[[${rawTarget}]]`;

    // Check node exists in DB
    const nodeRow = db.prepare('SELECT id FROM nodes WHERE id = ?').get(source_id);
    if (!nodeRow) {
      return {
        content: [{ type: 'text' as const, text: `Error: Node not found: ${source_id}` }],
        isError: true,
      };
    }

    // Check file exists on disk
    const absPath = join(vaultPath, source_id);
    if (!existsSync(absPath)) {
      return {
        content: [{ type: 'text' as const, text: `Error: File not found on disk: ${source_id}. Database and filesystem are out of sync.` }],
        isError: true,
      };
    }

    // Placeholder — body append fallback
    return updateNode({ node_id: source_id, append_body: target });
  }
```

Before the `return server;` line, add the tool registration:

```typescript
  server.tool(
    'add-relationship',
    'Add a relationship from one node to another. Routes to frontmatter field or body wiki-link based on schema.',
    {
      source_id: z.string().describe('Vault-relative file path of the source node, e.g. "tasks/review.md"'),
      target: z.string().describe('Wiki-link target, e.g. "Alice" or "[[Alice]]"'),
      rel_type: z.string().describe('Relationship type — schema field name for frontmatter, or "wiki-link" for body'),
    },
    async (params) => {
      try {
        return addRelationship(params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/add-relationship.test.ts src/mcp/server.ts
git commit -m "add add-relationship error handling tests and tool registration"
```

---

### Task 2: Scalar frontmatter relationship with schema

**Files:**
- Modify: `tests/mcp/add-relationship.test.ts`
- Modify: `src/mcp/server.ts` (inside `addRelationship`)

- [ ] **Step 1: Write the test**

Add to the test file:

```typescript
  it('sets scalar reference field via schema (task assignee)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Review PR',
      types: ['task'],
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Review PR.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.node.fields.assignee).toBe('[[Alice]]');

    // Verify file content
    const content = readFileSync(join(vaultPath, 'tasks/Review PR.md'), 'utf-8');
    expect(content).toContain('assignee: "[[Alice]]"');
    // Existing fields preserved
    expect(content).toContain('status: todo');
  });

  it('overwrites existing scalar reference field via schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Reassign Task',
      types: ['task'],
      fields: { status: 'todo' },
      relationships: [{ target: 'Alice', rel_type: 'assignee' }],
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Reassign Task.md',
        target: 'Bob',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Reassign Task.md'), 'utf-8');
    expect(content).toContain('[[Bob]]');
    expect(content).not.toContain('[[Alice]]');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/add-relationship.test.ts -t "sets scalar reference field"`
Expected: FAIL — current stub just appends to body, doesn't route to frontmatter.

- [ ] **Step 3: Implement schema-based routing**

Replace the placeholder section in `addRelationship` (everything after the disk existence check) with the full routing logic:

```typescript
    // Read + parse existing file
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseFile(source_id, raw);
    const types = parsed.types;

    // Extract inner target for comparison (strips [[ ]] and alias)
    const innerTarget = target.match(/^\[\[([^\]|]+)/)?.[1] ?? '';

    // Force body if rel_type is 'wiki-link'
    if (rel_type === 'wiki-link') {
      const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
      if (bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
        return returnCurrentNode(source_id);
      }
      return updateNode({ node_id: source_id, append_body: target });
    }

    // Check schemas
    const schemaCheck = db.prepare('SELECT 1 FROM schemas WHERE name = ?');
    const hasSchemas = types.some(t => schemaCheck.get(t) !== undefined);

    if (hasSchemas) {
      const mergeResult = mergeSchemaFields(db, types);
      const mergedField = mergeResult.fields[rel_type];

      if (mergedField) {
        const isListType = mergedField.type.startsWith('list<');
        if (isListType) {
          const existing = parsed.frontmatter[rel_type];
          const currentArray: unknown[] = Array.isArray(existing) ? existing : (existing != null ? [existing] : []);
          const alreadyExists = currentArray.some((item: unknown) => {
            if (typeof item !== 'string') return false;
            const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
            return inner != null && inner.toLowerCase() === innerTarget.toLowerCase();
          });
          if (alreadyExists) {
            return returnCurrentNode(source_id);
          }
          return updateNode({
            node_id: source_id,
            fields: { [rel_type]: [...currentArray, target] },
          });
        } else {
          // Scalar field
          return updateNode({
            node_id: source_id,
            fields: { [rel_type]: target },
          });
        }
      }
    }

    // Schema-less fallback: check existing frontmatter
    if (!hasSchemas && rel_type !== 'title' && rel_type !== 'types') {
      const existing = parsed.frontmatter[rel_type];
      if (Array.isArray(existing)) {
        const alreadyExists = existing.some((item: unknown) => {
          if (typeof item !== 'string') return false;
          const inner = item.match(/^\[\[([^\]|]+)/)?.[1];
          return inner != null && inner.toLowerCase() === innerTarget.toLowerCase();
        });
        if (alreadyExists) {
          return returnCurrentNode(source_id);
        }
        return updateNode({
          node_id: source_id,
          fields: { [rel_type]: [...existing, target] },
        });
      } else if (rel_type in parsed.frontmatter && rel_type !== 'title' && rel_type !== 'types') {
        return updateNode({
          node_id: source_id,
          fields: { [rel_type]: target },
        });
      }
    }

    // Body fallback
    const bodyLinks = parsed.wikiLinks.filter(l => l.source === 'body');
    if (bodyLinks.some(l => l.target.toLowerCase() === innerTarget.toLowerCase())) {
      return returnCurrentNode(source_id);
    }
    return updateNode({ node_id: source_id, append_body: target });
```

Also add the `returnCurrentNode` helper inside `createServer`, next to `addRelationship`:

```typescript
  function returnCurrentNode(nodeId: string) {
    const row = db.prepare(`
      SELECT id, file_path, node_type, content_text, content_md, updated_at
      FROM nodes WHERE id = ?
    `).get(nodeId) as {
      id: string; file_path: string; node_type: string;
      content_text: string; content_md: string | null; updated_at: string;
    };
    const [node] = hydrateNodes([row]);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ node, warnings: [] }) }],
    };
  }
```

Note: This implements the entire routing logic at once. The remaining tasks add tests to verify each routing path works correctly. Implementing all routing in one step avoids repeatedly modifying the same function body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/add-relationship.test.ts src/mcp/server.ts
git commit -m "add add-relationship scalar frontmatter routing with full routing logic"
```

---

### Task 3: List frontmatter relationship with schema

**Files:**
- Modify: `tests/mcp/add-relationship.test.ts`

- [ ] **Step 1: Write the tests**

Add to the test file:

```typescript
  it('appends to list reference field via schema (meeting attendees)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Sprint Review',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Sprint Review.md',
        target: 'Alice',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Sprint Review.md'), 'utf-8');
    expect(content).toContain('[[Alice]]');
  });

  it('appends second attendee to existing list', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Team Sync',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Team Sync.md',
        target: 'Bob',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'meetings/2026-03-09-Team Sync.md'), 'utf-8');
    expect(content).toContain('[[Alice]]');
    expect(content).toContain('[[Bob]]');
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (6 tests) — routing logic already handles list fields.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/add-relationship.test.ts
git commit -m "add add-relationship list frontmatter tests"
```

---

### Task 4: Body relationship routing

**Files:**
- Modify: `tests/mcp/add-relationship.test.ts`

- [ ] **Step 1: Write the tests**

Add to the test file:

```typescript
  it('appends wiki-link to body when rel_type is wiki-link', async () => {
    await createTestNode({
      title: 'Research Note',
      body: 'Some initial thoughts.',
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Research Note.md',
        target: 'Related Paper',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Research Note.md'), 'utf-8');
    expect(content).toContain('Some initial thoughts.');
    expect(content).toContain('[[Related Paper]]');
  });

  it('appends to body when rel_type has no matching schema field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Tagged Task',
      types: ['task'],
      fields: { status: 'todo' },
      body: 'Task details here.',
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Tagged Task.md',
        target: 'SomeProject',
        rel_type: 'unknown_field',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Tagged Task.md'), 'utf-8');
    expect(content).toContain('Task details here.');
    expect(content).toContain('[[SomeProject]]');
  });

  it('appends wiki-link to body when node has no existing body', async () => {
    await createTestNode({ title: 'Empty Body' });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Empty Body.md',
        target: 'Reference',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Empty Body.md'), 'utf-8');
    expect(content).toContain('[[Reference]]');
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/add-relationship.test.ts
git commit -m "add add-relationship body routing tests"
```

---

### Task 5: Deduplication

**Files:**
- Modify: `tests/mcp/add-relationship.test.ts`

- [ ] **Step 1: Write the tests**

Add to the test file:

```typescript
  it('skips duplicate in list field (idempotent)', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Dedup Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const contentBefore = readFileSync(join(vaultPath, 'meetings/2026-03-09-Dedup Meeting.md'), 'utf-8');

    // Add same attendee again
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Dedup Meeting.md',
        target: 'Alice',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    // File should be unchanged
    const contentAfter = readFileSync(join(vaultPath, 'meetings/2026-03-09-Dedup Meeting.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('deduplicates case-insensitively in list field', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Case Meeting',
      types: ['meeting'],
      fields: { date: '2026-03-09' },
      relationships: [{ target: 'Alice', rel_type: 'attendees' }],
    });

    const contentBefore = readFileSync(join(vaultPath, 'meetings/2026-03-09-Case Meeting.md'), 'utf-8');

    // Add same attendee with different casing
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'meetings/2026-03-09-Case Meeting.md',
        target: 'alice',
        rel_type: 'attendees',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'meetings/2026-03-09-Case Meeting.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('skips duplicate body wiki-link (idempotent)', async () => {
    await createTestNode({
      title: 'Linked Note',
      body: 'See also [[Related Topic]] for context.',
    });

    const contentBefore = readFileSync(join(vaultPath, 'Linked Note.md'), 'utf-8');

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Linked Note.md',
        target: 'Related Topic',
        rel_type: 'wiki-link',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'Linked Note.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('skips duplicate body link via fallback routing', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // Create task with body containing a wiki-link
    await createTestNode({
      title: 'Fallback Dedup',
      types: ['task'],
      fields: { status: 'todo' },
      body: 'Related to [[ProjectX]] work.',
    });

    const contentBefore = readFileSync(join(vaultPath, 'tasks/Fallback Dedup.md'), 'utf-8');

    // Try adding same link via unmatched rel_type (falls to body)
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Fallback Dedup.md',
        target: 'ProjectX',
        rel_type: 'unknown_field',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'tasks/Fallback Dedup.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/add-relationship.test.ts
git commit -m "add add-relationship deduplication tests"
```

---

### Task 6: Schema-less fallback

**Files:**
- Modify: `tests/mcp/add-relationship.test.ts`

- [ ] **Step 1: Write the tests**

Add to the test file:

```typescript
  it('appends to existing array field without schema', async () => {
    await createTestNode({
      title: 'Tagless Node',
      fields: { tags: ['[[Alpha]]', '[[Beta]]'] },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Tagless Node.md',
        target: 'Gamma',
        rel_type: 'tags',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Tagless Node.md'), 'utf-8');
    expect(content).toContain('[[Alpha]]');
    expect(content).toContain('[[Beta]]');
    expect(content).toContain('[[Gamma]]');
  });

  it('overwrites existing scalar field without schema', async () => {
    await createTestNode({
      title: 'Scalar Override',
      fields: { owner: '[[OldPerson]]' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Scalar Override.md',
        target: 'NewPerson',
        rel_type: 'owner',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'Scalar Override.md'), 'utf-8');
    expect(content).toContain('[[NewPerson]]');
    expect(content).not.toContain('[[OldPerson]]');
  });

  it('falls back to body when no schema and field does not exist', async () => {
    await createTestNode({
      title: 'No Field',
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'No Field.md',
        target: 'Somewhere',
        rel_type: 'related',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'No Field.md'), 'utf-8');
    expect(content).toContain('[[Somewhere]]');
    // Should be in body, not frontmatter
    const [frontmatter, body] = content.split('---').slice(1);
    expect(frontmatter).not.toContain('related');
  });

  it('deduplicates in schema-less array field', async () => {
    await createTestNode({
      title: 'Dedup Tagless',
      fields: { refs: ['[[Alice]]'] },
    });

    const contentBefore = readFileSync(join(vaultPath, 'Dedup Tagless.md'), 'utf-8');

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'Dedup Tagless.md',
        target: 'Alice',
        rel_type: 'refs',
      },
    });

    expect(result.isError).toBeFalsy();
    const contentAfter = readFileSync(join(vaultPath, 'Dedup Tagless.md'), 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/add-relationship.test.ts
git commit -m "add add-relationship schema-less fallback tests"
```

---

### Task 7: Target normalization + reference resolution integration

**Files:**
- Modify: `tests/mcp/add-relationship.test.ts`

- [ ] **Step 1: Write the tests**

Add to the test file:

```typescript
  it('normalizes bare target to [[target]] syntax', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Bare Target',
      types: ['task'],
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Bare Target.md',
        target: 'Bob',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Bare Target.md'), 'utf-8');
    expect(content).toContain('[[Bob]]');
    expect(content).not.toContain('[[[[');
  });

  it('does not double-wrap already bracketed target', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    await createTestNode({
      title: 'Wrapped Target',
      types: ['task'],
      fields: { status: 'todo' },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Wrapped Target.md',
        target: '[[Charlie]]',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const content = readFileSync(join(vaultPath, 'tasks/Wrapped Target.md'), 'utf-8');
    expect(content).toContain('assignee: "[[Charlie]]"');
    expect(content).not.toContain('[[[[');
  });

  it('resolves references after adding relationship', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    const { writeFileSync: fsWriteFileSync, mkdirSync: fsMkdirSync } = await import('node:fs');
    const { parseFile: parseFileSync } = await import('../../src/parser/index.js');
    const { indexFile: indexFileSync } = await import('../../src/sync/indexer.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // Create target node (Alice) on disk and index it
    const aliceContent = '---\ntitle: Alice\ntypes: [person]\n---\n';
    fsMkdirSync(join(vaultPath, 'people'), { recursive: true });
    fsWriteFileSync(join(vaultPath, 'people/Alice.md'), aliceContent, 'utf-8');
    const aliceParsed = parseFileSync('people/Alice.md', aliceContent);
    db.transaction(() => {
      indexFileSync(db, aliceParsed, 'people/Alice.md', new Date().toISOString(), aliceContent);
    })();

    // Create a task without a relationship
    await createTestNode({
      title: 'Unlinked Task',
      types: ['task'],
      fields: { status: 'todo' },
    });

    // Add the relationship
    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Unlinked Task.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();

    // Check relationship is resolved in DB
    const rels = db.prepare(
      'SELECT target_id, resolved_target_id FROM relationships WHERE source_id = ?'
    ).all('tasks/Unlinked Task.md') as Array<{ target_id: string; resolved_target_id: string | null }>;

    const assigneeRel = rels.find(r => r.target_id === 'Alice');
    expect(assigneeRel).toBeDefined();
    expect(assigneeRel!.resolved_target_id).toBe('people/Alice.md');
  });

  it('returns validation warnings from schema', async () => {
    const { loadSchemas } = await import('../../src/schema/loader.js');
    loadSchemas(db, join(import.meta.dirname, '../fixtures'));

    // Create task missing required 'status' field
    await createTestNode({
      title: 'Warn Task',
      types: ['task'],
      fields: { status: 'todo' },
    });

    // Remove status via update-node, then add-relationship
    await client.callTool({
      name: 'update-node',
      arguments: {
        node_id: 'tasks/Warn Task.md',
        fields: { status: null },
      },
    });

    const result = await client.callTool({
      name: 'add-relationship',
      arguments: {
        source_id: 'tasks/Warn Task.md',
        target: 'Alice',
        rel_type: 'assignee',
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // Should have warning about missing required 'status'
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings.some((w: any) => w.rule === 'required')).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/add-relationship.test.ts`
Expected: PASS (21 tests)

- [ ] **Step 3: Run full test suite to check for regressions**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/add-relationship.test.ts
git commit -m "add add-relationship integration tests and target normalization tests"
```
