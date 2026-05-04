# query-nodes Interactive Table — v1

**Status:** Design
**Date:** 2026-05-03
**Scope:** Multi-session build (M1–M5). Replaces the pilot's read-only flat list with a schema-driven interactive table over the same `query-nodes` MCP tool. No engine changes — purely client-side bundle work.
**Predecessors:**

- `2026-05-02-mcp-apps-pilot-query-nodes-design.md` — pilot mechanics, `ext-apps` SDK, `register.ts`, build wiring
- `2026-05-03-version-stamping-design.md` — Foundation #1: `version` column, `expected_version`, `STALE_NODE`
- `2026-05-03-mcp-app-foundations-2-3-design.md` — Foundations #2/2.5/3: `_meta.ui` hints, `Issue.field` audit, iframe-write contract

**Parent:** `[[Vault Engine - MCP App Visualization Foundations]]` in vault.

## Goal

Lift the existing `query-nodes` MCP App from a read-only flat list into a generic, schema-driven, interactive table that handles every type the vault knows about — by reading widget hints from `describe-schema` and rendering generically per the foundation #2 vocabulary. One bundle covers all single-type table scenarios; new schemas get visualizations "for free" via their `ui_hints`.

The four user-facing capabilities for v1:

1. **Live data on mount.** Every iframe mount calls `query-nodes` itself; browser refresh always shows latest.
2. **Inline edit for shown fields.** Per-widget editor on every cell, dry_run-then-confirm semantics with a "smart" path that surfaces a preview pill only when dry_run flags something notable.
3. **All available fields as columns.** Sensible defaults for column visibility plus a user-toggleable "columns" picker.
4. **Schema-driven filter chips.** Coexist with the pilot's generic filter strip; one chip per filterable field on the locked type, widget-shaped.

## Non-goals

- **Multi-type / heterogeneous tables.** v1 requires a single locked type. Multi-type results render a "pick a type" banner with a flat fallback list.
- **Auto-refresh, push, websockets, multi-client live updates.** Charter defers until pain. Mount + manual refresh button only.
- **Body viewing or editing.** Body lives outside cells. v1 rows do not expand to show body (the pilot's row-body drill-down is removed). Row expansion in M4 is repurposed for parent → child node expansion. A future "node detail" / "node editor" surface owns body view + edit.
- **Bulk row-select + batch edit.** Composes with `update-node` query mode but deferred to M5.
- **Reference autocomplete picker.** Deferred to M5; v1 reference filter is presence-only ("is set / is not set").
- **Custom widgets beyond the 8 vocab values** in the foundation spec (`text`, `textarea`, `enum`, `date`, `number`, `bool`, `link`, `tags`).
- **Schema authoring from the iframe.** Creating fields, types, claims is out of scope; the bundle is a consumer of the schema, not an editor.
- **Server-side gating of UI-initiated calls** beyond the existing dry_run/confirm contract. No new server enforcement.
- **`source: 'ui'` tagging in `sync_log` / `edits_log`.** Defer until forensic need shows up.
- **CSS theming work.** Host-style variables (already wired in pilot) drive color and typography; no design-system rework.

## Architecture

The bundle is a client of MCP tools, not a parallel write surface. The single mutation pipeline (`executeMutation` → validate → coerce → reconcile → apply → render) remains the only write path. Title-cell saves call `rename-node`; everything else calls `update-node`. STALE_NODE, `Issue.field`, dry_run/confirm, and undo all flow through the existing closed-union envelope.

The pilot's `register.ts` and Vite build wiring are unchanged. `app.ts` and `index.html` are largely rewritten. No engine code changes — every required server-side primitive (version stamping, ui_hints surfacing, Issue.field, dry_run, expected_version) was shipped as part of the foundations bundles.

What's new is purely client-side, organized as ~14 small modules inside `src/mcp/ui/query-nodes/`:

- `app.ts` — top-level App wiring (`connect`, `ontoolinput`/`ontoolresult`, mount sequence, event delegation root)
- `state.ts` — typed state shape: locked type, current args, schema cache, results envelope, in-flight tracking, expanded-row map (M4-ready)
- `client.ts` — typed wrappers around `app.callServerTool` for `query-nodes`, `get-node`, `describe-schema`, `update-node`, `rename-node`. Single chokepoint for envelope unwrap + error normalization.
- `schema.ts` — fetch + cache `describe-schema`, expose `widgetForField`, `filterableFields`, `claimedFields`. One fetch per type-lock change; never refetched mid-session.
- `render/header.ts` — title bar, refresh button, columns toggle
- `render/filter-strip.ts` — generic strip from the pilot, slimmed to query-shape primitives only (`title_contains`, `query`, `sort`, `limit`)
- `render/chip-strip.ts` — M2: schema-driven chips, one per filterable field on the locked type
- `render/table.ts` — header row + body rows orchestrator; column visibility from M1's defaults + user toggles
- `render/cell-read.ts` — per-widget read renderer (8 small functions, one per widget value)
- `render/cell-edit.ts` — per-widget editor (8 small functions, mirrored)
- `render/preview-pill.ts` — "would set X · ⚠ Y · ✓ Confirm / ✗ Cancel" pill rendered inside the edited cell
- `flows/edit.ts` — click-to-edit → editor → blur/Enter → dry_run → smart-confirm decision → commit-or-promote → row-patch
- `flows/refresh.ts` — full re-fetch, applied to current args
- `flows/expand.ts` — M4: parent → child via `get-node` `expand`; stub interface in M1
- `errors.ts` — STALE_NODE / `Issue.field` adapters; per-cell error attachment

Vite bundles all of these into a single self-contained HTML at build time. No external `<script src=...>`; the `@modelcontextprotocol/ext-apps` SDK is inlined.

### Engine-side surface (no changes — all already shipped)

- `query-nodes` — read tool; returns rows with `version` since Foundation #1
- `get-node` — read tool; supports `expand={types, direction?, max_nodes?}` for M4
- `describe-schema` — schema introspection; returns `ui` per claim since Foundation #2
- `describe-global-field` — fallback for fields not claimed by the locked type's schema
- `list-field-values` — autocomplete population for `tags` chips in M2
- `update-node` — single-node mode, with `expected_version` and `dry_run`
- `rename-node` — title cell only, with `expected_version`

## Type-lock resolution

v1 requires a single locked type. Resolution rules in order:

1. If `args.types` has exactly one value → lock to it.
2. Else if all result rows share a single `types[0]` → lock to it.
3. Else → render a "pick a type to enable the table" banner with a type-picker chip; bundle re-calls `query-nodes` with `types: [picked]` once the user selects. Until selection: a flat fallback list (the pilot's current rendering) is shown so the data isn't hidden.

The chip strip's first chip is always the type lock, swappable to widen/narrow the view. Changing the type lock invalidates the schema cache and triggers `describe-schema(new_type)` + `query-nodes` refetch.

## Data flow

### Mount

`app.connect()` → wait for `ontoolinput` (host pushes initial args) → **ignore the host-pre-pushed `ontoolresult`** (per always-fresh) → resolve type lock from args (rules above) → if a type is locked, fetch `describe-schema(type)`; else fetch `query-nodes(args)` first to derive the lock from result rows, then schema → cache schema → fetch `query-nodes(args)` → render.

One mount = one `describe-schema` + one `query-nodes` call (or two `query-nodes` calls in the type-derived case).

### Refresh button

Same as mount minus `connect`. Schema cache survives unless the type lock changes.

### Filter chip change

Chip click → update `args` → `query-nodes(args)` refetch → re-render. Schema unchanged. The generic strip's `title_contains`/`query`/`sort`/`limit` changes go through this same path.

### Type-lock change

User picks a different type via the type chip → invalidate schema cache → `describe-schema(new_type)` → reset chip-strip args (drop chips that don't apply to the new type) → `query-nodes(args)` → re-render. Column model swaps to the new type's fields.

### Cell edit — clean path

1. Click cell → swap to editor (per-widget).
2. User changes value → blur or Enter.
3. `update-node({ id, fields: { <field>: <new_value> }, expected_version: <row.version>, dry_run: true })`.
4. Smart-confirm decision (see below): if **clean** →
5. `update-node({ ...same..., dry_run: false })`.
6. Patch row in place from the response payload (new `version`, new `fields`). Green flash.

### Cell edit — promoted path

If the smart-confirm decision flags as notable → render preview pill in the cell with `would_apply` summary + warnings → user clicks **Confirm** → step 5+6. Cancel → discard editor state, restore read-mode cell.

### Cell edit — STALE_NODE

dry_run returns `{ ok: false, error: { code: "STALE_NODE", ... } }` (or the commit step does — both are guarded by `expected_version`) → render row-level "Reload row" affordance → user clicks → `get-node({ id })` → patch row in place with fresh state, discarding the user's pending edit. User re-edits if still desired.

### Title cell

Same flow, tool = `rename-node`. The `executeMutation` rollback queue handles wiki-link rewrites server-side; the iframe doesn't model them. STALE_NODE behavior identical.

### Post-commit filter consistency

After commit, **patch the row in place from the write response**. Don't auto-refetch even if the edited field is one we filter on. If the row no longer matches the filters, that's reconciled on the next manual Refresh. Predictable beats clever for v1.

### M4 expansion (sketched, not built in M1–M3)

Click row caret → `get-node({ id, expand: { types: [child_type], direction: 'incoming'|'outgoing', max_nodes: 25 } })` → render `expanded[child_id]` map as an inline sub-table using the same render path against the child type's schema (cached lazily on first expansion of that type). Read-only at first; editing composes from M3 once both surfaces are stable.

## Smart-confirm decision logic

The dry_run response from `update-node` (single-node mode) returns:

```ts
{
  ok: true,
  data: {
    dry_run: true,
    preview: {
      node_id, file_path, title, types,
      coerced_state: Record<string, { value, source: 'provided'|'defaulted'|'orphan', coercion_code? }>,
      fixable: ...,            // validation issues with auto-fix suggestions
      orphan_fields: string[], // fields not claimed by any of the node's types
    }
  },
  warnings: Issue[]
}
```

Or `{ ok: false, error: { code, message, details? }, warnings }` on any failure.

The shape determines whether the edit commits silently (green flash) or promotes to an explicit preview pill. **Promote on any of:**

- `ok: false` for any reason (validation error, `STALE_NODE`, `UNKNOWN_TYPE`, etc.)
- `ok: true` with `warnings.length > 0` (any warning code, e.g., `LAST_TYPE_REMOVAL`, `PENDING_REFERENCES`)
- `ok: true` with any `preview.coerced_state[field].source === 'defaulted'` (a default would be applied as a side effect)
- `ok: true` with any `preview.coerced_state[field].coercion_code` set (coercion happened, e.g., `STRING_TO_DATE_FUZZY`, `STRING_TO_NUMBER`)
- `ok: true` with `preview.orphan_fields.length > 0` for fields the user didn't already orphan
- `ok: true` with `preview.fixable` containing any auto-fixable issues
- `ok: true` with `preview.title` or `preview.types` differing from the row's current title/types when the edit was supposed to touch only a field (defensive — single-cell edit shouldn't change those)

**Otherwise → commit silently.** The unit tests in `flows/edit.test.ts` enumerate every shape and assert the decision; adding a new dry_run signal to the engine is the only way the decision tree changes.

For `rename-node` dry_run (title cell), promote on any `references` array that would be rewritten (the user is touching one cell but the engine will rewrite N other files) and on `STALE_NODE`. Otherwise commit silently.

## Filter chip widget mapping

A claim is **filterable** if its widget is anything other than `textarea`. Once a type is locked, one chip per filterable field on the locked type's claims, widget-shaped:

| Widget       | Chip widget                                                         | Underlying `query-nodes` filter                                |
| ------------ | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `text`       | "contains" text input                                               | `fields.<name>: { contains: ... }`                             |
| `textarea`   | (not filterable in chip strip — accessed via generic `query`)       | n/a                                                            |
| `enum`       | multi-select dropdown, options from `enum_values` on the claim       | `fields.<name>: { in: [...] }`                                 |
| `date`       | date-range picker (from / to, both optional)                        | `fields.<name>: { gte: ..., lte: ... }`                        |
| `number`     | min / max inputs                                                    | `fields.<name>: { gte: ..., lte: ... }`                        |
| `bool`       | tri-state (any / true / false)                                      | `fields.<name>: { eq: true|false }` or absent                  |
| `link`       | presence (is set / is not set) — autocomplete deferred to M5         | `fields.<name>: { is_set: true|false }`                        |
| `tags`       | multi-select w/ autocomplete from `list-field-values` (already shipped) | `fields.<name>: { contains_any: [...] }`                       |

Chips with empty/default state contribute nothing to `args.fields`. The type-lock chip is always present and always at index 0.

## Column visibility defaults

Once schema is cached, the bundle computes a default visibility per claim:

| Field shape                                                     | Default visibility |
| --------------------------------------------------------------- | ------------------ |
| `title` (synthetic — every node has one)                        | shown              |
| `types` (synthetic)                                             | shown              |
| `text` / `enum` / `date` / `number` / `bool` (any scalar widget) | shown              |
| `link` (single reference)                                       | shown              |
| `textarea`                                                      | hidden             |
| `tags` (list of `string` or `enum`)                             | hidden (overflows on density; user can toggle) |
| List of `reference`                                             | hidden             |
| Body (not a claim, but available via `get-node`)                | never shown        |

The "⚙ Columns" header button opens a checklist of every claimed field; user toggles override the defaults for the session. No persistence across sessions.

## Error handling

| Failure                                                       | Surface                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `query-nodes` returns `ok: false`                              | Banner in table area with `error.code · error.message`. Filters/state preserved. Retry button.           |
| `query-nodes` returns warnings                                 | Collapsible warnings panel above the table; user can dismiss for the session.                            |
| Cell edit dry_run validation error, `Issue.field` matches the cell | Inline error chip inside the cell, edit mode preserved so user can fix.                                  |
| Cell edit dry_run validation error, `Issue.field` unset / mismatch | Preview pill in the edited cell with the error message; explicit Cancel only.                            |
| Cell edit STALE_NODE                                          | Row-level "Reload row" affordance (re-`get-node` → patch).                                               |
| Network / transport failure                                   | Toast-style banner with retry; user state intact (editors, filters, scroll).                             |
| `describe-schema` fetch failure                               | Banner "couldn't fetch schema; column model degraded to generic." Table falls back to the pilot's flat row rendering. |
| Field present in a row but not claimed by the locked type's schema | Best-effort widget inference from value type; render read-only with a small "?" microcopy. No edit affordance. |

## Milestone slicing

Each milestone is independently shippable and self-demoing. Milestone PRs include their own manual checklist (modeled on the pilot's 5-item gate).

### M1 — Read-only schema-driven table

Single-type lock per the resolution rules. Fresh-on-mount. Widget-aware column rendering for all 8 widget values. Generic filter strip slimmed to query-shape primitives. `Issue.field` errors surface inline. Column-visibility defaults + "⚙ Columns" toggle. M2/M3/M4 stubs in place but not wired.

**Demo gate:** Calling `query-nodes` with `types: ['task']` renders a table with title + scalar field columns from the task schema, hides textarea/list-of-reference fields by default, and the columns toggle reveals them.

### M2 — Schema-driven filter chips

Chip strip per the widget-mapping table. Each chip's empty state contributes nothing; populated chips compose into `args.fields`. Type-lock chip is always present.

**Demo gate:** Filtering tasks by `status: open` and `due: this week` via chips updates the table with no model turn.

### M3 — Inline cell edit + smart confirm

Per-widget cell editor. dry_run-on-blur, smart-confirm decision per the table above. Title cell routes to `rename-node`; everything else to `update-node`. STALE_NODE retry banner. Per-cell error rendering pulled from `Issue.field`. Title-rename's wiki-link rewrites still go through `executeMutation`'s rollback queue server-side — no special handling here.

**Demo gate:** Click a `status` cell, pick a new enum value, see green flash → `query-sync-log` confirms the write went through `update-node`. Click a `title` cell, rename, see the file rename land on disk.

### M4 — Parent → child expansion

`get-node`'s `expand={types}` lets a `project` row open an inline sub-table of its `task` children. Read-only first; M3's edit composes once both are stable. Lazy-load child schema on first expansion of that child type.

**Demo gate:** Querying projects, expanding one shows its tasks in a sub-table. Each task row reads correctly per the task schema.

### M5 — Stretch

Reference autocomplete picker (replaces M2's presence-only filter). Bulk row-select + batch-edit (composes with `update-node` query mode). M4 sub-table editing. Anything else surfacing during M1–M4 implementation.

## Testing

- **Engine side: nothing new to test.** The server surface is fully unchanged. Run existing suites.
- **Bundle pure-logic units (vitest, DOM-free):**
  - `schema.ts` — widget inference table, every `field_type` × `list_item_type` combo
  - `flows/edit.ts` — smart-confirm decision logic, every dry_run shape that should commit vs. promote
  - `errors.ts` — envelope-to-message adaptation, every IssueCode of interest
  - `state.ts` — type-lock resolution, every rule path
- **Bundle DOM:** no automated tests. Manual per-milestone checklist following the pilot's 5-item posture; checklists land in the milestone PRs.
- **Build verification:** `npm run build` (including `build:ui`) must succeed; the bundled HTML must self-contain (no external `<script src=...>`); the bundle must register at `ui://vault-engine/query-nodes` with `_meta.ui.resourceUri` on the `query-nodes` tool.

## Risks

- **Smart-confirm could silently commit something the user wouldn't want.** Mitigated by a spec-pinned trigger list (above) and unit tests that assert the decision per shape. Adding a new dry_run signal to the engine is a spec amendment, not freelance.
- **Bundle source grows substantially.** Pilot is ~400 LOC; v1 trends toward ~2k LOC across 14 modules. Vite's single-file output handles it but bundle-size watching during the build is worth wiring up early.
- **Schema cache is per-iframe-session.** If a schema changes mid-session via the AI editor, the iframe will use stale hints until refresh. Acceptable per charter "defer until pain"; documented in the bundle.
- **Filter chip / column widget mismatch.** A widget hint might disagree with the underlying `field_type` (e.g., schema author sets `widget: 'date'` on a `string` field). Bundle trusts `widget` for rendering; engine validates the underlying value. Edit attempts that can't coerce surface as `Issue.field` errors → preview pill.
- **`tools/list` cache after registration changes.** Already documented in the pilot postmortem: clients cache `tools/list` and don't pick up new `_meta.ui` metadata until the connector is removed and re-added. This applies to v1 too if we change the tool description; mitigation is operational (refresh connector after deploy).

## Reversibility

If the v1 bundle turns out unwanted, removal is one commit per the pilot's reversibility note: drop `_meta.ui.resourceUri`, drop the `registerQueryNodesUi` call, delete `src/mcp/ui/query-nodes/`. The `query-nodes` tool returns to JSON-only.
