# Linked Node Traversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `expand` parameter to the `get-node` MCP tool that fetches one-hop, type-filtered, mtime-ranked neighbor nodes so callers can read a node's neighborhood in a single round-trip.

**Architecture:** Keep `get-node` as the sole entry point. Extract expansion logic into a new `src/mcp/expand.ts` module with four pure functions: candidate-set building, type filtering + mtime sort, payload fetch, and an orchestrator. The handler in `get-node.ts` validates `expand` params, calls the orchestrator, and attaches `expanded` + `expand_stats` to the response envelope. No new tools.

**Tech Stack:** TypeScript (ESM), better-sqlite3, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-04-20-linked-node-traversal-design.md`

---

## File Structure

**Create:**
- `src/mcp/expand.ts` — traversal logic: types, candidate set, type filter + mtime sort, payload fetch, orchestrator
- `tests/mcp/expand.test.ts` — unit tests for `src/mcp/expand.ts` against in-memory DB fixtures
- `tests/mcp/get-node-expand.test.ts` — end-to-end tests exercising `get-node` with `expand`

**Modify:**
- `src/mcp/tools/get-node.ts` — add `expand` to `paramsShape`, call orchestrator when present, attach response fields

---

## Task 1: Add `expand` schema to `get-node` params (no behavior yet)

**Files:**
- Modify: `src/mcp/tools/get-node.ts:12-18`
- Test: `tests/mcp/get-node-expand.test.ts`

- [ ] **Step 1: Create the test file with validation tests**

Create `tests/mcp/get-node-expand.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getHandler() {
  let capturedHandler: (params: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (params) => handler(params);
    },
  } as unknown as McpServer;
  registerGetNode(fakeServer, db);
  return capturedHandler!;
}

function seedNode(id: string, filePath: string, title: string, body: string, mtime = 1000) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, mtime, 2000);
}

beforeEach(() => {
  db = createTestDb();
});

describe('get-node expand parameter — validation', () => {
  it('rejects empty types array', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: [] } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects max_nodes greater than 25', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'], max_nodes: 26 } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects max_nodes less than 1', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'], max_nodes: 0 } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('rejects invalid direction', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'], direction: 'sideways' } }) as any);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_PARAMS');
  });

  it('accepts valid expand with defaults applied', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1', expand: { types: ['note'] } }) as any);
    expect(env.ok).toBe(true);
    // expand fields may or may not exist yet; validation alone must pass.
  });

  it('leaves response unchanged when expand is omitted', async () => {
    seedNode('n1', 'notes/n1.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'n1' }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expanded).toBeUndefined();
    expect(env.data.expand_stats).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/get-node-expand.test.ts`
Expected: validation tests FAIL (zod currently accepts any `expand` object). "accepts valid expand" and "leaves response unchanged" should PASS.

- [ ] **Step 3: Add the zod schema to `paramsShape`**

In `src/mcp/tools/get-node.ts`, replace the `paramsShape` block (lines 12–18):

```typescript
const paramsShape = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  include_embeds: z.boolean().optional().default(true),
  max_embeds: z.number().optional().default(20),
  expand: z.object({
    types: z.array(z.string()).min(1, 'types must be non-empty'),
    direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('outgoing'),
    max_nodes: z.number().int().min(1).max(25).optional().default(10),
  }).optional(),
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/get-node-expand.test.ts`
Expected: All six tests PASS. Validation errors are now zod-rejected and the MCP SDK surfaces them as `INVALID_PARAMS` envelope errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get-node.ts tests/mcp/get-node-expand.test.ts
git commit -m "feat(get-node): add expand param schema with validation"
```

---

## Task 2: Create `src/mcp/expand.ts` skeleton with types and orchestrator stub

**Files:**
- Create: `src/mcp/expand.ts`
- Test: `tests/mcp/expand.test.ts`

- [ ] **Step 1: Write the skeleton test**

Create `tests/mcp/expand.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { performExpansion, type ExpandOptions } from '../../src/mcp/expand.js';

let db: Database.Database;

function seedNode(id: string, filePath: string, title: string, body: string, mtime = 1000) {
  db.prepare(
    'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, filePath, title, body, `hash-${id}`, mtime, 2000);
}

beforeEach(() => {
  db = createTestDb();
});

describe('performExpansion — skeleton', () => {
  it('returns empty result for a root with no relationships', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    const options: ExpandOptions = { types: ['note'], direction: 'outgoing', max_nodes: 10 };
    const result = performExpansion(db, 'root', options);
    expect(result.expanded).toEqual({});
    expect(result.stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: FAIL — `src/mcp/expand.ts` does not exist.

- [ ] **Step 3: Create the module skeleton**

Create `src/mcp/expand.ts`:

```typescript
import type Database from 'better-sqlite3';

export interface ExpandOptions {
  types: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  max_nodes: number;
}

export interface ExpandedNode {
  id: string;
  title: string | null;
  types: string[];
  fields: Record<string, { value: unknown; type: string; source: string }>;
  body: string | null;
}

export interface ExpandStats {
  returned: number;
  considered: number;
  truncated: boolean;
}

export interface ExpandResult {
  expanded: Record<string, ExpandedNode>;
  stats: ExpandStats;
}

export function performExpansion(
  _db: Database.Database,
  _rootId: string,
  _options: ExpandOptions,
): ExpandResult {
  return {
    expanded: {},
    stats: { returned: 0, considered: 0, truncated: false },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/expand.ts tests/mcp/expand.test.ts
git commit -m "feat(expand): add expansion module skeleton"
```

---

## Task 3: Build candidate set from outgoing relationships

**Files:**
- Modify: `src/mcp/expand.ts`
- Test: `tests/mcp/expand.test.ts`

- [ ] **Step 1: Add outgoing candidate tests**

Append to `tests/mcp/expand.test.ts` (inside or below the existing `describe`):

```typescript
function seedRel(sourceId: string, target: string, relType: string, context: string | null = null) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
  ).run(sourceId, target, relType, context);
}

function seedType(nodeId: string, schemaType: string) {
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(nodeId, schemaType);
}

describe('performExpansion — outgoing candidates', () => {
  it('collects outgoing targets that resolve to existing nodes', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedNode('b', 'notes/b.md', 'B', 'b body');
    seedType('a', 'note');
    seedType('b', 'note');
    // target is stored as the literal link text; get-node resolves to an id via title match
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'B', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(2);
  });

  it('skips outgoing targets that do not resolve', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'Nonexistent', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1); // unresolved not counted
  });

  it('excludes self-reference', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedType('root', 'note');
    seedRel('root', 'Root', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(0);
  });

  it('dedupes targets reached via multiple rel_types', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'A', 'project');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1);
  });
});

// Note: these tests intentionally assert only on stats.considered at this stage.
// Task 7 adds tests that verify the populated `expanded` map for the same fixtures.
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: FAIL — the stub returns empty for all inputs.

- [ ] **Step 3: Implement candidate building**

Replace the `performExpansion` body in `src/mcp/expand.ts` with:

```typescript
import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import { resolveTarget } from '../resolver/resolve.js';
import { resolveFieldValue, type FieldRow } from './field-value.js';

export interface ExpandOptions {
  types: string[];
  direction: 'outgoing' | 'incoming' | 'both';
  max_nodes: number;
}

export interface ExpandedNode {
  id: string;
  title: string | null;
  types: string[];
  fields: Record<string, { value: unknown; type: string; source: string }>;
  body: string | null;
}

export interface ExpandStats {
  returned: number;
  considered: number;
  truncated: boolean;
}

export interface ExpandResult {
  expanded: Record<string, ExpandedNode>;
  stats: ExpandStats;
}

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  file_mtime: number | null;
}

function collectOutgoingCandidates(db: Database.Database, rootId: string): Set<string> {
  const rows = db.prepare('SELECT target FROM relationships WHERE source_id = ?').all(rootId) as Array<{ target: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    const byTitle = db.prepare('SELECT id FROM nodes WHERE title = ?').get(row.target) as { id: string } | undefined;
    const candidateId = byTitle?.id ?? resolveTarget(db, row.target)?.id ?? null;
    if (candidateId && candidateId !== rootId) ids.add(candidateId);
  }
  return ids;
}

export function performExpansion(
  db: Database.Database,
  rootId: string,
  options: ExpandOptions,
): ExpandResult {
  const candidates = new Set<string>();

  if (options.direction === 'outgoing' || options.direction === 'both') {
    for (const id of collectOutgoingCandidates(db, rootId)) candidates.add(id);
  }

  // Incoming + type filter + ranking + payload fetch added in later tasks.
  if (candidates.size === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const considered = candidates.size;
  // Placeholder: return empty payloads, full shape filled in Task 7.
  return {
    expanded: {},
    stats: { returned: 0, considered, truncated: false },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: the four new outgoing-candidate tests PASS. (They assert only on `stats.considered`.)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/expand.ts tests/mcp/expand.test.ts
git commit -m "feat(expand): build outgoing candidate set with dedupe and self-reference guard"
```

---

## Task 4: Add incoming candidate collection and direction handling

**Files:**
- Modify: `src/mcp/expand.ts`
- Test: `tests/mcp/expand.test.ts`

- [ ] **Step 1: Add incoming + direction tests**

Append to `tests/mcp/expand.test.ts`:

```typescript
describe('performExpansion — direction', () => {
  it('direction=incoming collects sources that link to the root', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('x', 'notes/x.md', 'X', 'x body');
    seedNode('y', 'notes/y.md', 'Y', 'y body');
    seedType('x', 'note');
    seedType('y', 'note');
    // relationships.target uses the literal link text; get-node matches file_path, basename, or title
    seedRel('x', 'Root', 'wiki-link');
    seedRel('y', 'root', 'wiki-link'); // basename of notes/root.md

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'incoming', max_nodes: 10 });
    expect(result.stats.considered).toBe(2);
  });

  it('direction=both unions and dedupes', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body');
    seedNode('b', 'notes/b.md', 'B', 'b body');
    seedType('a', 'note');
    seedType('b', 'note');
    seedRel('root', 'A', 'wiki-link'); // outgoing
    seedRel('b', 'Root', 'wiki-link'); // incoming
    seedRel('a', 'Root', 'wiki-link'); // also incoming — dedupe with outgoing 'a'

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'both', max_nodes: 10 });
    expect(result.stats.considered).toBe(2); // a and b — not 3
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: both new tests FAIL (incoming not yet implemented).

- [ ] **Step 3: Add `collectIncomingCandidates` and wire it in**

In `src/mcp/expand.ts`, add below `collectOutgoingCandidates`:

```typescript
function collectIncomingCandidates(db: Database.Database, rootNode: NodeRow): Set<string> {
  const nodeBasename = basename(rootNode.file_path, '.md');
  const rows = db.prepare(
    'SELECT source_id FROM relationships WHERE (target = ? OR target = ? OR target = ?) AND source_id != ?'
  ).all(rootNode.file_path, nodeBasename, rootNode.title ?? '', rootNode.id) as Array<{ source_id: string }>;
  const ids = new Set<string>();
  for (const row of rows) ids.add(row.source_id);
  return ids;
}
```

Replace the top of `performExpansion` so it fetches the root row and branches on direction:

```typescript
export function performExpansion(
  db: Database.Database,
  rootId: string,
  options: ExpandOptions,
): ExpandResult {
  const rootNode = db.prepare('SELECT id, file_path, title, body, file_mtime FROM nodes WHERE id = ?').get(rootId) as NodeRow | undefined;
  if (!rootNode) return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };

  const candidates = new Set<string>();

  if (options.direction === 'outgoing' || options.direction === 'both') {
    for (const id of collectOutgoingCandidates(db, rootId)) candidates.add(id);
  }
  if (options.direction === 'incoming' || options.direction === 'both') {
    for (const id of collectIncomingCandidates(db, rootNode)) candidates.add(id);
  }

  if (candidates.size === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const considered = candidates.size;
  return {
    expanded: {},
    stats: { returned: 0, considered, truncated: false },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: the two new direction tests PASS on `considered` counts.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/expand.ts tests/mcp/expand.test.ts
git commit -m "feat(expand): collect incoming candidates and honor direction param"
```

---

## Task 5: Filter candidates by type

**Files:**
- Modify: `src/mcp/expand.ts`
- Test: `tests/mcp/expand.test.ts`

- [ ] **Step 1: Add type-filter tests**

Append to `tests/mcp/expand.test.ts`:

```typescript
describe('performExpansion — type filter', () => {
  it('drops candidates without a matching type', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('p', 'notes/p.md', 'P', 'person body');
    seedNode('m', 'notes/m.md', 'M', 'meeting body');
    seedType('p', 'person');
    seedType('m', 'meeting');
    seedRel('root', 'P', 'wiki-link');
    seedRel('root', 'M', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['meeting'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1); // p filtered out pre-sort
  });

  it('keeps candidates whose types intersect the filter', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('mt', 'notes/mt.md', 'MT', 'multi-typed body');
    seedType('mt', 'person');
    seedType('mt', 'meeting');
    seedRel('root', 'MT', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['meeting'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats.considered).toBe(1);
  });

  it('returns empty when no candidate matches any requested type', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('p', 'notes/p.md', 'P', 'person body');
    seedType('p', 'person');
    seedRel('root', 'P', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['meeting'], direction: 'outgoing', max_nodes: 10 });
    expect(result.expanded).toEqual({});
    expect(result.stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: new tests FAIL — type filter not yet applied, so `considered` still counts all candidates.

- [ ] **Step 3: Add type filtering**

In `src/mcp/expand.ts`, add below the existing candidate-collection helpers:

```typescript
function filterCandidatesByType(
  db: Database.Database,
  candidateIds: string[],
  allowedTypes: string[],
): string[] {
  if (candidateIds.length === 0 || allowedTypes.length === 0) return [];
  const idPlaceholders = candidateIds.map(() => '?').join(',');
  const typePlaceholders = allowedTypes.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT node_id FROM node_types
     WHERE node_id IN (${idPlaceholders}) AND schema_type IN (${typePlaceholders})`
  ).all(...candidateIds, ...allowedTypes) as Array<{ node_id: string }>;
  const matched = new Set(rows.map(r => r.node_id));
  return candidateIds.filter(id => matched.has(id));
}
```

Update `performExpansion` to apply the filter after candidate collection:

```typescript
  // (candidates collected above)
  if (candidates.size === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const filtered = filterCandidatesByType(db, Array.from(candidates), options.types);
  if (filtered.length === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const considered = filtered.length;
  return {
    expanded: {},
    stats: { returned: 0, considered, truncated: false },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: the three new type-filter tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/expand.ts tests/mcp/expand.test.ts
git commit -m "feat(expand): filter candidates by type intersection"
```

---

## Task 6: Rank by `file_mtime DESC` and truncate to `max_nodes`

**Files:**
- Modify: `src/mcp/expand.ts`
- Test: `tests/mcp/expand.test.ts`

- [ ] **Step 1: Add ranking + truncation tests**

Append to `tests/mcp/expand.test.ts`:

```typescript
describe('performExpansion — ranking and truncation', () => {
  it('sorts candidates by file_mtime DESC', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('old', 'notes/old.md', 'Old', 'old body', 500);
    seedNode('new', 'notes/new.md', 'New', 'new body', 2000);
    seedNode('mid', 'notes/mid.md', 'Mid', 'mid body', 1000);
    seedType('old', 'note');
    seedType('new', 'note');
    seedType('mid', 'note');
    seedRel('root', 'Old', 'wiki-link');
    seedRel('root', 'New', 'wiki-link');
    seedRel('root', 'Mid', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 2 });
    // Take top 2 by mtime desc: new, mid
    const ids = Object.keys(result.expanded);
    expect(ids.sort()).toEqual(['mid', 'new']);
    expect(result.stats).toEqual({ returned: 2, considered: 3, truncated: true });
  });

  it('sorts null file_mtime last', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('hasmtime', 'notes/h.md', 'H', 'h body', 1000);
    // insert a null-mtime row directly
    db.prepare(
      'INSERT INTO nodes (id, file_path, title, body, content_hash, file_mtime, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('nullmtime', 'notes/nm.md', 'NM', 'nm body', 'hash-nm', null, 2000);
    seedType('hasmtime', 'note');
    seedType('nullmtime', 'note');
    seedRel('root', 'H', 'wiki-link');
    seedRel('root', 'NM', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 1 });
    expect(Object.keys(result.expanded)).toEqual(['hasmtime']);
    expect(result.stats).toEqual({ returned: 1, considered: 2, truncated: true });
  });

  it('breaks mtime ties by id ASC deterministically', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('zzz', 'notes/zzz.md', 'Zzz', 'z body', 1000);
    seedNode('aaa', 'notes/aaa.md', 'Aaa', 'a body', 1000);
    seedType('zzz', 'note');
    seedType('aaa', 'note');
    seedRel('root', 'Zzz', 'wiki-link');
    seedRel('root', 'Aaa', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 1 });
    expect(Object.keys(result.expanded)).toEqual(['aaa']);
  });

  it('truncated=false when candidates fit under max_nodes', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.stats).toEqual({ returned: 1, considered: 1, truncated: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: all four new tests FAIL — `expanded` is still empty.

- [ ] **Step 3: Add `rankAndTruncate` and wire into orchestrator**

In `src/mcp/expand.ts`, add:

```typescript
function rankAndTruncate(
  db: Database.Database,
  filteredIds: string[],
  maxNodes: number,
): { ordered: NodeRow[]; truncated: boolean } {
  if (filteredIds.length === 0) return { ordered: [], truncated: false };
  const placeholders = filteredIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, file_path, title, body, file_mtime FROM nodes
     WHERE id IN (${placeholders})
     ORDER BY file_mtime IS NULL, file_mtime DESC, id ASC
     LIMIT ?`
  ).all(...filteredIds, maxNodes + 1) as NodeRow[];
  const truncated = rows.length > maxNodes;
  return { ordered: rows.slice(0, maxNodes), truncated };
}
```

Update `performExpansion` to call it. Replace the section after `filterCandidatesByType`:

```typescript
  const filtered = filterCandidatesByType(db, Array.from(candidates), options.types);
  if (filtered.length === 0) {
    return { expanded: {}, stats: { returned: 0, considered: 0, truncated: false } };
  }

  const considered = filtered.length;
  const { ordered, truncated } = rankAndTruncate(db, filtered, options.max_nodes);
  const expanded: Record<string, ExpandedNode> = {};
  for (const row of ordered) {
    expanded[row.id] = {
      id: row.id,
      title: row.title,
      types: [], // fields + types filled in Task 7
      fields: {},
      body: row.body,
    };
  }
  return {
    expanded,
    stats: { returned: ordered.length, considered, truncated },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: all four ranking/truncation tests PASS (they only assert on `Object.keys(expanded)` and `stats`).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/expand.ts tests/mcp/expand.test.ts
git commit -m "feat(expand): rank candidates by file_mtime DESC and truncate to max_nodes"
```

---

## Task 7: Populate `types` and `fields` on each expanded node

**Files:**
- Modify: `src/mcp/expand.ts`
- Test: `tests/mcp/expand.test.ts`

- [ ] **Step 1: Add payload-shape tests**

Append to `tests/mcp/expand.test.ts`:

```typescript
describe('performExpansion — payload shape', () => {
  it('returns full {id, title, types, fields, body} per expanded node', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedType('a', 'note');
    seedType('a', 'meeting');
    // Seed a couple of fields on 'a'
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a', 'status', 'open', null, null, null, 'frontmatter');
    db.prepare(
      'INSERT INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a', 'date', null, null, '2026-04-20', null, 'frontmatter');
    seedRel('root', 'A', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    const entry = result.expanded['a'];
    expect(entry).toBeDefined();
    expect(entry.id).toBe('a');
    expect(entry.title).toBe('A');
    expect(entry.body).toBe('a body');
    // Types returned in insertion order (rowid)
    expect(entry.types).toEqual(['note', 'meeting']);
    expect(entry.fields.status).toEqual({ value: 'open', type: 'text', source: 'frontmatter' });
    expect(entry.fields.date).toEqual({ value: '2026-04-20', type: 'date', source: 'frontmatter' });
  });

  it('expanded entries have empty fields map when node has none', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedType('a', 'note');
    seedRel('root', 'A', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(result.expanded['a'].fields).toEqual({});
  });
});
```

Also add one regression test verifying the fixture from Task 3 now surfaces the candidates in `expanded`:

```typescript
  it('Task 3 fixtures now populate expanded map', () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('a', 'notes/a.md', 'A', 'a body', 1000);
    seedNode('b', 'notes/b.md', 'B', 'b body', 1500);
    seedType('a', 'note');
    seedType('b', 'note');
    seedRel('root', 'A', 'wiki-link');
    seedRel('root', 'B', 'wiki-link');

    const result = performExpansion(db, 'root', { types: ['note'], direction: 'outgoing', max_nodes: 10 });
    expect(Object.keys(result.expanded).sort()).toEqual(['a', 'b']);
    expect(result.stats.returned).toBe(2);
  });
```

- [ ] **Step 2: Run tests to verify payload tests fail**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: new payload tests FAIL — `types` is `[]` and `fields` is `{}`.

- [ ] **Step 3: Implement payload enrichment**

In `src/mcp/expand.ts`, add two helpers and call them inside the loop:

```typescript
function fetchTypesByNode(db: Database.Database, nodeIds: string[]): Record<string, string[]> {
  if (nodeIds.length === 0) return {};
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT node_id, schema_type FROM node_types WHERE node_id IN (${placeholders}) ORDER BY rowid`
  ).all(...nodeIds) as Array<{ node_id: string; schema_type: string }>;
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    if (!out[row.node_id]) out[row.node_id] = [];
    out[row.node_id].push(row.schema_type);
  }
  for (const id of nodeIds) if (!out[id]) out[id] = [];
  return out;
}

function fetchFieldsByNode(
  db: Database.Database,
  nodeIds: string[],
): Record<string, Record<string, { value: unknown; type: string; source: string }>> {
  if (nodeIds.length === 0) return {};
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT node_id, field_name, value_text, value_number, value_date, value_json, source
     FROM node_fields WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<FieldRow & { node_id: string }>;
  const out: Record<string, Record<string, { value: unknown; type: string; source: string }>> = {};
  for (const id of nodeIds) out[id] = {};
  for (const row of rows) {
    const value = resolveFieldValue(row);
    const type = row.value_json !== null ? 'json'
      : row.value_number !== null ? 'number'
      : row.value_date !== null ? 'date'
      : 'text';
    out[row.node_id][row.field_name] = { value, type, source: row.source };
  }
  return out;
}
```

Update the payload-building block in `performExpansion`:

```typescript
  const orderedIds = ordered.map(r => r.id);
  const typesByNode = fetchTypesByNode(db, orderedIds);
  const fieldsByNode = fetchFieldsByNode(db, orderedIds);
  const expanded: Record<string, ExpandedNode> = {};
  for (const row of ordered) {
    expanded[row.id] = {
      id: row.id,
      title: row.title,
      types: typesByNode[row.id] ?? [],
      fields: fieldsByNode[row.id] ?? {},
      body: row.body,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/expand.test.ts`
Expected: all tests (old and new) PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/expand.ts tests/mcp/expand.test.ts
git commit -m "feat(expand): populate types and fields on expanded nodes"
```

---

## Task 8: Wire `performExpansion` into `get-node` and attach response fields

**Files:**
- Modify: `src/mcp/tools/get-node.ts`
- Test: `tests/mcp/get-node-expand.test.ts`

- [ ] **Step 1: Add integration tests**

Append to `tests/mcp/get-node-expand.test.ts`:

```typescript
function seedRel(sourceId: string, target: string, relType: string) {
  db.prepare(
    'INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)'
  ).run(sourceId, target, relType, null);
}
function seedType(nodeId: string, schemaType: string) {
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run(nodeId, schemaType);
}

describe('get-node expand parameter — integration', () => {
  it('returns expanded map and stats when expand is provided', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('m1', 'notes/m1.md', 'M1', 'meeting 1', 2000);
    seedNode('m2', 'notes/m2.md', 'M2', 'meeting 2', 1000);
    seedType('m1', 'meeting');
    seedType('m2', 'meeting');
    seedRel('root', 'M1', 'wiki-link');
    seedRel('root', 'M2', 'wiki-link');

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['meeting'] } }) as any);
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data.expanded).sort()).toEqual(['m1', 'm2']);
    expect(env.data.expanded.m1.body).toBe('meeting 1');
    expect(env.data.expanded.m1.types).toEqual(['meeting']);
    expect(env.data.expand_stats).toEqual({ returned: 2, considered: 2, truncated: false });
  });

  it('truncation surfaces via expand_stats.truncated', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    for (let i = 0; i < 3; i++) {
      seedNode(`n${i}`, `notes/n${i}.md`, `N${i}`, `body ${i}`, 1000 + i);
      seedType(`n${i}`, 'note');
      seedRel('root', `N${i}`, 'wiki-link');
    }

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['note'], max_nodes: 2 } }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expand_stats).toEqual({ returned: 2, considered: 3, truncated: true });
  });

  it('direction=incoming surfaces backlinks', async () => {
    seedNode('proj', 'notes/Project.md', 'Project', 'project body');
    seedNode('note1', 'notes/note1.md', 'Note1', 'note about project', 1500);
    seedType('note1', 'note');
    seedRel('note1', 'Project', 'wiki-link');

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'proj', expand: { types: ['note'], direction: 'incoming' } }) as any);
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data.expanded)).toEqual(['note1']);
  });

  it('empty-match case returns zeroed stats and empty map', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    seedNode('p', 'notes/p.md', 'P', 'person body');
    seedType('p', 'person');
    seedRel('root', 'P', 'wiki-link');

    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['meeting'] } }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expanded).toEqual({});
    expect(env.data.expand_stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });

  it('root with zero relationships returns empty expansion, no error', async () => {
    seedNode('root', 'notes/root.md', 'Root', 'body');
    const handler = getHandler();
    const env = parseResult(await handler({ node_id: 'root', expand: { types: ['note'] } }) as any);
    expect(env.ok).toBe(true);
    expect(env.data.expanded).toEqual({});
    expect(env.data.expand_stats).toEqual({ returned: 0, considered: 0, truncated: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/get-node-expand.test.ts`
Expected: integration tests FAIL — handler does not yet attach `expanded`/`expand_stats`.

- [ ] **Step 3: Wire `performExpansion` into `get-node.ts`**

In `src/mcp/tools/get-node.ts`, add at the top with other imports:

```typescript
import { performExpansion } from '../expand.js';
```

After the `conformance:` line inside the `resultObj` assignment (around line 166) and before the embeds block, insert:

```typescript
      if (params.expand) {
        const { expanded, stats } = performExpansion(db, node.id, {
          types: params.expand.types,
          direction: params.expand.direction,
          max_nodes: params.expand.max_nodes,
        });
        resultObj.expanded = expanded;
        resultObj.expand_stats = stats;
      }
```

Place this block after `conformance: getNodeConformance(...)` in the object literal (the object is already built on line 152; add a follow-up mutation rather than expanding the literal). The existing code already pushes fields onto `resultObj` after construction — follow that pattern.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npx vitest run tests/mcp/get-node-expand.test.ts tests/mcp/expand.test.ts tests/mcp/get-node-embeds.test.ts`
Expected: all PASS. The existing `get-node-embeds.test.ts` suite must still be green — regression guard.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get-node.ts tests/mcp/get-node-expand.test.ts
git commit -m "feat(get-node): attach expanded map and expand_stats when expand param is present"
```

---

## Task 9: Update `get-node` tool description and run full suite

**Files:**
- Modify: `src/mcp/tools/get-node.ts:46`

- [ ] **Step 1: Update the tool description string**

In `src/mcp/tools/get-node.ts`, replace the description argument on line 46:

```typescript
    'Returns full details for a single node. Specify exactly one of: node_id, file_path, or title. Optional expand={types, direction?, max_nodes?} fetches one-hop neighbor nodes matching the given types, ranked by file_mtime DESC, capped at max_nodes (default 10, hard max 25). direction is "outgoing" (default), "incoming", or "both". When provided, the response includes expanded (map keyed by node_id with {id,title,types,fields,body}) and expand_stats ({returned,considered,truncated}).',
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: entire suite PASS. No existing test should have broken.

- [ ] **Step 3: Run the TypeScript build**

Run: `npm run build`
Expected: clean compile, zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/get-node.ts
git commit -m "docs(get-node): describe expand parameter in tool description"
```

---

## Summary

At completion:
- `src/mcp/expand.ts` is a pure helper module with `performExpansion(db, rootId, options)`.
- `get-node` accepts an optional `expand: { types, direction?, max_nodes? }` object and attaches `expanded` + `expand_stats` to its envelope data when present.
- `get-node` behavior is unchanged when `expand` is omitted.
- Full test coverage: validation, candidate building (outgoing/incoming/both), dedupe, self-reference exclusion, type filtering, mtime sort, null-mtime last, tie-break by id, truncation, empty-match, payload shape, backlink integration.
- Tool description documents the new parameter.
