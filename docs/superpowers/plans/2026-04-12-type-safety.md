# Type Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject tool-initiated writes that reference types without schemas, and add dry_run to create-node and update-node single-node mode.

**Architecture:** A shared `checkTypesHaveSchemas()` function queries the `schemas` table and returns unknown types. Each write tool calls it before mutation. Dry-run on create-node runs the pipeline through Stage 2 and returns a preview without writing. The watcher path is unchanged.

**Tech Stack:** TypeScript, better-sqlite3, vitest, zod

**Spec:** `docs/superpowers/specs/2026-04-12-type-safety-design.md`

---

### Task 1: `checkTypesHaveSchemas` utility + tests

**Files:**
- Create: `src/pipeline/check-types.ts`
- Create: `tests/pipeline/check-types.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/pipeline/check-types.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { checkTypesHaveSchemas } from '../../src/pipeline/check-types.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
});

describe('checkTypesHaveSchemas', () => {
  it('returns valid for empty types array', () => {
    const result = checkTypesHaveSchemas(db, []);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when all types have schemas', () => {
    const result = checkTypesHaveSchemas(db, ['note', 'task']);
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid with unknown types listed', () => {
    const result = checkTypesHaveSchemas(db, ['reference']);
    expect(result).toEqual({
      valid: false,
      unknown: ['reference'],
      available: ['note', 'task'],
    });
  });

  it('returns only unknown types in mixed array', () => {
    const result = checkTypesHaveSchemas(db, ['note', 'reference', 'spec']);
    expect(result).toEqual({
      valid: false,
      unknown: ['reference', 'spec'],
      available: ['note', 'task'],
    });
  });

  it('returns sorted available schemas', () => {
    createSchemaDefinition(db, { name: 'apple', field_claims: [] });
    const result = checkTypesHaveSchemas(db, ['zzz']);
    expect((result as any).available).toEqual(['apple', 'note', 'task']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pipeline/check-types.test.ts`
Expected: FAIL — module `src/pipeline/check-types.js` does not exist

- [ ] **Step 3: Implement `checkTypesHaveSchemas`**

```typescript
// src/pipeline/check-types.ts
import type Database from 'better-sqlite3';

type CheckResult =
  | { valid: true }
  | { valid: false; unknown: string[]; available: string[] };

export function checkTypesHaveSchemas(
  db: Database.Database,
  types: string[],
): CheckResult {
  if (types.length === 0) return { valid: true };
  const schemaNames = new Set(
    (db.prepare('SELECT name FROM schemas').all() as Array<{ name: string }>).map(r => r.name),
  );
  const unknown = types.filter(t => !schemaNames.has(t));
  if (unknown.length === 0) return { valid: true };
  return {
    valid: false,
    unknown,
    available: [...schemaNames].sort(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pipeline/check-types.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/check-types.ts tests/pipeline/check-types.test.ts
git commit -m "feat: add checkTypesHaveSchemas utility for type-schema validation"
```

---

### Task 2: Integrate type check into `create-node` + `dry_run`

**Files:**
- Modify: `src/mcp/tools/create-node.ts`
- Modify: `src/mcp/tools/errors.ts` (add `UNKNOWN_TYPE` to ErrorCode)
- Create: `tests/mcp/type-safety.test.ts`

- [ ] **Step 1: Write failing tests for create-node type enforcement**

```typescript
// tests/mcp/type-safety.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerAddTypeToNode } from '../../src/mcp/tools/add-type-to-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { executeMutation } from '../../src/pipeline/execute.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getToolHandler(
  registerFn: (server: McpServer, db: Database.Database, writeLock: WriteLockManager, vaultPath: string) => void,
) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db, writeLock, vaultPath);
  return capturedHandler!;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  writeLock = new WriteLockManager();

  // Set up schemas
  createGlobalField(db, { name: 'project', field_type: 'text' });
  createSchemaDefinition(db, {
    name: 'note',
    field_claims: [{ field: 'project' }],
    default_directory: 'Notes',
  });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
});

afterEach(() => {
  db.close();
  cleanup();
});

// ── create-node type enforcement ─────────────────────────────────────

describe('create-node type enforcement', () => {
  it('succeeds with valid types', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Test', types: ['note'], fields: {}, body: '' }) as any);
    expect(result.node_id).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('succeeds with empty types', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Typeless', types: [], fields: {}, body: '' }) as any);
    expect(result.node_id).toBeDefined();
  });

  it('rejects unknown type with UNKNOWN_TYPE error', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Bad', types: ['reference'], fields: {}, body: '' }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
    expect(result.available_schemas).toContain('note');
    expect(result.available_schemas).toContain('task');
    // Verify no file was created
    expect(existsSync(join(vaultPath, 'Bad.md'))).toBe(false);
  });

  it('rejects mixed valid/unknown types, lists only unknown', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({ title: 'Mixed', types: ['note', 'reference'], fields: {}, body: '' }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
  });
});

// ── create-node dry_run ──────────────────────────────────────────────

describe('create-node dry_run', () => {
  it('returns preview without writing when dry_run is true', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({
      title: 'Preview Note',
      types: ['note'],
      fields: { project: 'Test' },
      body: '',
      dry_run: true,
    }) as any);
    expect(result.dry_run).toBe(true);
    expect(result.would_create.file_path).toBe('Notes/Preview Note.md');
    expect(result.would_create.types).toEqual(['note']);
    // Verify nothing was written
    expect(existsSync(join(vaultPath, 'Notes/Preview Note.md'))).toBe(false);
    const dbNode = db.prepare('SELECT id FROM nodes WHERE title = ?').get('Preview Note');
    expect(dbNode).toBeUndefined();
  });

  it('rejects invalid type on dry_run', async () => {
    const handler = getToolHandler(registerCreateNode);
    const result = parseResult(await handler({
      title: 'Bad Dry',
      types: ['reference'],
      fields: {},
      body: '',
      dry_run: true,
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
  });

  it('reports path conflict on dry_run', async () => {
    // Create an existing node first
    const handler = getToolHandler(registerCreateNode);
    await handler({ title: 'Existing', types: ['note'], fields: {}, body: '' });
    // Now dry_run with same path
    const result = parseResult(await handler({
      title: 'Existing',
      types: ['note'],
      fields: {},
      body: '',
      dry_run: true,
    }) as any);
    expect(result.dry_run).toBe(true);
    expect(result.would_create.conflict).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/type-safety.test.ts`
Expected: FAIL — type check not implemented, dry_run not recognized

- [ ] **Step 3: Add `UNKNOWN_TYPE` to ErrorCode in errors.ts**

In `src/mcp/tools/errors.ts`, add `'UNKNOWN_TYPE'` to the ErrorCode union:

```typescript
export type ErrorCode = 'NOT_FOUND' | 'INVALID_PARAMS' | 'AMBIGUOUS_MATCH' | 'INTERNAL_ERROR' | 'VALIDATION_FAILED' | 'UNKNOWN_TYPE';
```

- [ ] **Step 4: Implement type check and dry_run in create-node**

In `src/mcp/tools/create-node.ts`:

Add import at top:
```typescript
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
```

Add `dry_run` to paramsShape:
```typescript
const paramsShape = {
  title: z.string(),
  types: z.array(z.string()).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
  body: z.string().default(''),
  path: z.string().optional(),
  dry_run: z.boolean().default(false),
};
```

At the top of the handler (after destructuring params, before path derivation), add:
```typescript
      const { title, types, fields, body, path: dirPath, dry_run: dryRun } = params;

      // ── Type-schema check (Stage 1 gate) ──────────────────────────
      const typeCheck = checkTypesHaveSchemas(db, types);
      if (!typeCheck.valid) {
        return toolResult({
          error: 'UNKNOWN_TYPE',
          unknown_types: typeCheck.unknown,
          message: `Cannot write node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
          available_schemas: typeCheck.available,
          suggestion: 'For general-purpose notes and reference material, use type \'note\'.',
        });
      }
```

After the conflict check block, before the `try` block with `executeMutation`, add the dry_run branch:
```typescript
      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        const { claimsByType, globalFields } = loadSchemaContext(db, types);
        const validation = validateProposedState(fields, types, claimsByType, globalFields);
        return toolResult({
          dry_run: true,
          would_create: {
            file_path: filePath,
            title,
            types,
            coerced_state: validation.coerced_state,
            issues: validation.issues,
            orphan_fields: validation.orphan_fields,
            ...(existing ? { conflict: `File path "${filePath}" already exists (node: ${existing.title})` } : {}),
            ...(existsSync(join(vaultPath, filePath)) && !existing ? { conflict: `File "${filePath}" already exists on disk` } : {}),
          },
        });
      }
```

Note: The conflict check must move from an early-return to a variable check. Restructure the conflict section:
```typescript
      // Conflict check
      const existing = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as { id: string; title: string } | undefined;
      const diskConflict = existsSync(join(vaultPath, filePath));

      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        const { claimsByType, globalFields } = loadSchemaContext(db, types);
        const validation = validateProposedState(fields, types, claimsByType, globalFields);
        const conflict = existing
          ? `File path "${filePath}" already exists (node: ${existing.title})`
          : diskConflict ? `File "${filePath}" already exists on disk` : undefined;
        return toolResult({
          dry_run: true,
          would_create: {
            file_path: filePath,
            title,
            types,
            coerced_state: validation.coerced_state,
            issues: validation.issues,
            orphan_fields: validation.orphan_fields,
            ...(conflict ? { conflict } : {}),
          },
        });
      }

      // Non-dry-run: reject conflicts
      if (existing) {
        return toolErrorResult('INVALID_PARAMS', `File path "${filePath}" already exists (node: ${existing.title})`);
      }
      if (diskConflict) {
        return toolErrorResult('INVALID_PARAMS', `File "${filePath}" already exists on disk`);
      }
```

Update the tool description:
```typescript
    'Create a new node and write it to disk. Every type in types must have a defined schema — call list-schemas to see available types. For general-purpose notes and reference material, use type note. If no path is provided, the file location is derived from the type\'s filename template (e.g., notes go to Notes/, meetings go to Meetings/). Use dry_run: true to validate types and fields before generating long body content — this catches errors without wasting work.',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/type-safety.test.ts`
Expected: All create-node tests PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/errors.ts src/mcp/tools/create-node.ts tests/mcp/type-safety.test.ts
git commit -m "feat: type-schema enforcement and dry_run on create-node"
```

---

### Task 3: Integrate type check into `update-node` (single-node + query mode) and `add-type-to-node`

**Files:**
- Modify: `src/mcp/tools/update-node.ts`
- Modify: `src/mcp/tools/add-type-to-node.ts`
- Modify: `tests/mcp/type-safety.test.ts` (add tests)

- [ ] **Step 1: Add failing tests to type-safety.test.ts**

Append to `tests/mcp/type-safety.test.ts`:

```typescript
// ── update-node type enforcement ─────────────────────────────────────

describe('update-node type enforcement', () => {
  function createSeedNode() {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'seed.md',
      title: 'Seed',
      types: ['note'],
      fields: {},
      body: '',
    });
  }

  it('rejects set_types with unknown type', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_types: ['reference'],
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
  });

  it('allows set_types with valid types', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_types: ['task'],
    }) as any);
    expect(result.error).toBeUndefined();
    expect(result.types).toEqual(['task']);
  });

  it('does not check types when set_types is absent', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_fields: { project: 'X' },
    }) as any);
    expect(result.error).toBeUndefined();
  });

  it('dry_run in single-node mode returns preview without writing', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      set_fields: { project: 'Preview' },
      dry_run: true,
    }) as any);
    expect(result.dry_run).toBe(true);
    expect(result.preview).toBeDefined();
    // Verify DB was not mutated
    const fields = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(seed.node_id, 'project') as { value_text: string } | undefined;
    expect(fields).toBeUndefined(); // project field was not written
  });

  it('rejects unknown type in query mode add_types', async () => {
    createSeedNode();
    const handler = getToolHandler(registerUpdateNode);
    const result = parseResult(await handler({
      query: { types: ['note'] },
      add_types: ['reference'],
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
  });
});

// ── add-type-to-node type enforcement ────────────────────────────────

describe('add-type-to-node type enforcement', () => {
  function createSeedNode() {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'seed2.md',
      title: 'Seed2',
      types: ['note'],
      fields: {},
      body: '',
    });
  }

  it('rejects unknown type', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerAddTypeToNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      type: 'reference',
    }) as any);
    expect(result.error).toBe('UNKNOWN_TYPE');
    expect(result.unknown_types).toEqual(['reference']);
  });

  it('allows valid type', async () => {
    const seed = createSeedNode();
    const handler = getToolHandler(registerAddTypeToNode);
    const result = parseResult(await handler({
      node_id: seed.node_id,
      type: 'task',
    }) as any);
    expect(result.error).toBeUndefined();
    expect(result.types).toContain('task');
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `npx vitest run tests/mcp/type-safety.test.ts`
Expected: New update-node and add-type-to-node tests FAIL

- [ ] **Step 3: Integrate type check into update-node**

In `src/mcp/tools/update-node.ts`:

Add import:
```typescript
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
```

In the **single-node mode** section, after resolving node identity and loading current state (after line 131: `const finalTypes = set_types ?? currentTypes;`), add the type check:
```typescript
      // Type-schema check (only when set_types is provided)
      if (set_types !== undefined) {
        const typeCheck = checkTypesHaveSchemas(db, finalTypes);
        if (!typeCheck.valid) {
          return toolResult({
            error: 'UNKNOWN_TYPE',
            unknown_types: typeCheck.unknown,
            message: `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
            available_schemas: typeCheck.available,
            suggestion: 'For general-purpose notes and reference material, use type \'note\'.',
          });
        }
      }
```

Add dry_run support to single-node mode. After the type check and field/body computation (after line 144: the `finalBody` assignment), before the `try` block:
```typescript
      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        const { claimsByType, globalFields } = loadSchemaContext(db, finalTypes);
        const validation = validateProposedState(finalFields, finalTypes, claimsByType, globalFields);
        return toolResult({
          dry_run: true,
          preview: {
            node_id: node.node_id,
            file_path: node.file_path,
            title: finalTitle,
            types: finalTypes,
            coerced_state: validation.coerced_state,
            issues: validation.issues,
            orphan_fields: validation.orphan_fields,
          },
        });
      }
```

In the **query mode** section, add type check for `add_types`. In the `handleQueryMode` function, before calling `handleDryRun` or `handleExecution` (after the batch size guard, around line 203), add:
```typescript
  // Type-schema check on add_types
  if (ops.add_types && ops.add_types.length > 0) {
    const typeCheck = checkTypesHaveSchemas(db, ops.add_types);
    if (!typeCheck.valid) {
      return toolResult({
        error: 'UNKNOWN_TYPE',
        unknown_types: typeCheck.unknown,
        message: `Cannot add types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
        available_schemas: typeCheck.available,
        suggestion: 'For general-purpose notes and reference material, use type \'note\'.',
      });
    }
  }
```

Update the tool description (line 67):
```typescript
    'Update an existing node (single or query-mode bulk). Patch semantics for fields (null removes a field). set_body and append_body are mutually exclusive. If set_types is provided, every type must have a defined schema. Use list-schemas to see available types. For query mode, provide query instead of node identity. Query mode supports set_path to move files to a target directory (title unchanged, no reference rewriting).',
```

- [ ] **Step 4: Integrate type check into add-type-to-node**

In `src/mcp/tools/add-type-to-node.ts`:

Add imports:
```typescript
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { toolResult } from './errors.js';
```

Note: `toolResult` is already imported via the existing `toolResult, toolErrorResult` import. Just add the `checkTypesHaveSchemas` import.

At the top of the handler, after the `resolved` check and before loading current state (after line 42), add:
```typescript
      // Type-schema check
      const typeCheck = checkTypesHaveSchemas(db, [params.type]);
      if (!typeCheck.valid) {
        return toolResult({
          error: 'UNKNOWN_TYPE',
          unknown_types: typeCheck.unknown,
          message: `Cannot add type '${params.type}' — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
          available_schemas: typeCheck.available,
          suggestion: 'For general-purpose notes and reference material, use type \'note\'.',
        });
      }
```

Update the tool description (line 31):
```typescript
    'Add a type to a node, automatically populating claimed fields with defaults. The type must have a defined schema. Use list-schemas to see available types.',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/type-safety.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/update-node.ts src/mcp/tools/add-type-to-node.ts tests/mcp/type-safety.test.ts
git commit -m "feat: type-schema enforcement on update-node and add-type-to-node"
```

---

### Task 4: Integrate type check into `batch-mutate`

**Files:**
- Modify: `src/mcp/tools/batch-mutate.ts`
- Modify: `tests/mcp/type-safety.test.ts` (add test)

- [ ] **Step 1: Add failing test**

Append to `tests/mcp/type-safety.test.ts`:

```typescript
// ── batch-mutate type enforcement ────────────────────────────────────

describe('batch-mutate type enforcement', () => {
  it('rolls back entire batch when one op has unknown type', async () => {
    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'Good', types: ['note'], fields: {}, body: '' } },
        { op: 'create', params: { title: 'Bad', types: ['reference'], fields: {}, body: '' } },
      ],
    }) as any);
    expect(result.applied).toBe(false);
    expect(result.error.message).toContain('reference');
    // First op should have been rolled back
    const node = db.prepare('SELECT id FROM nodes WHERE title = ?').get('Good');
    expect(node).toBeUndefined();
    expect(existsSync(join(vaultPath, 'Good.md'))).toBe(false);
  });

  it('succeeds when all ops have valid types', async () => {
    const handler = getToolHandler(registerBatchMutate);
    const result = parseResult(await handler({
      operations: [
        { op: 'create', params: { title: 'One', types: ['note'], fields: {}, body: '' } },
        { op: 'create', params: { title: 'Two', types: ['task'], fields: {}, body: '' } },
      ],
    }) as any);
    expect(result.applied).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/type-safety.test.ts -t "batch-mutate"`
Expected: FAIL — unknown type is not rejected

- [ ] **Step 3: Integrate type check into batch-mutate**

In `src/mcp/tools/batch-mutate.ts`:

Add import:
```typescript
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
```

In the `create` branch (after extracting `types` around line 53), add:
```typescript
              // Type-schema check
              const typeCheck = checkTypesHaveSchemas(db, types);
              if (!typeCheck.valid) {
                throw new PipelineError('UNKNOWN_TYPE',
                  `Cannot create node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
              }
```

In the `update` branch (after extracting `set_types` around line 114), add the check only when `set_types` is provided:
```typescript
              const setTypes = opParams.set_types as string[] | undefined;
              if (setTypes) {
                const typeCheck = checkTypesHaveSchemas(db, setTypes);
                if (!typeCheck.valid) {
                  throw new PipelineError('UNKNOWN_TYPE',
                    `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
                }
              }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/type-safety.test.ts -t "batch-mutate"`
Expected: PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/batch-mutate.ts tests/mcp/type-safety.test.ts
git commit -m "feat: type-schema enforcement on batch-mutate"
```

---

### Task 5: Verify watcher path is unchanged + final full-suite check

**Files:**
- Modify: `tests/mcp/type-safety.test.ts` (add watcher-path test)

- [ ] **Step 1: Add test confirming watcher path accepts unschematized types**

Append to `tests/mcp/type-safety.test.ts`:

```typescript
// ── watcher path stays permissive ────────────────────────────────────

describe('watcher path stays permissive', () => {
  it('accepts unschematized types on watcher source', () => {
    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: null,
      file_path: 'watcher-node.md',
      title: 'Watcher Node',
      types: ['nonexistent_type'],
      fields: {},
      body: '',
    });
    expect(result.node_id).toBeDefined();
    expect(existsSync(join(vaultPath, 'watcher-node.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/mcp/type-safety.test.ts -t "watcher"`
Expected: PASS (this confirms the watcher is unaffected)

- [ ] **Step 3: Run complete test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/type-safety.test.ts
git commit -m "test: verify watcher path accepts unschematized types"
```

- [ ] **Step 5: Build check**

Run: `npm run build`
Expected: No TypeScript errors
