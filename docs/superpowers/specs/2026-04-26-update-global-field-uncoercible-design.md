# `update-global-field` uncoercible-value handling — design (2026-04-26)

**Status:** approved, ready for implementation plan
**Source:** Bundle B v1 postmortem §3 (latent bugs on main worth filing as separate items, item 3)
**Postmortem reference:** `docs/superpowers/specs/2026-04-25-bundle-b-postmortem.md`

## Problem

`update-global-field` (type-change confirmed) silently deletes uncoercible values today.

In `src/global-fields/crud.ts:343-364`, when a confirmed type change encounters node values that can't coerce to the new type, the apply transaction:

1. `DELETE`s the row from `node_fields`,
2. inserts a `value-removed` row into `edits_log` with the original value, source, and reason.

The `edits_log` row is forensic but unreachable: no MCP tool exposes that table. From the operator's perspective, the data is gone.

This conflicts with the CLAUDE.md principle: *"Data is never silently deleted. Orphan fields preserve data."*

## Decision

Refuse the type change by default when uncoercible values exist. Require an explicit opt-in flag to discard them.

The `edits_log` write stays exactly as it is today — it remains a forensic trail. Exposing `edits_log` via MCP is **out of scope** for this work and not promised by it.

Three options were considered (see postmortem §3); rationale for picking refuse-with-flag:

- **A. Document `edits_log` as preservation.** Dead. `edits_log` has no MCP surface; "preservation = SQLite query you have to know to run" doesn't satisfy the spirit of the principle, and exposing the log is a separate decision the user is not pre-committing to here.
- **B. Refuse + opt-in flag.** Picked. Smallest change. Matches the existing `update-schema` `CONFIRMATION_REQUIRED` precedent for orphan-producing claim removals. "Operator explicitly chose to discard" satisfies the *silently* part of the principle without overloading any storage semantics.
- **C. Auto-preserve as `value_raw_text`.** Rejected. Would require a `reconstructValue` fall-through, knock-on changes in conformance / `validate-node` / the renderer, and would overload `value_raw_text` (which today means "watcher saw frontmatter that didn't fit a typed column"). The benefit — silent-but-recoverable preservation — isn't load-bearing in the type-change scenario, where the operator is already in the preview→confirm dance and looking at the uncoercible list.

## Behavior

`update-global-field` type-change apply path gets a second gate. Truth table for the type-change branch (`field_type` differs from current):

| `confirm` | uncoercible count | `discard_uncoercible` | Result |
|---|---|---|---|
| absent / false | n/a | n/a | preview (unchanged) |
| true | 0 | n/a | apply (unchanged) |
| true | >0 | absent / false | fail `CONFIRMATION_REQUIRED`, no DB change |
| true | >0 | true | apply, deletes uncoercible rows + writes `edits_log` (unchanged from today) |

`discard_uncoercible` defaults to `false`. The flag is a no-op when there are no uncoercible values; it does not need to be passed for clean type changes.

The non-type-change branch (description, enum_values, default_value, required, etc.) is untouched.

## Wire shape

### New tool param

In `src/mcp/tools/update-global-field.ts`:

```ts
discard_uncoercible: z.boolean().optional()
  .describe(
    'When applying a type change with uncoercible values, set true to delete those values. ' +
    'Default: refuse the change with CONFIRMATION_REQUIRED.',
  ),
```

### New error envelope (when refused)

```json
{
  "ok": false,
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This type change would discard 3 uncoercible value(s). Set discard_uncoercible: true to proceed, or omit confirm to preview.",
    "details": {
      "affected_nodes": 12,
      "coercible_count": 9,
      "uncoercible": [
        { "node_id": "abc...", "value": "not-a-number", "reason": "..." }
      ]
    }
  },
  "warnings": []
}
```

The `uncoercible` array mirrors the shape returned by the preview path (same `node_id`, `value`, `reason` fields), so an operator inspecting the error response has identical decision information to the preview.

`coercible_count` is included instead of the full `coercible` array — the operator's decision turns on what would be lost, not what would be preserved. (Preview still returns the full `coercible` array; that path is unchanged.)

### Reused error code

`CONFIRMATION_REQUIRED` is the existing `ErrorCode` in `src/mcp/tools/errors.ts:16`, already used by `update-schema` (`src/mcp/tools/update-schema.ts:100`) for orphan-producing claim removals gated by `confirm_large_change`. No new error code is added.

## Implementation locus

Two-file change, no DB schema touch:

### 1. `src/global-fields/crud.ts`

- Add `discard_uncoercible?: boolean` to `UpdateGlobalFieldInput`.
- Inside `updateGlobalField`'s apply branch, after the scan that produces `coercible` and `uncoercible` arrays (~line 297), gate before the existing `applyTx`:
  ```ts
  if (uncoercible.length > 0 && !input.discard_uncoercible) {
    throw new TypeChangeRequiresDiscardError({
      affected_nodes: rows.length,
      coercible_count: coercible.length,
      uncoercible,
    });
  }
  ```
- Define and export `TypeChangeRequiresDiscardError` in the same file (or a sibling `errors.ts` if one is more idiomatic on review). Subclass `Error`, carry the structured payload as a typed `details` field.

### 2. `src/mcp/tools/update-global-field.ts`

- Add the `discard_uncoercible` zod param.
- Pass through to `updateGlobalField(db, name, rest)` — `rest` already spreads it.
- Catch `TypeChangeRequiresDiscardError` specifically (before the existing generic catch) and translate to `fail('CONFIRMATION_REQUIRED', message, { details })`.
- Update the tool's `description` string to document the gate.

No undo wiring changes. No `value_raw_text` changes. No `reconstructValue` changes. No conformance / validation / renderer touches. The blast radius is contained.

## Tests

`tests/global-fields/crud.test.ts`: rewrite the existing `'type change with confirm applies coercion to node_fields'` test (currently asserts that an uncoercible row is deleted) into three focused tests:

1. **All coercible, confirm true:** type change applies, no flag needed. (Existing behavior, locked in.)
2. **Uncoercible present, confirm true, no flag:** `updateGlobalField` throws `TypeChangeRequiresDiscardError`. The error's payload contains `affected_nodes`, `coercible_count`, and the `uncoercible` array. **The DB is completely unchanged** — `global_fields.field_type` is the original value, every existing `node_fields` row is intact, no `edits_log` row was written.
3. **Uncoercible present, confirm true, `discard_uncoercible: true`:** type change applies. Coercible rows updated, uncoercible row deleted, `edits_log` `value-removed` row present (asserts unchanged from today's behavior).

Plus one new MCP-wrapper test (matching the `update-schema` confirmation precedent) that:

- Calls the tool handler with `confirm: true` against a field with uncoercible values, no flag.
- Asserts the response envelope: `ok: false`, `error.code === 'CONFIRMATION_REQUIRED'`, `error.details.uncoercible` is a non-empty array with the expected shape, `error.details.affected_nodes` and `error.details.coercible_count` populated.
- Calls again with `discard_uncoercible: true`. Asserts `ok: true` and the result shape matches today's apply response.

## Documentation

- Tool description updated as above.
- One line in `CLAUDE.md` under conventions:
  > **`update-global-field` discard gate.** Type-change confirm refuses if any existing values won't coerce. Set `discard_uncoercible: true` to opt into data loss; the discarded values are still recorded in `edits_log` (currently SQLite-only).

## Backward compatibility

This is a **wire-format breaking change**. Callers that today pass `confirm: true` against a field with uncoercible values used to silently apply (deleting those values); they now receive `CONFIRMATION_REQUIRED` and must re-call with `discard_uncoercible: true` to get the old behavior.

That's the point of the fix — the silent path was the bug. No grace period, no deprecation flag, no compatibility shim. The change is documented in:

- the tool's `description` string,
- this spec,
- the CLAUDE.md line,
- the commit message.

Internal callers of `updateGlobalField` (the function): the test file and the MCP wrapper are the only call sites today. Both are updated as part of this change.

## Out of scope

The following are explicitly *not* part of this work and are tracked separately:

- **Exposing `edits_log` via MCP** (e.g. a `query-edits-log` tool). Discussed during this design and decided against. If preservation visibility becomes important later, file as its own ticket.
- **`update-global-field` undo capture** shipped 2026-04-29 as part of global-field undo v2 (`7ef5f01 feat(undo): add global-field snapshots`). It touches the same tool but at a different layer.
- **Other "silent data loss" paths.** This spec only addresses `update-global-field` type-change. If similar patterns exist elsewhere (e.g. `update-schema` claim removal already has its own gate; other code paths would need their own audits), they are separate work.
- **Undo atomicity ticket** (postmortem §"Systemic issue"). Independent.

## Open questions

None. All design questions resolved during the brainstorming pass:

- Option A vs. B vs. C → B.
- Param name → `discard_uncoercible`.
- Sentinel error class vs. preview-then-apply two-step → sentinel error class.
- Error code → reuse `CONFIRMATION_REQUIRED`.
- Wire-format compatibility → break by design, no shim.
