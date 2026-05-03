# MCP App Visualization Foundations — Part 2

**Status:** Design
**Date:** 2026-05-03
**Scope:** Foundation #2 (UI rendering hints), Foundation #2.5 (Issue.field audit), Foundation #3 (iframe-write safety policy). Combined spec.
**Predecessor:** `2026-05-03-version-stamping-design.md` (Foundation #1 — version stamps + STALE_NODE).
**Parent:** `[[Vault Engine - MCP App Visualization Foundations]]` in vault.

## Goal

Lift the engine's tool surface from "AI-tuned" to "AI-tuned + UI-tuned" so that the next two write-capable visualization bundles — task list with status enum dropdown, inline title rename on the query-nodes table — and the 3-4 bundles after them ship on shared primitives instead of each one re-litigating field rendering, error display, and write-safety semantics.

The spec covers three threads:

1. **`_meta.ui` field-rendering hints on global fields.** Small, structured, well-known-key vocabulary stored on global field definitions and surfaced through `describe-global-field` and `describe-schema`. Lets bundles render fields generically without forking the schema introspection path.
2. **`Issue.field` population audit.** Existing closed-union `Issue` envelope already carries an optional `field` property, but it isn't populated consistently at every per-field error site. Form-based bundles need this to render "this error goes under input X."
3. **Iframe-write safety policy.** Codify the existing dry-run-then-confirm contract as a written checklist for bundle authors. No new server-side enforcement.

The two near-term bundles gate scope: anything we add must be useful for them, but the structure has to also be right for the next 3-4 bundles we haven't built yet.

## Non-goals

- Per-claim override of `ui` hints (the way `enum_values`, `default_value`, `required` are overridden today). The `describe-schema` shape will carry `ui` per claim for forward compatibility, but in v1 the per-claim value is always equal to the global-field `ui`.
- Inline rendering hints in `query-nodes` results. Bundles fetch hints once per session via `describe-schema` / `describe-global-field` and cache.
- Server-side gating of UI-initiated writes beyond the existing dry-run / confirm gates. The policy in §3 is a bundle-author contract, not a runtime enforcement.
- Tagging UI-initiated calls in `sync_log` / `edits_log` (`source: 'ui'`). Defer until pain shows up.
- A shared client-side helper for inference / rendering. Bundles each implement against the documented inference table; if duplication shows up, factor later.
- Validation-error population for tool-entry zod errors. `Issue.field` means *vault field*, not *zod parameter*.

## Architecture

No architectural changes. Same single mutation pipeline, same `{ok, data|error, warnings}` envelope, same MCP tool registration. We:

- Add a `ui_hints` column to the `global_fields` table.
- Accept an optional `ui` param on `create-global-field` and `update-global-field`.
- Surface `ui` via `describe-global-field` (top-level key) and `describe-schema` (per-claim key).
- Audit direct `Issue` construction sites in `src/mcp/tools/*` to ensure `Issue.field` is populated for the per-field codes (`FIELD_OPERATOR_MISMATCH` and any future per-field `IssueCode`). The `ValidationIssue` path already populates `field` correctly.
- Add a new section to this spec capturing the bundle-author write-safety contract.

Watcher, indexer, embedder, undo, render path, file rendering: untouched.

## Foundation #2 — `_meta.ui` rendering hints

### Vocabulary (closed set, v1)

Unknown keys reject at write time with `INVALID_PARAMS`. Adding a new well-known key is a spec amendment, not freelance.

| Key       | Type                                                                                | Meaning                                                                              |
| --------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `widget`  | enum: `text` \| `textarea` \| `enum` \| `date` \| `number` \| `bool` \| `link` \| `tags` | Override of the inferred input control.                                              |
| `label`   | string, ≤ 80 chars                                                                  | Human display name. Default: field name.                                             |
| `help`    | string, ≤ 280 chars                                                                 | Short UX-y hint; distinct from `description` (the formal field meaning).             |
| `order`   | integer (negative allowed)                                                          | Sort position when rendering a node's full field set; lower = earlier. Default: alphabetical by field name. |

All four keys are optional. An entry with no keys set is equivalent to `null`.

### Inference table (when `widget` is absent)

Bundles infer the widget from `field_type` + `list_item_type`. The table is **canonical** — bundles MUST agree on it so the same field renders the same way across surfaces.

The seven `field_type` values come from `src/validation/types.ts`: `string`, `number`, `date`, `boolean`, `reference`, `enum`, `list`. For `field_type === 'list'`, `list_item_type` carries the element type (any of the other six, except `list` itself).

| `field_type` | `list_item_type`               | Inferred `widget`               |
| ------------ | ------------------------------ | ------------------------------- |
| `string`     | —                              | `text`                          |
| `enum`       | —                              | `enum`                          |
| `number`     | —                              | `number`                        |
| `date`       | —                              | `date`                          |
| `boolean`    | —                              | `bool`                          |
| `reference`  | —                              | `link` *(single)*               |
| `list`       | `string`                       | `tags`                          |
| `list`       | `enum`                         | `tags` *(with enum constraint)* |
| `list`       | `reference`                    | `link` *(multi)*                |
| `list`       | `number` / `date` / `boolean`  | `tags` *(best effort)*          |

`textarea` has no inference path — it's an explicit override only. A schema author who wants multi-line rendering for a `string` field sets `widget: 'textarea'` deliberately.

Inference is documented, not implemented in the engine; a shared utility can be factored out of the second or third bundle if duplication justifies it.

### Storage

New column on `global_fields`:

```
ui_hints TEXT NULL  -- JSON-serialized UiHints object, or NULL when unset
```

NULL means "no hints set; consumers fall back to inference + defaults." Existing rows stay NULL — no backfill needed.

The migration adds the column. Per the project's migration convention, any related index lives in the migration; `createSchema` is no-op on existing DBs.

### Authoring

Both `create-global-field` and `update-global-field` accept an optional `ui` param. Shape:

```ts
type UiHints = {
  widget?: 'text' | 'textarea' | 'enum' | 'date' | 'number' | 'bool' | 'link' | 'tags';
  label?: string;   // <= 80
  help?: string;    // <= 280
  order?: number;   // integer
};
```

Validation rules (enforced in a new `src/global-fields/ui-hints.ts` validator):

- Reject unknown top-level keys.
- `widget` must be one of the eight values.
- `label` / `help` must be strings within length cap.
- `order` must be a finite integer.
- An empty object `{}` is treated as "clear all hints" (stored as NULL).
- An explicit `null` is also "clear all hints" (stored as NULL).

`update-global-field` semantics:

- Absent `ui` key in the request: no change to existing hints.
- `ui: null` or `ui: {}`: clear hints (set column to NULL).
- `ui: { ...partial }`: **replace** hints entirely with the provided object. No deep-merge with previous value. Bundles wanting to "patch" must read-modify-write.

The replace-not-merge rule keeps the contract small. The hint blob is small enough that read-modify-write is cheap.

### Read path

**`describe-global-field` response** — gains a top-level `ui` key:

```json
{
  "ok": true,
  "data": {
    "name": "status",
    "value_type": "text",
    "enum_values": ["open", "in-progress", "done"],
    "description": "Workflow status",
    "ui": { "widget": "enum", "label": "Status", "order": 10 }
  }
}
```

`ui` is always present in the response shape. Value is either a `UiHints` object or `null`.

**`describe-schema` response** — each claim gains a `ui` key:

```json
{
  "ok": true,
  "data": {
    "type": "task",
    "field_claims": [
      {
        "field": "status",
        "required": false,
        "default_value": "open",
        "enum_values": ["open", "in-progress", "done"],
        "ui": { "widget": "enum", "label": "Status", "order": 10 }
      }
    ]
  }
}
```

In v1 the per-claim `ui` always equals the global field's `ui`. The shape leaves room for per-claim override later without bundles having to refactor the read path.

### Per-type override — out of scope

No `overrides_allowed.ui` flag, no merge logic. The `describe-schema` per-claim shape exists only as forward-compatibility wiring. If "field `notes` should render single-line on type=person but textarea on type=meeting" turns out to be a real ask, add it as a follow-up spec.

### Undo

Hint changes flow through `update-global-field`, which already captures `undo_global_field_snapshots` (see `src/undo/global-field-snapshot.ts`). The snapshot's row-level capture pulls the new `ui_hints` column for free; no undo-system changes needed.

### Watcher / file rendering

Untouched. Hints are DB-only metadata; markdown rendering doesn't see them. The watcher's parse → validate → coerce → reconcile → apply → render loop is unaffected.

## Foundation #2.5 — `Issue.field` audit

### Motivation

The closed-union `Issue` shape (`src/mcp/tools/errors.ts:29-35`) declares `field?: string`. Form-based bundles need per-field errors to land under the correct input; without `Issue.field` populated, the bundle can only show errors as a top-level banner.

### Current state — narrower than first thought

The validation path is already correct:

- `ValidationIssue` (`src/validation/types.ts:89-95`) has **`field: string`** — required, not optional. Every `ValidationIssueCode` is per-field by construction.
- `adaptIssue` (`src/mcp/tools/errors.ts:64-80`) propagates `v.field` from `ValidationIssue` into the unified `Issue` correctly.
- Coercion paths funnel through validation and surface as `ValidationIssue`s; `coercion_code` (`STRING_TO_NUMBER`, `STRING_TO_DATE_FUZZY`, etc.) is a property on `CoercedValue`, not an `IssueCode`.

The gap is in **direct `Issue` construction inside tool handlers** — places that build `Issue` objects without going through `adaptIssue`. These currently never set `field`, even when the issue is per-field.

### Scope

Audit each direct `Issue` construction site (search pattern: `: Issue[] =` and `: Issue |` and `Issue =` in `src/mcp/tools/*.ts`) and ensure:

- Per-field issues populate `field` with the vault field name.
- Non-per-field issues (title-level, body-level, type-level, query-level, parameter-level) leave `field` unset.

Known sites from a `grep` pass: `query-nodes.ts:150,196,207,349,389`, `update-node.ts:559,628,817,942`, `batch-mutate.ts:117`, `delete-node.ts:78`, `remove-type-from-node.ts:77,102`, `query-sync-log.ts:87`. Plus any `IssueCode` added later — e.g., the unioned warning codes `FIELD_OPERATOR_MISMATCH` (per-field), `CROSS_NODE_FILTER_UNRESOLVED` (query-level), `LAST_TYPE_REMOVAL` (type-level), `PENDING_REFERENCES` (cross-node), `RESULT_TRUNCATED` (query-level), `DEPRECATED_PARAM` (parameter-level).

Out of scope:

- Anything in `src/validation/*` — `ValidationIssue.field` is required and already populated.
- `ToolIssue` codes (`TITLE_WIKILINK_UNSAFE`, `FRONTMATTER_IN_BODY`, `TYPE_OP_CONFLICT`, `TITLE_FILENAME_SANITIZED`) — by design these are title/body/type-level, not per-field; the type doesn't even carry `field`.
- Tool-entry zod validation errors (`INVALID_PARAMS`). These describe parameter names, not vault field names. `Issue.field` is reserved for vault fields.
- Restructuring `Issue` or `ValidationIssue` to add new properties.
- Any change that affects the `IssueCode` union — typecheck-pinned by `npm run build`; out of scope.

### Behavior contract

For every `IssueCode` currently in the union, the spec pins whether `field` is expected to be populated when an instance is constructed. Codes are split by source.

**`ValidationIssueCode` (from `src/validation/types.ts`)** — all per-field by construction:

| Code                          | `field` populated? |
| ----------------------------- | ------------------ |
| `REQUIRED_MISSING`            | yes                |
| `ENUM_MISMATCH`               | yes                |
| `TYPE_MISMATCH`               | yes                |
| `COERCION_FAILED`             | yes                |
| `LIST_ITEM_COERCION_FAILED`   | yes                |
| `MERGE_CONFLICT`              | yes                |
| `INTERNAL_CONSISTENCY`        | yes                |

**`ToolIssueCode` (from `src/mcp/tools/title-warnings.ts`)** — title/body/type-level, never per-field; the `ToolIssue` type carries no `field` property:

| Code                          | `field` populated? |
| ----------------------------- | ------------------ |
| `TITLE_WIKILINK_UNSAFE`       | no                 |
| `FRONTMATTER_IN_BODY`         | no                 |
| `TYPE_OP_CONFLICT`            | no                 |
| `TITLE_FILENAME_SANITIZED`    | no                 |

**Additional `IssueCode` warning entries (from `src/mcp/tools/errors.ts:19-27`)** — constructed directly in tool handlers:

| Code                            | `field` populated? | Why                              |
| ------------------------------- | ------------------ | -------------------------------- |
| `FIELD_OPERATOR_MISMATCH`       | yes                | per-field (operator vs type)     |
| `CROSS_NODE_FILTER_UNRESOLVED`  | no                 | query-level (join target)        |
| `LAST_TYPE_REMOVAL`             | no                 | type-level                       |
| `PENDING_REFERENCES`            | no                 | cross-node                       |
| `RESULT_TRUNCATED`              | no                 | query-level                      |
| `DEPRECATED_PARAM`              | no                 | parameter-level                  |

`ErrorCode` values (`UNKNOWN_TYPE`, `STALE_NODE`, `CONFIRMATION_REQUIRED`, etc.) live on the top-level `error.code`, not on `Issue`, and have no `field` property — out of scope for this audit.

The full table lives next to the audit test so it stays close to the assertions.

### Out-of-scope discoveries

If the audit surfaces a structural problem — e.g., an emission site lacks the context to know which field the issue belongs to — capture it as a follow-up TODO in the spec, not a redesign. Do not expand scope mid-audit.

## Foundation #3 — Iframe-write safety policy

This section is the deliverable. No code change beyond the audit pass below.

### Bundle author contract — writes

The contract a bundle author MUST follow when calling tools that write. "MUST" means honoring it is load-bearing for the safety story; "SHOULD" means best practice but not a correctness requirement.

1. **High-blast-radius write tools MUST be called dry-run-first.** Surface the preview to the user. Then call again with `dry_run: false` and `confirm: true` (where applicable — e.g., `update-schema`'s orphan gate, `update-global-field`'s discard gate). No silent flip from preview to commit. Covers: `update-node` query mode (server-side default `true`), `batch-mutate`, `update-schema`, `update-global-field` type-change. Note: `batch-mutate` and `update-schema` default `dry_run: false` in code (audit finding — see table); bundles MUST pass `dry_run: true` explicitly on first call.

2. **Tools that default `dry_run: false` MAY be called directly when the click *is* the confirmation.** Single-node `update-node`, `add-type-to-node`, `remove-type-from-node`, `rename-node`, `create-node`. The bundle's UI affordance — clicking a status pill, pressing enter on a renamed title, hitting "Save" on a form — is the user's intent. Trust the bundle's UX + undo as the safety net.

3. **`delete-node` is the carve-out.** It defaults `dry_run: false` server-side (the AI path keeps that ergonomics), but a bundle MUST call it with `dry_run: true` first, surface the preview (count of incoming references, body excerpt, types being removed), and only then commit. The blast radius — node + body + relationships + extractions — does not fit the "click is confirmation" rubric.

4. **Bundles MUST surface server warnings.** Any non-empty `warnings` array in the envelope renders visibly. Don't filter, don't suppress. Soft signals like `LAST_TYPE_REMOVAL`, `PENDING_REFERENCES`, `CROSS_NODE_FILTER_UNRESOLVED`, `RESULT_TRUNCATED`, `STRING_TO_DATE_FUZZY`, `TITLE_WIKILINK_UNSAFE` exist precisely so the user can act on them.

5. **Bundles MUST surface validation errors next to the relevant input.** When `Issue.field` is set, render the error attached to that field's control. Top-level error banner is for issues without `field` (node-level).

6. **Bundles SHOULD expose undo** for at least the most recent operation initiated from that bundle. `list-undo-history` + `undo-operations` are the existing primitives. Bundles that issue many writes per session (kanban, batch-edit) SHOULD surface a recent-ops strip with per-op undo.

7. **Bundles SHOULD cache schema/hint reads per session.** `describe-global-field` and `describe-schema` results don't change between tool calls within the same iframe lifecycle. No polling, no re-fetch on every operation. (Listed here to set expectations; staleness is bounded by the iframe's lifetime, which is short.)

### Audit pass — dry-run defaults

To make the contract accurate, this spec enumerates the current `dry_run` defaults across the write tools. Implementation-time check: spot the table against the code; correct the table or the code if they diverge.

| Tool                         | `dry_run` default | Confirm gate?                                |
| ---------------------------- | ----------------- | -------------------------------------------- |
| `create-node`                | `false`           | none                                         |
| `update-node` (single-node)  | `false`           | none                                         |
| `update-node` (query mode)   | `true`            | none beyond preview                          |
| `delete-node`                | `false`           | none server-side; **bundle MUST dry-run**    |
| `add-type-to-node`           | `false`           | none                                         |
| `remove-type-from-node`      | `false`           | none                                         |
| `rename-node`                | `false`           | none                                         |
| `batch-mutate`               | `false`           | none beyond preview                          |
| `update-schema`              | `false`           | `CONFIRMATION_REQUIRED` on orphan field values |
| `update-global-field`        | `false`           | `CONFIRMATION_REQUIRED` on type change with uncoercible values; `discard_uncoercible` opt-in |
| `delete-schema`              | `false`           | none                                         |
| `delete-global-field`        | `false`           | none                                         |
| `create-schema` / `create-global-field` / `rename-global-field` | `false` | none |

If the audit finds a divergence (e.g., a tool the parent doc said defaults `true` actually defaults `false`), correct the table here and call it out in the implementation plan; do not silently change the code.

### What we explicitly do not change

- No new `_meta.client_kind` request marker.
- No new `_meta.ui.intent: "write"` response marker.
- No flip of `delete-node`'s server-side default. Server keeps current ergonomics; the bundle obligation is contract-only.
- No telemetry tagging.

The bundles are ours; undo is real; we don't multiply the surface area for a problem that hasn't been demonstrated.

## Components

Files added:

- `src/db/migrations/<NNN>-ui-hints.ts` — adds `ui_hints` column to `global_fields`. Migration sequence number resolved at implementation time.
- `src/global-fields/ui-hints.ts` — `UiHints` type, validator, closed-key vocabulary, widget enum.

Files changed:

- `src/global-fields/types.ts` — extend `GlobalField` with optional `ui_hints` field.
- `src/global-fields/crud.ts` — accept `ui` param on create / update; serialize to JSON column; validate via `ui-hints.ts`; surface uncoercible audit per §2.5.
- `src/mcp/tools/create-global-field.ts` — accept `ui` param in zod schema.
- `src/mcp/tools/update-global-field.ts` — accept `ui` param; semantics per §2 ("authoring").
- `src/mcp/tools/describe-global-field.ts` — return `ui` (top-level key, possibly null).
- `src/mcp/tools/describe-schema.ts` — return `ui` per claim (in v1, hard-coded equal to global-field `ui`).
- Direct `Issue` construction sites in `src/mcp/tools/*` (notably `query-nodes.ts`, `update-node.ts`, `batch-mutate.ts`, `delete-node.ts`, `remove-type-from-node.ts`, `query-sync-log.ts`) — set `Issue.field` for `FIELD_OPERATOR_MISMATCH` and any other per-field code identified in the §2.5 contract table.

Files added (tests):

- `tests/global-fields-ui-hints.test.ts` — validation, round-trip, defaults.
- `tests/issue-field-audit.test.ts` — table-driven `Issue.field` coverage.

Untouched: watcher, indexer, embedder, undo system, render path, schema propagation, linked-node traversal, search, extraction.

## Testing strategy

**Foundation #2 (`_meta.ui` hints).**

- Migration test: column added, existing rows default NULL.
- Validation tests: valid `ui` accepted; unknown key rejected; out-of-enum widget rejected; `label` > 80 chars rejected; `help` > 280 chars rejected; non-integer `order` rejected.
- Clear semantics: `ui: null` and `ui: {}` both clear stored hints (column → NULL).
- `update-global-field` no-key-change: request without `ui` key leaves stored hints intact.
- Replace-not-merge: `update-global-field({ui:{label:'X'}})` after a previous `ui: {label:'A', help:'B'}` results in `{label:'X'}` — no `help` carried over.
- Round-trip: `update-global-field({ui:…})` → `describe-global-field` returns the same blob.
- Read shape: `describe-global-field` always carries `ui` (possibly null); `describe-schema` carries `ui` on each claim.
- No inference unit tests — inference is bundle-side and documented.

**Foundation #2.5 (`Issue.field` audit).**

- Table-driven test covering each per-field `ValidationIssueCode`. For each row in the §2.5 behavior contract table, a fixture triggers the issue and asserts `field` is set (or unset, as appropriate).
- Companion test asserting node-level codes leave `field` unset.

**Foundation #3 (write-safety policy).**

- No tests. Doc deliverable + dry-run-default audit pass against the §3 table. Manual cross-check during implementation.

**Excluded:** no perf tests, no integration tests beyond what existing test files already exercise, no UI bundle tests (out of scope; bundles are a separate consumer).

## Migration & deploy

- Single migration adding `ui_hints` column; existing rows stay NULL. No data conversion.
- No version sentinel needed (per CLAUDE.md, search-version-style sentinels are for embedding-pipeline changes that invalidate stored vectors; this is a pure column add).
- Deploy: ordinary `npm run build` + systemd restart. No Cloudflare tunnel changes.
- Reversibility: dropping the column removes the data; reverting the tool changes restores the old shape. The `Issue.field` audit is forward-compatible — populating an optional property never breaks consumers.

## Implementation-plan questions (deferred)

- Migration sequence number / file naming pattern in `src/db/migrations/`.
- Exact location of the `Issue.field` audit table — co-located with the test, or extracted into the docs/ tree.
- Whether to bundle the §3 "Bundle Author Contract" into a standalone `docs/mcp-app-bundle-author-guide.md` immediately, or keep it inside this spec until a second similar doc forces extraction. (Recommendation: keep inside spec; lift later.)
- Naming of the `UiHints` validator's exported symbols; convention in `src/global-fields/` favors snake_case JSON shapes and camelCase TS types.
- Whether `describe-schema`'s per-claim `ui` should be omitted from the response when null, or always present. (Recommendation: always present; matches `describe-global-field`'s shape.)

## Reversibility

Per-thread:

- **#2 (`ui_hints`)**: drop the column, remove `ui` params from the four tools, drop the validator module. Bundles fall back to inference. One commit.
- **#2.5 (Issue.field audit)**: leaving the property populated when not strictly needed is harmless; reversal would mean explicitly clearing `field` at audited sites. No realistic reason to revert.
- **#3 (write-safety policy)**: documentation; revert by deleting the section. No code to undo.

If any thread proves wrong, the others stand alone — they are independent.

## Acceptance gate

Spec is "done" — and we can move into implementation — when all of the following are true:

1. Vocabulary, inference table, storage, authoring, and read path for `_meta.ui` are unambiguous (no TBDs, no contradictions).
2. The `Issue.field` behavior table covers every per-field `ValidationIssueCode` currently emitted.
3. The dry-run-default audit table in §3 is verified against the code (or the discrepancy is captured as a TODO in the implementation plan).
4. The two near-term bundles (status enum dropdown, inline title rename) can be sketched against this spec without inventing new concepts. Reviewer mentally walks each one through and signs off.

After acceptance, `writing-plans` skill produces the implementation plan; this spec is the input.
