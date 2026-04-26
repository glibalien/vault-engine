# `update-global-field` Discard Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `update-global-field` from silently discarding uncoercible values during a confirmed type change. Refuse with `CONFIRMATION_REQUIRED` unless the caller passes `discard_uncoercible: true`.

**Architecture:** Add a gate inside `updateGlobalField`'s apply branch that throws a typed sentinel error (`TypeChangeRequiresDiscardError`) when uncoercible values exist and the new opt-in flag is absent. The MCP wrapper catches the sentinel and translates it to the existing `CONFIRMATION_REQUIRED` envelope (mirroring the `update-schema` orphan-confirm precedent). No DB schema change, no undo wiring change, no envelope change beyond reusing an existing error code.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), better-sqlite3, vitest, zod, MCP TypeScript SDK.

**Source spec:** `docs/superpowers/specs/2026-04-26-update-global-field-uncoercible-design.md`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/global-fields/crud.ts` | modify | Define and export `TypeChangeRequiresDiscardError`. Add `discard_uncoercible?: boolean` to `UpdateGlobalFieldInput`. Insert the gate inside `updateGlobalField`'s apply branch, after the coercible/uncoercible scan and before `applyTx`. |
| `src/mcp/tools/update-global-field.ts` | modify | Add `discard_uncoercible` zod param. Add a typed `catch` branch for `TypeChangeRequiresDiscardError` that returns `fail('CONFIRMATION_REQUIRED', ..., { details })`. Update the tool's `description` string. |
| `tests/global-fields/crud.test.ts` | modify | Replace the single existing `'type change with confirm applies coercion to node_fields'` test with three focused tests (all-coercible apply, refusal, opt-in apply). |
| `tests/mcp/update-global-field-discard.test.ts` | create | MCP-wrapper tests asserting envelope shape on refusal and on opt-in apply. New file matching `tests/mcp/*.test.ts` convention. |
| `CLAUDE.md` | modify | One-line conventions entry documenting the gate. |

The implementation locus is intentionally tight: two production files and two test files. No DB migration, no other tool changes.

---

### Task 1: Gate the apply branch in `updateGlobalField` (TDD)

**Files:**
- Modify: `tests/global-fields/crud.test.ts:250-283` (replace single existing test)
- Modify: `src/global-fields/crud.ts:1-453` (extend input type, add error class, insert gate)

- [ ] **Step 1: Replace the existing type-change-apply test with three focused tests**

In `tests/global-fields/crud.test.ts`, find the test currently at lines 250-283 (`it('type change with confirm applies coercion to node_fields', ...)`) and replace it with the three tests below. Add the import for `TypeChangeRequiresDiscardError` to the existing import block at the top of the file.

Update the import block:

```ts
import {
  getGlobalField,
  createGlobalField,
  updateGlobalField,
  renameGlobalField,
  deleteGlobalField,
  TypeChangeRequiresDiscardError,
} from '../../src/global-fields/crud.js';
```

Replace the existing test block:

```ts
  it('type change with confirm and all-coercible values applies coercion', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });

    const result = updateGlobalField(db, 'count', {
      field_type: 'number',
      confirm: true,
    });

    expect(result.preview).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.coercible!.length).toBe(1);
    expect(result.uncoercible!.length).toBe(0);

    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('number');

    const n1 = db.prepare(
      `SELECT value_number, value_text FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_number: number | null; value_text: string | null };
    expect(n1.value_number).toBe(42);
    expect(n1.value_text).toBeNull();
  });

  it('type change with confirm and uncoercible values throws without discard_uncoercible flag — DB unchanged', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    expect(() =>
      updateGlobalField(db, 'count', { field_type: 'number', confirm: true }),
    ).toThrow(TypeChangeRequiresDiscardError);

    // global_fields row is untouched
    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('string');

    // node_fields rows are untouched
    const n1 = db.prepare(
      `SELECT value_text FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_text: string };
    expect(n1.value_text).toBe('42');
    const n2 = db.prepare(
      `SELECT value_text FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`,
    ).get() as { value_text: string };
    expect(n2.value_text).toBe('not-a-number');

    // No edits_log entries written
    const editsCount = (
      db.prepare(`SELECT COUNT(*) as c FROM edits_log WHERE event_type = 'value-removed'`).get() as { c: number }
    ).c;
    expect(editsCount).toBe(0);
  });

  it('TypeChangeRequiresDiscardError carries affected_nodes, coercible_count, and uncoercible array', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    let caught: TypeChangeRequiresDiscardError | undefined;
    try {
      updateGlobalField(db, 'count', { field_type: 'number', confirm: true });
    } catch (err) {
      if (err instanceof TypeChangeRequiresDiscardError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.details.affected_nodes).toBe(2);
    expect(caught!.details.coercible_count).toBe(1);
    expect(caught!.details.uncoercible).toHaveLength(1);
    expect(caught!.details.uncoercible[0].node_id).toBe('n2');
    expect(caught!.details.uncoercible[0].value).toBe('not-a-number');
  });

  it('type change with confirm and discard_uncoercible:true applies and removes uncoercible row', () => {
    createGlobalField(db, { name: 'count', field_type: 'string' });
    insertNode('n1', '/n1.md');
    insertNodeField('n1', 'count', { value_text: '42' });
    insertNode('n2', '/n2.md');
    insertNodeField('n2', 'count', { value_text: 'not-a-number' });

    const result = updateGlobalField(db, 'count', {
      field_type: 'number',
      confirm: true,
      discard_uncoercible: true,
    });

    expect(result.preview).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.coercible!.length).toBe(1);
    expect(result.uncoercible!.length).toBe(1);

    const field = getGlobalField(db, 'count');
    expect(field!.field_type).toBe('number');

    const n1 = db.prepare(
      `SELECT value_number FROM node_fields WHERE node_id = 'n1' AND field_name = 'count'`,
    ).get() as { value_number: number };
    expect(n1.value_number).toBe(42);

    const n2 = db.prepare(
      `SELECT * FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`,
    ).get();
    expect(n2).toBeUndefined();

    const log = db
      .prepare(`SELECT event_type, details FROM edits_log WHERE event_type = 'value-removed'`)
      .get() as { event_type: string; details: string };
    expect(log).toBeDefined();
    expect(JSON.parse(log.details).removed_value).toBe('not-a-number');
  });
```

- [ ] **Step 2: Run the test file to verify the new tests fail**

Run: `npx vitest run tests/global-fields/crud.test.ts`

Expected: TypeScript / runtime errors. The import of `TypeChangeRequiresDiscardError` will fail (not yet exported), and the `discard_uncoercible` field on the input will be a type error in test 4.

- [ ] **Step 3: Add `TypeChangeRequiresDiscardError` and the gate to `crud.ts`**

In `src/global-fields/crud.ts`, make three additions:

**3a.** Add the discard flag to `UpdateGlobalFieldInput` (around line 21-31):

```ts
export interface UpdateGlobalFieldInput {
  field_type?: FieldType;
  enum_values?: string[];
  reference_target?: string;
  description?: string;
  default_value?: unknown;
  required?: boolean;
  list_item_type?: FieldType;
  overrides_allowed?: { required?: boolean; default_value?: boolean; enum_values?: boolean };
  confirm?: boolean;
  discard_uncoercible?: boolean;
}
```

**3b.** Add the sentinel error class. Place it in the `// ── Shared types ──` section near the top of the file (after `TypeChangeResult`, around line 41):

```ts
export class TypeChangeRequiresDiscardError extends Error {
  readonly details: {
    affected_nodes: number;
    coercible_count: number;
    uncoercible: Array<{ node_id: string; value: unknown; reason: string }>;
  };

  constructor(details: TypeChangeRequiresDiscardError['details']) {
    super(
      `Type change would discard ${details.uncoercible.length} uncoercible value(s); ` +
        `set discard_uncoercible: true to proceed`,
    );
    this.name = 'TypeChangeRequiresDiscardError';
    this.details = details;
  }
}
```

**3c.** Insert the gate inside `updateGlobalField`'s apply path. Find the block at lines 299-308 that returns the preview when `!input.confirm`. Immediately after that `if (!input.confirm) { return { preview: true, ... }; }` block, and before the `// Apply mode` comment / `applyTx` definition, insert:

```ts
  // Gate: refuse to discard uncoercible values without explicit opt-in.
  // The operator must acknowledge data loss via discard_uncoercible: true.
  if (uncoercible.length > 0 && !input.discard_uncoercible) {
    throw new TypeChangeRequiresDiscardError({
      affected_nodes: rows.length,
      coercible_count: coercible.length,
      uncoercible,
    });
  }
```

The placement matters: it runs only when `confirm: true` (the preview branch returns above) and only on the type-change path (the non-type-change branch returns at line 263).

- [ ] **Step 4: Run the test file to verify the new tests pass**

Run: `npx vitest run tests/global-fields/crud.test.ts`

Expected: all tests in the file pass (the four new tests plus the unchanged ones above and below).

- [ ] **Step 5: Commit**

```bash
git add src/global-fields/crud.ts tests/global-fields/crud.test.ts
git commit -m "$(cat <<'EOF'
fix(global-fields): refuse type-change apply when uncoercible values exist

Type-change confirm now throws TypeChangeRequiresDiscardError when any
existing values can't coerce to the new type. Caller must opt into data
loss via discard_uncoercible: true to get the previous (silent-delete)
behavior. Resolves Bundle B postmortem latent bug #3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `discard_uncoercible` into the MCP tool wrapper (TDD)

**Files:**
- Create: `tests/mcp/update-global-field-discard.test.ts`
- Modify: `src/mcp/tools/update-global-field.ts:1-62`

- [ ] **Step 1: Write the MCP wrapper tests**

Create `tests/mcp/update-global-field-discard.test.ts` with the following content. The setup deliberately omits `vaultPath` from the registration `ctx` so the wrapper short-circuits the file-rendering branch (`if (ctx?.vaultPath) { ... }` at line 37) — this isolates the test to the gate logic without needing a real vault on disk.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerUpdateGlobalField } from '../../src/mcp/tools/update-global-field.js';

let db: Database.Database;

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

function getHandler() {
  let captured: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (
      _name: string,
      _desc: string,
      _schema: unknown,
      h: (...a: unknown[]) => unknown,
    ) => {
      captured = (args) => h(args) as Promise<unknown>;
    },
  } as unknown as McpServer;
  // No ctx — skips file-render branch in the handler so the test stays in-memory.
  registerUpdateGlobalField(fakeServer, db);
  return captured!;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  createGlobalField(db, { name: 'count', field_type: 'string' });

  db.prepare(`INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`).run('n1', '/n1.md', 'n1');
  db.prepare(`INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)`)
    .run('n1', 'count', '42');
  db.prepare(`INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)`).run('n2', '/n2.md', 'n2');
  db.prepare(`INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)`)
    .run('n2', 'count', 'not-a-number');
});

afterEach(() => {
  db.close();
});

describe('update-global-field discard gate', () => {
  it('returns CONFIRMATION_REQUIRED with uncoercible details when no flag is set', async () => {
    const handler = getHandler();
    const result = await handler({ name: 'count', field_type: 'number', confirm: true });
    const env = parseResult(result);

    expect(env.ok).toBe(false);
    const error = env.error as { code: string; message: string; details: Record<string, unknown> };
    expect(error.code).toBe('CONFIRMATION_REQUIRED');
    expect(error.details.affected_nodes).toBe(2);
    expect(error.details.coercible_count).toBe(1);

    const uncoercible = error.details.uncoercible as Array<{ node_id: string; value: unknown; reason: string }>;
    expect(uncoercible).toHaveLength(1);
    expect(uncoercible[0].node_id).toBe('n2');
    expect(uncoercible[0].value).toBe('not-a-number');
    expect(typeof uncoercible[0].reason).toBe('string');

    // DB still unchanged at the wrapper boundary
    const field = db.prepare(`SELECT field_type FROM global_fields WHERE name = 'count'`).get() as { field_type: string };
    expect(field.field_type).toBe('string');
  });

  it('applies the type change when discard_uncoercible:true is passed', async () => {
    const handler = getHandler();
    const result = await handler({
      name: 'count',
      field_type: 'number',
      confirm: true,
      discard_uncoercible: true,
    });
    const env = parseResult(result);

    expect(env.ok).toBe(true);
    const data = env.data as { applied: boolean; uncoercible: unknown[] };
    expect(data.applied).toBe(true);
    expect(data.uncoercible).toHaveLength(1);

    const field = db.prepare(`SELECT field_type FROM global_fields WHERE name = 'count'`).get() as { field_type: string };
    expect(field.field_type).toBe('number');

    const n2 = db.prepare(`SELECT * FROM node_fields WHERE node_id = 'n2' AND field_name = 'count'`).get();
    expect(n2).toBeUndefined();
  });

  it('applies normally when there are no uncoercible values, no flag needed', async () => {
    // Replace n2's uncoercible value with a coercible one.
    db.prepare(`UPDATE node_fields SET value_text = '7' WHERE node_id = 'n2' AND field_name = 'count'`).run();

    const handler = getHandler();
    const result = await handler({ name: 'count', field_type: 'number', confirm: true });
    const env = parseResult(result);

    expect(env.ok).toBe(true);
    expect((env.data as { applied: boolean }).applied).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `npx vitest run tests/mcp/update-global-field-discard.test.ts`

Expected: the first test fails because the wrapper currently returns `INVALID_PARAMS` (the generic catch translates `TypeChangeRequiresDiscardError`'s `Error` superclass into that envelope). The second test fails because the zod schema rejects `discard_uncoercible` as unknown. The third test passes (no behavior change for clean type changes).

- [ ] **Step 3: Wire `discard_uncoercible` into the MCP tool wrapper**

Replace the contents of `src/mcp/tools/update-global-field.ts` with:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, fail } from './errors.js';
import { updateGlobalField, TypeChangeRequiresDiscardError } from '../../global-fields/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../schema/render.js';
import { rerenderNodesWithField } from '../../schema/propagate.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';

const fieldTypeEnum = z.enum(['string', 'number', 'date', 'boolean', 'reference', 'enum', 'list']);

export function registerUpdateGlobalField(server: McpServer, db: Database.Database, ctx?: { writeLock?: WriteLockManager; vaultPath?: string; syncLogger?: SyncLogger }): void {
  server.tool(
    'update-global-field',
    'Updates an existing global field definition. For type changes, omit confirm to preview impact; set confirm=true to apply. If existing values cannot coerce to the new type, the apply is refused with CONFIRMATION_REQUIRED unless discard_uncoercible: true is also set.',
    {
      name: z.string().describe('Field name to update'),
      field_type: fieldTypeEnum.optional().describe('New field type (triggers type-change flow if different)'),
      enum_values: z.array(z.string()).optional().describe('New allowed values for enum fields'),
      reference_target: z.string().optional().describe('New target schema type for reference fields'),
      description: z.string().optional().describe('New description'),
      default_value: z.unknown().optional().describe('New default value'),
      required: z.boolean().optional().describe('New required flag'),
      list_item_type: fieldTypeEnum.optional().describe('New item type for list fields'),
      overrides_allowed: z.object({
        required: z.boolean().optional(),
        default_value: z.boolean().optional(),
        enum_values: z.boolean().optional(),
      }).optional().describe('Per-property override permissions for schema claims'),
      confirm: z.boolean().optional().describe('Set true to apply a type change (otherwise previews impact)'),
      discard_uncoercible: z.boolean().optional().describe('When applying a type change with uncoercible values, set true to delete those values. Default: refuse the change with CONFIRMATION_REQUIRED.'),
    },
    async ({ name, ...rest }) => {
      try {
        const result = updateGlobalField(db, name, rest);

        if (ctx?.vaultPath) {
          renderFieldsFile(db, ctx.vaultPath);
          // Re-render schema files that have claims on this field
          const claimingSchemas = db.prepare('SELECT DISTINCT schema_name FROM schema_field_claims WHERE field = ?')
            .all(name) as Array<{ schema_name: string }>;
          for (const { schema_name } of claimingSchemas) {
            renderSchemaFile(db, ctx.vaultPath, schema_name);
          }
          // If type change was confirmed, re-render affected nodes
          if (rest.confirm && rest.field_type && ctx.writeLock) {
            // Pass uncoercible node IDs so they get re-rendered even though
            // their node_fields rows for this field were deleted
            const uncoercibleIds = result.uncoercible?.map(u => u.node_id);
            const nodes_rerendered = rerenderNodesWithField(db, ctx.writeLock, ctx.vaultPath, name, uncoercibleIds, ctx.syncLogger);
            return ok({ ...result, nodes_rerendered });
          }
        }

        return ok(result);
      } catch (err) {
        if (err instanceof TypeChangeRequiresDiscardError) {
          return fail(
            'CONFIRMATION_REQUIRED',
            `${err.details.uncoercible.length} value(s) cannot coerce to the new type. Set discard_uncoercible: true to delete them, or omit confirm to preview.`,
            { details: {
                affected_nodes: err.details.affected_nodes,
                coercible_count: err.details.coercible_count,
                uncoercible: err.details.uncoercible,
              } },
          );
        }
        return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
```

The two changes from the prior file are:

1. The added `discard_uncoercible` zod field in the schema.
2. The added `if (err instanceof TypeChangeRequiresDiscardError) { return fail(...) }` branch inside the catch, placed **before** the generic `INVALID_PARAMS` fall-through.
3. The expanded tool description string that documents the gate.

The import line for `updateGlobalField` is widened to also pull `TypeChangeRequiresDiscardError` from the same module.

- [ ] **Step 4: Run the new test file to verify it passes**

Run: `npx vitest run tests/mcp/update-global-field-discard.test.ts`

Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/update-global-field.ts tests/mcp/update-global-field-discard.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): expose discard_uncoercible param and CONFIRMATION_REQUIRED on update-global-field

The MCP wrapper now translates TypeChangeRequiresDiscardError to a
CONFIRMATION_REQUIRED envelope carrying affected_nodes, coercible_count,
and the full uncoercible array — same shape as the preview's uncoercible
list, so the operator's decision input is identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Document the gate in CLAUDE.md and run the full suite

**Files:**
- Modify: `CLAUDE.md` (add one line under the Conventions section)

- [ ] **Step 1: Add the conventions entry to CLAUDE.md**

Open `/home/barry/projects/vault-engine/CLAUDE.md`. Find the bullet that begins `**Defaults are creation-only.**` (under the Conventions section). Add the following bullet anywhere in the same Conventions list — placing it immediately after the `**Per-type field overrides.**` bullet keeps related global-field-touching items together:

```markdown
- **`update-global-field` discard gate.** Type-change `confirm: true` refuses with `CONFIRMATION_REQUIRED` if any existing values won't coerce to the new type. Set `discard_uncoercible: true` to opt into data loss; the discarded values are still recorded in `edits_log` (forensic, not currently MCP-queryable). See `src/global-fields/crud.ts:updateGlobalField` and the spec at `docs/superpowers/specs/2026-04-26-update-global-field-uncoercible-design.md`.
```

- [ ] **Step 2: Run the full test suite to confirm no regressions**

Run: `npm test`

Expected: all tests pass (the existing test count + 4 new tests in `tests/global-fields/crud.test.ts` + 3 new tests in `tests/mcp/update-global-field-discard.test.ts`).

If any unrelated test fails, do **not** patch it without investigation — the gate is supposed to be additive in shape and only break the one test that was rewritten in Task 1.

- [ ] **Step 3: Run the typecheck/build to confirm types resolve**

Run: `npm run build`

Expected: clean exit. The `IssueCode` exhaustiveness pin (added recently in `chore/closed-union-issue-code`) should pass — this work does not add or rename any `IssueCode` values, only reuses the existing `CONFIRMATION_REQUIRED` `ErrorCode`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude): document update-global-field discard gate convention

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist

Before opening a PR, verify the following:

- [ ] Spec coverage: every "Behavior", "Wire shape", "Implementation locus", "Tests", "Documentation", and "Backward compatibility" requirement in `docs/superpowers/specs/2026-04-26-update-global-field-uncoercible-design.md` maps to at least one task above. (Tasks 1-3 cover all six sections.)
- [ ] No placeholder behavior. The discard branch isn't behind a feature flag, isn't gated on env var, doesn't no-op in test environments. The bug fix is unconditional.
- [ ] No new `IssueCode` or `ErrorCode` values were added. (`CONFIRMATION_REQUIRED` is reused from the existing `ErrorCode` union in `src/mcp/tools/errors.ts:16`.)
- [ ] The wrapper's `instanceof TypeChangeRequiresDiscardError` branch sits **before** the generic catch — otherwise the sentinel collapses into `INVALID_PARAMS`.
- [ ] The crud-level gate sits **after** the `if (!input.confirm) return preview` branch — otherwise preview calls would also throw, breaking the dry-run UX.
- [ ] No `value_raw_text`, `reconstructValue`, conformance, validation, or renderer code was touched. The blast radius matches the spec's "Implementation locus" claim.
- [ ] The `update-schema` confirmation precedent (`src/mcp/tools/update-schema.ts:97-108`) was not modified — only mirrored in shape.
