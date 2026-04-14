# Date Tokens — Design Spec

**Date:** 2026-04-14
**Status:** Approved
**Origin:** Vault note "Vault Engine - Date Tokens"

## Summary

Date tokens are special strings usable as `default_value` on global fields (or schema claim overrides). When a default is applied — during node creation, type addition, or normalizer backfill — a date token resolves to a formatted date/time string derived from the file's metadata or the current time.

## Token Syntax

Three tokens, each with an optional format string:

| Token | Resolves to | Source |
|-------|------------|--------|
| `$ctime` | File creation time | `fs.statSync().birthtimeMs` |
| `$mtime` | File modification time | `fs.statSync().mtimeMs` |
| `$now` | Current time at evaluation | `Date.now()` |

**Format:** `$token` or `$token:FORMAT`

Examples:
- `$ctime:YYYY-MM-DD` → `2024-03-15`
- `$mtime:MM/DD/YYYY` → `03/15/2024`
- `$now:YYYY-MM-DDTHH:mm` → `2026-04-14T09:30`
- `$ctime` → `2024-03-15` (default format: `YYYY-MM-DD`)

**Format tokens:** `YYYY`, `MM`, `DD`, `HH` (24h), `mm`, `ss`. Implemented with a lightweight internal formatter — no external dependency.

**Default format:** `YYYY-MM-DD` when the format string is omitted.

## Storage

Tokens are stored literally as the `default_value` string in the database. They are never resolved at storage time. The DB column (`global_fields.default_value`, `schema_field_claims.default_value`) holds the raw token string (e.g. `"$ctime:YYYY-MM-DD"` serialized as JSON).

## Resolution Rules

### When defaults apply

A date token default is resolved and applied only when **all** of these are true:

1. The node's types claim the field (via schema field claims)
2. The field has no value on the node — not present in frontmatter, or present but null/empty
3. The field has a `resolved_default_value` (from global field or schema claim override)

**Defaults never overwrite.** If a field already has any value, the default is skipped entirely. This holds across all code paths.

### Field type interaction

Tokens are field-type agnostic. The resolved value is a plain string. Downstream handling depends on field type:

- **reference:** The renderer wraps in `[[...]]` as it already does for reference values
- **string:** Bare formatted date string
- **date:** Goes through normal date coercion
- **list (reference):** Wrapped in `[[...]]` per item

### Fallback for new files

`$ctime` and `$mtime` require a file on disk to stat. For `create-node` (new file, not yet written), both fall back to `$now` (i.e. `Date.now()`). After the file exists, subsequent normalize passes will not re-resolve because the field already has a value from creation.

### Non-existent reference targets

A resolved reference (e.g. `[[2024-03-15]]`) may point to a daily-note node that doesn't exist. This is acceptable — the system does not create missing reference targets.

## Required + Default Interaction (Bug Fix)

Currently, `validateProposedState` (line 71-78) treats `resolved_required` and `resolved_default_value` as independent: a required field that's missing produces `REQUIRED_MISSING` and skips default application. This is wrong.

**New behavior:** When a field is required and missing:
1. If `resolved_default_value` is non-null, resolve and apply it (populate the field)
2. If `resolved_default_value` is null, produce `REQUIRED_MISSING` error

Semantics: "required" = must have a value; "default" = where to get one if none provided. They compose naturally.

## Code Changes

### New module: `src/validation/resolve-default.ts`

```typescript
interface FileContext {
  birthtimeMs: number;
  mtimeMs: number;
}

function resolveDefaultValue(
  defaultValue: unknown,
  fileCtx: FileContext | null
): unknown
```

- If `defaultValue` is not a string or doesn't match `$ctime`, `$mtime`, or `$now` pattern, return unchanged
- Parse the token and optional format string
- Resolve timestamp from `fileCtx` (or `Date.now()` for `$now`, or fallback for null `fileCtx`)
- Format using the format string (default `YYYY-MM-DD`)
- Return the formatted date string

### `src/validation/validate.ts`

- Function signature gains optional `fileCtx?: FileContext`
- Lines 71-78 (required + missing): check for `resolved_default_value` before erroring. If present, resolve via `resolveDefaultValue()` and populate `coerced_state` with source `'defaulted'`
- Lines 81-87 (optional + missing + has default): pass through `resolveDefaultValue()` before assigning

### `src/pipeline/populate-defaults.ts`

- `populateDefaults()` gains `fileCtx` parameter
- Calls `resolveDefaultValue()` when applying each default

### `src/pipeline/execute.ts`

- At pipeline start, when `file_path` is known and file exists on disk, stat the file to build `FileContext`
- Thread `FileContext` into `validateProposedState()` and `populateDefaults()`

### `src/sync/normalizer.ts`

New step in the normalizer sweep, after loading a node's DB fields and before re-rendering:

1. Call `mergeFieldClaims` for the node's types to get effective fields
2. For each effective field: if the node has no value for it and `resolved_default_value` is non-null, resolve the token using the file's stat (already available from quiescence check) and include in the mutation
3. Nodes where all fields are already populated get no extra writes

This is the path that backfills existing nodes.

### No changes to

- DB schema (columns unchanged)
- Global field CRUD (accepts `unknown`, tokens are just strings)
- Schema CRUD (same)
- Merge algorithm (token-unaware, just passes through the string)
- Renderer (already handles reference wrapping)
- MCP tool parameter schemas (`default_value` remains `z.unknown().optional()`)

## Vault Configuration (Post-Deployment)

After the feature is deployed, configure the vault via MCP tool calls:

### 1. Set date token default on the `date` global field

```
update-global-field: date
  default_value: "$ctime:YYYY-MM-DD"
```

### 2. Make `date` required

**Option A — globally (all 9 claiming types):**
```
update-global-field: date
  required: true
```
Applies to: project, meeting, company, movie, note, product, recipe, cookbook, task.

**Option B — per-schema (selective types):**
```
update-global-field: date
  per_type_overrides_allowed: true

update-schema: note
  field_claims: [{ field: "date", required: true }]

update-schema: meeting
  field_claims: [{ field: "date", required: true }]

# ... repeat for desired types
```

### 3. Run normalizer sweep

The normalizer backfills all nodes missing `date` with their file's birthtime formatted as `YYYY-MM-DD`. For the `note` schema alone, this fills ~217 nodes. Other schemas contribute additional nodes depending on coverage gaps.

### Other fields

The token system is available for any field on any schema. Any `default_value` set to a `$ctime`, `$mtime`, or `$now` token will resolve at application time.
