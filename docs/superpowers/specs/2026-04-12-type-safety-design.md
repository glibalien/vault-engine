# Agent Guidance and Type Safety

## Problem

In fresh sessions, agents have no context about the vault's type system. When asked to save information, agents invent types (`reference`, `spec`, `resource`) and fabricate folder hierarchies (`/References/Space Travel/`) with no basis in the vault's structure. The result is nodes with unschematized types, misplaced files, and unpopulated schema fields.

The Charter's Principle 9 ("Runs on cheap models") and the coercion engine are designed as the agent's safety net, but neither currently prevents type invention. The write path accepts whatever types the agent provides. There is no guardrail and no guidance.

## Design decisions

- **Always on.** No config flag. The old engine's `strict_types` was a transition mechanism; the new engine has no legacy to transition from.
- **Names only in error responses.** `available_schemas` is a string array. Agents call `describe-schema` for field details.
- **Watcher stays permissive.** "Tools reject; the watcher absorbs" (Phase 3 Principle 2). Human edits that add unschematized types are indexed normally — types have no claims, fields become orphans.
- **Indexer unchanged.** Existing nodes with unschematized types are not rejected on re-index.
- **`validate-node` unchanged.** It's introspective ("what would happen"), not enforcement. It reports `types_without_schemas` but doesn't block.

## Scope

### In scope

- `create-node`: reject if any `types[]` element has no schema
- `update-node`: reject if `set_types` introduces any type without a schema
- `add-type-to-node`: reject if the type has no schema
- `batch-mutate`: type check per-op; if any op fails, entire batch rolls back (existing atomic semantics)
- `dry_run` parameter on `create-node` (validates types + fields, returns coerced state/issues, writes nothing)
- `dry_run` parameter on `update-node` single-node mode (currently only exists in query mode)
- Structured error response with available schemas and remediation guidance
- Tool description updates for `create-node`, `update-node`, `add-type-to-node`

### Out of scope

- Watcher/indexer enforcement
- Field-level enforcement beyond existing validation
- Retroactive cleanup of existing unschematized nodes (separate task)

## Where in the pipeline

The type-schema check runs in Stage 1, immediately after loading schema context. If any type in `proposed.types` has no schema and `proposed.source === 'tool'`, the pipeline short-circuits before Stage 2 validation. No coercion is attempted, no effective fields computed, no edits log entries created.

For `dry_run`: the pipeline runs through Stage 2 (validate and coerce) and returns the result without entering Stage 3+. The type-schema check still applies in Stage 1 — a dry run with an invalid type is still rejected.

## Behavior specification

### Type validation on tool-initiated writes

For `create-node`, `update-node` (when `set_types` is provided), and `add-type-to-node`:

1. Load the set of schema names from the `schemas` table.
2. For each type in the proposed types array, check membership.
3. If all types have schemas (or `types` is empty): proceed normally.
4. If any type has no schema: return a structured error. Do not write.

Edge cases:
- `types: []` — **allowed**. A typeless node is the universal fallback.
- `types: ["note"]` where `note` has a schema — **allowed**.
- `types: ["reference"]` where `reference` has no schema — **rejected**.
- `types: ["note", "reference"]` mixed — **rejected**. Error lists `["reference"]` as offending.

### Error response

```json
{
  "error": "UNKNOWN_TYPE",
  "unknown_types": ["reference"],
  "message": "Cannot write node with type 'reference' -- no schema exists for this type. Use list-schemas to see available types, or use create-schema to define a new type first.",
  "available_schemas": ["company", "meeting", "movie", "note", "person", "product", "project", "task"],
  "suggestion": "For general-purpose notes and reference material, use type 'note'."
}
```

The `available_schemas` list is always included so the agent can self-correct immediately.

### `dry_run` on `create-node`

New parameter: `dry_run: z.boolean().default(false)`.

When `dry_run: true`:
- Type validation runs (Stage 1). If types are invalid, return `UNKNOWN_TYPE` error.
- Field validation and coercion run (Stage 2). Return `ValidationResult` including `coerced_state`, `issues`, `effective_fields`, `orphan_fields`.
- Path derivation runs. Return the derived `file_path`.
- Conflict check runs. If the derived path already exists, return the conflict.
- **No file is written. No DB mutation. No edits log entry.**

Response on successful dry run:

```json
{
  "dry_run": true,
  "would_create": {
    "file_path": "Notes/Space Travel Overview.md",
    "title": "Space Travel Overview",
    "types": ["note"],
    "coerced_state": {},
    "issues": [],
    "orphan_fields": []
  }
}
```

Intended workflow:
1. Agent calls `create-node` with `dry_run: true`, just `title`, `types`, and `fields` — no body.
2. If dry run succeeds: agent generates body content.
3. Agent calls `create-node` again with the full payload including body.

### `dry_run` on `update-node` single-node mode

Currently `dry_run` exists only in query mode (defaults to `true`). Add it to single-node mode with `default: false`.

When `dry_run: true` in single-node mode:
- Type validation runs (if `set_types` provided).
- Field validation and coercion run. Return the `ValidationResult`.
- **No mutation applied. No file written.**

### Tool description updates

**`create-node`** (current: "Create a new node and write it to disk. Validates against schemas, coerces values, populates defaults."):

> Create a new node and write it to disk. Every type in `types` must have a defined schema -- call `list-schemas` to see available types. For general-purpose notes and reference material, use type `note`. If no `path` is provided, the file location is derived from the type's filename template (e.g., notes go to `Notes/`, meetings go to `Meetings/`). Use `dry_run: true` to validate types and fields before generating long body content -- this catches errors without wasting work.

**`update-node`** (append):

> If `set_types` is provided, every type must have a defined schema. Use `list-schemas` to see available types.

**`add-type-to-node`** (append):

> The type must have a defined schema. Use `list-schemas` to see available types.

## Implementation sketch

### `checkTypesHaveSchemas`

```typescript
function checkTypesHaveSchemas(
  db: Database.Database,
  types: string[],
): { valid: true } | { valid: false; unknown: string[]; available: string[] } {
  if (types.length === 0) return { valid: true };
  const schemaNames = new Set(
    db.prepare('SELECT name FROM schemas').all().map((r: any) => r.name)
  );
  const unknown = types.filter(t => !schemaNames.has(t));
  if (unknown.length === 0) return { valid: true };
  return { valid: false, unknown, available: [...schemaNames].sort() };
}
```

### Integration points

1. **`create-node` handler** — call before constructing `ProposedMutation`. On failure, return `UNKNOWN_TYPE` error. On `dry_run: true` with valid types, run through Stage 2 and return preview.
2. **`update-node` handler** — call only when `set_types` is in the payload. Same error response. Add `dry_run` to single-node mode.
3. **`add-type-to-node` handler** — call with `[type]`. Same error response.
4. **`batch-mutate`** — type check per-op within the batch. On failure, throw to trigger existing transaction rollback.
5. **Watcher path** — no change. `executeMutation` with `source: 'watcher'` never hits this check.

## Test cases

1. `create-node` with valid types — succeeds
2. `create-node` with unknown type — returns `UNKNOWN_TYPE` with `available_schemas`
3. `create-node` with mixed valid/unknown types — rejected, error lists only unknown types
4. `create-node` with empty types — succeeds (typeless node)
5. `create-node` dry_run with valid types — returns preview, no mutation
6. `create-node` dry_run with invalid type — returns `UNKNOWN_TYPE` error
7. `update-node` `set_types` with unknown type — rejected
8. `update-node` single-node dry_run — returns preview, no mutation
9. `add-type-to-node` with unknown type — rejected
10. `batch-mutate` with one bad op — entire batch rolls back
11. Watcher indexing node with unschematized type — succeeds (no enforcement)
