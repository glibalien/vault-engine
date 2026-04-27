# Default-Population Consolidation — Design

**Status:** Approved 2026-04-27, ready for implementation plan.
**Branch:** `refactor/default-population-consolidation`.
**Backlog item:** §3d from `Vault Engine - Deferred Backlog 2026-04-25`.

## Summary

Collapse the two parallel default-population code paths in `validation/validate.ts` and `pipeline/populate-defaults.ts` into one. `validateProposedState` becomes the single defaulting site for all writes; `populate-defaults.ts` is deleted; callers that need to know which fields were defaulted read it from the validation result.

`schema/propagate.ts`'s inline default emission stays as-is — its responsibility (defaulting only `diff.added` claims, with per-node `fileCtx`) is genuinely different from the all-missing-required loop the other two share.

The "defaults are creation-only" invariant is preserved: the `skipDefaults` gate is unchanged, normalizer/propagation/undo paths still skip, watcher/tool paths still default.

## Motivation

Two callsites today implement the same loop:

```ts
if (!skipDefaults && ef.resolved_required && ef.resolved_default_value !== null) {
  resolveDefaultValue(ef.resolved_default_value, fileCtx);
  // record the defaulted field
}
```

- `validate.ts:73-80` — populates `coerced_state` with `source: 'defaulted'`.
- `populate-defaults.ts:39-48` — populates a separate `defaults` map plus a parallel `populated` array for callers to merge externally.

The duplication exists because two callers (`add-type-to-node` and the `watcher`) want to compute defaults *before* invoking the pipeline and merge them into the proposed fields. That pre-merge has two costs:

1. The "if required && has default" condition is duplicated. Future changes (e.g. conditional defaults, expanded override semantics) must update two places.
2. The watcher's pre-merge only fires for newly-typed nodes or brand-new files (the two cases where defaulting is most meaningful). Within those cases it silently suppresses `field-defaulted` edits-log entries: defaults that the caller pre-merged appear as `source: 'provided'` to `validate.ts`, so `execute.ts`'s emission block doesn't fire. The result is inconsistent — for *other* watcher writes (existing file, no type change, but required-with-default field missing), `validate.ts` does default and `field-defaulted` fires normally. The forensic log is lossy and source-inconsistent on watcher writes.

Consolidating eliminates the duplication and fixes the watcher emission gap as a free win.

## Design

### Single defaulting site

`validateProposedState` in `validation/validate.ts` is the only place that decides whether a missing required field gets a default. It already does this correctly; nothing in its logic changes.

### New helper

A small pure function in `validation/validate.ts`:

```ts
export function defaultedFieldsFrom(result: ValidationResult): Array<{
  field: string;
  default_value: unknown;
  default_source: 'global' | 'claim';
}> {
  const out = [];
  for (const cv of Object.values(result.coerced_state)) {
    if (cv.source !== 'defaulted') continue;
    const ef = result.effective_fields.get(cv.field);
    out.push({
      field: cv.field,
      default_value: cv.value,
      default_source: ef?.default_source ?? 'global',
    });
  }
  return out;
}
```

Replaces the three places that today loop over `coerced_state` (or `populated`) to extract the same triple. Used by:

- `execute.ts:168-174` (tool branch's `defaultedFields` collection)
- `execute.ts:226-232` (watcher branch's `defaultedFields` collection)
- `add-type-to-node.ts` (response payload `added_fields`, dry-run `would_add_fields`)

### Caller changes

**`add-type-to-node.ts`:**

- **Dry-run path:** Today calls `populateDefaults` then `validateProposedState(merged, ...)`. After: a single `validateProposedState(currentFields, newTypes, ...)` call. Use `defaultedFieldsFrom(result)` to derive `would_add_fields`.
- **Live path:** Today pre-merges defaults into `mergedFields`, calls `executeMutation` with the merged fields, then manually writes `field-defaulted` entries via `writeEditsLogEntries`. After: pass `currentFields` and `newTypes` to `executeMutation` directly. The pipeline's own `field-defaulted` emission fires (because `coerced_state[field].source === 'defaulted'`). The post-mutation log block is deleted.
- **Re-adoption detection:** A field is re-adopted if it's claimed by the new type AND in `currentFields` AND `coerced_state[field]?.source !== 'defaulted'`. Same set arithmetic as today, derived from the validation result instead of the `populated` array.

**`watcher.ts`:**

Both `populateDefaults` calls (one for newly-added types on existing nodes, one for new files) are deleted. The watcher just passes `parsedFields` through to `executeMutation`. `validate.ts` defaults missing required fields (the watcher source has `skipDefaults=false`); `execute.ts` emits `field-defaulted` entries automatically.

**Everyone else:** unchanged. `create-node`, `update-node`, normalizer, propagation, undo paths are not touched.

### Behavior change: watcher edits-log emission

Today, when the watcher writes a node where defaults trigger (newly-typed file or type-addition with missing required-with-default fields), no `field-defaulted` entry is recorded in `edits_log`. After this change, those entries will be recorded with `source: 'watcher'`.

This is a bugfix, not a regression: every other code path emits `field-defaulted` consistently; the watcher's pre-merge silently suppressed it. Verified that no current consumer of `edits_log` (only `query-sync-log`, which is general-purpose) breaks on the new entries.

The spec calls this out explicitly so any future audit of the diff sees it.

### What the `skipDefaults` gate still enforces

- `mutation.source === 'normalizer'` → skips defaults. Re-rendering existing DB state must not retroactively populate.
- `mutation.source === 'propagation'` → skips defaults. The propagation path manages its own per-claim adoption defaults inline.
- `mutation.source === 'undo'` → skips defaults. Restoring a snapshot must not backfill values that weren't there.
- `mutation.source === 'tool'` or `'watcher'` → defaults populate.

Unchanged from today.

## Tests

### New tests (added in TDD red phase before any refactor)

1. **`add-type-to-node` response shape** (extends `tests/mcp/add-type-to-node.test.ts` if not already covered):
   - Adding a type whose claim adds a required-with-default field → response `added_fields` contains it.
   - Per-claim override of `default_value` → `field-defaulted` row in `edits_log` has `default_source: 'claim'`.
   - Re-adoption: orphan field becomes claimed → appears in `readopted_fields`, not `added_fields`.
   - Dry-run `would_add_fields` matches live-mode `added_fields` for the same input.

2. **Watcher `field-defaulted` emission** (new file: `tests/sync/watcher-field-defaulted.test.ts`):
   - Watcher writes a newly-typed file where a required-with-default field is missing → `edits_log` contains a `field-defaulted` row with `source: 'watcher'` and the right `default_source`.
   - Watcher re-saves an already-defaulted file → no new `field-defaulted` row (the field is present in the parsed frontmatter, so `validate.ts` marks it `source: 'provided'`).

3. **Source-attribution invariant** (parametrized, new file or extension of an existing edits-log test):
   - For each entrypoint ∈ {`create-node`, `add-type-to-node`, watcher type-add}, defaulting a required field emits a `field-defaulted` row with the matching `source` and right `default_source`.

### Tests retargeted

- `tests/pipeline/populate-defaults.test.ts` → renamed/rewritten as `tests/validation/defaults.test.ts`. Same scenarios, asserted via `validateProposedState` and `defaultedFieldsFrom` instead of `populateDefaults`.
- `tests/phase3/tools.test.ts:132` (one line using `populateDefaults`) → replaced with equivalent `validateProposedState` call.

### Tests left alone

- `create-node` defaulting — behavior unchanged.
- `update-node` defaulting — behavior unchanged.
- Schema propagation — `propagate.ts` untouched.
- Normalizer — `skipDefaults` invariant intact.

## Implementation order

Each step leaves the tree green:

1. **Extract `defaultedFieldsFrom` helper** in `validate.ts`. Pure refactor: `execute.ts:168-174,226-232` swap their inline loops for the helper. No behavior change. Existing tests pass.

2. **Add new tests** (red phase) — the response-shape tests, the watcher emission test, the source-attribution invariant. Some pass, the watcher-emission test fails (today's pre-merge suppresses it).

3. **Refactor `add-type-to-node`**: delete `populateDefaults` import + call + post-mutation `writeEditsLogEntries` block. Both dry-run and live paths converge on a single `validateProposedState` call. Tests from step 2 pass for add-type-to-node.

4. **Refactor `watcher.ts`**: delete both `populateDefaults` calls. The watcher emission test from step 2 now passes.

5. **Delete `src/pipeline/populate-defaults.ts`** and its export in `src/pipeline/index.ts`. Retarget `tests/pipeline/populate-defaults.test.ts` → `tests/validation/defaults.test.ts`. Update the one assertion in `tests/phase3/tools.test.ts:132`.

Steps 1 and 5 are pure cleanups. Steps 3 and 4 are the behavior-touching changes guarded by step 2's tests. Each commit is independently reverting-safe.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| `add-type-to-node` `added_fields` contents drift | Low | Dedicated response-shape test compares before/after for the same input. |
| Re-adoption set arithmetic regresses | Low | Dedicated re-adoption test with an orphan field that becomes claimed. |
| Watcher emission breaks a downstream `edits_log` consumer | Very low | Verified — only `query-sync-log` reads it, and it's general-purpose. |
| Source attribution drifts on edits-log rows | Low | Source-attribution invariant test covers all three entrypoints. |
| Coercion-changed defaults edge case | Low | `validate.ts` already produces `source: 'defaulted'` for these; `execute.ts` already reads from `coerced_state`. The helper just packages what's there. |

## Out of scope

- **`schema/propagate.ts` consolidation.** Different responsibility (only `diff.added`, per-node `fileCtx`). Kept as-is.
- **Backlog note refresh.** The 2026-04-25 backlog will be updated in the next normal refresh; not part of this PR.
- **CLAUDE.md changes.** The "Defaults are creation-only" Conventions entry is still accurate as-is.
