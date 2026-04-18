# Cross-Node Query — Design Spec

**Date:** 2026-04-17
**Status:** Approved
**Origin:** Vault note "Vault Engine — Cross-Node Query Charter"

## Summary

Add graph traversal to the structured `query-nodes` interface. Two new parameters — `join_filters` and `without_joins` — let callers constrain results by patterns on related nodes. Each join filter describes an edge (`rel_type`, `direction`) and a pattern for the node on the other side, expressed as a nested `NodeQueryFilter` (types, fields, title, path, references, etc.).

Single-hop only in this pass; the interface shape accommodates multi-hop as a future extension. The query builder is shared with `update-node` query mode, so bulk mutations inherit graph-aware filtering automatically.

A pre-work migration adds a `resolved_target_id` column to the `relationships` table, populated at relationship insert and kept fresh via targeted UPDATEs on node create / rename / delete. This avoids 5-tier resolver work during every query and makes incoming joins cheap.

## Problem

`query-nodes` can filter by a node's own properties and by whether it references a specific target, but cannot filter by the properties of a referenced node. Cross-node questions — "open tasks whose linked project is done" — force the caller into N+1 query decomposition: fetch candidates, fetch each reference target, filter client-side. This degrades agent workflows and pushes graph reasoning onto the caller.

## Non-goals

- **Multi-hop joins.** `join_filters` inside a `target` NodeQueryFilter. The recursive shape leaves a clean extension point; out of scope here.
- **Aggregation.** "Projects ranked by open-task count." Fundamentally a GROUP BY, not a filter. Different design conversation.
- **Read-only SQL escape hatch** (charter Approach A). Different access-control and safety envelope. Separate future spec.
- **Match-count attribution** in results. "This task has 3 done projects linked." Skipped in v1 to keep the result shape unchanged.

## Interface

Two new top-level parameters on `query-nodes` (and, inherited, on `update-node` query mode's `query` object):

```ts
join_filters?:   JoinFilter[]
without_joins?:  JoinFilter[]
```

Where `JoinFilter` is:

```ts
interface JoinFilter {
  direction?: 'outgoing' | 'incoming';   // default: 'outgoing'
  rel_type?:  string | string[];         // optional edge-type constraint; array = OR across types
  target?:    NodeQueryFilter;           // optional nested filter on the node on the other side
}
```

### Validation rules

- At least one of `rel_type` or `target` must be present. A filter with neither is rejected with `INVALID_PARAMS`.
- `target` is a `NodeQueryFilter` with every existing field **except** `join_filters` / `without_joins` (nested joins deferred). `references` **is** allowed inside `target` — it's identity-based, not recursive.
- `rel_type` accepts string or string[]; internally normalized to array. Match is exact-case (no `COLLATE NOCASE`), consistent with how `rel_type` is stored.

### Examples

**Open tasks whose linked project is done:**
```json
{
  "types": ["task"],
  "fields": { "status": { "eq": "open" } },
  "join_filters": [{
    "rel_type": "project",
    "target": {
      "types": ["project"],
      "fields": { "status": { "eq": "done" } }
    }
  }]
}
```

**Tasks linked to a done project via either `project` or `parent_project`:**
```json
{
  "types": ["task"],
  "join_filters": [{
    "rel_type": ["project", "parent_project"],
    "target": { "fields": { "status": { "eq": "done" } } }
  }]
}
```

**Meetings with any person at Acme — covers body wiki-links and field references:**
```json
{
  "types": ["meeting"],
  "join_filters": [{
    "target": {
      "types": ["person"],
      "fields": { "company": { "eq": "Acme" } }
    }
  }]
}
```

**Tasks with no done-project edge (negation):**
```json
{
  "types": ["task"],
  "without_joins": [{
    "rel_type": "project",
    "target": { "fields": { "status": { "eq": "done" } } }
  }]
}
```

**Incoming — projects with ≥1 open task linking to them:**
```json
{
  "types": ["project"],
  "join_filters": [{
    "direction": "incoming",
    "rel_type": "project",
    "target": {
      "types": ["task"],
      "fields": { "status": { "eq": "open" } }
    }
  }]
}
```

**Multiple independent filters (AND):**
```json
{
  "types": ["task"],
  "join_filters": [
    { "rel_type": "project",  "target": { "fields": { "status": { "eq": "done" } } } },
    { "rel_type": "assignee", "target": { "fields": { "role":   { "eq": "engineer" } } } }
  ]
}
```
Tasks with at least one done project **and** at least one engineer assignee. Two separate matched targets allowed.

**Two-step through identity-based reference (not multi-hop join):**
```json
{
  "types": ["task"],
  "join_filters": [{
    "rel_type": "project",
    "target": {
      "types": ["project"],
      "references": { "target": "Acme Corp", "direction": "outgoing" }
    }
  }]
}
```
`references` inside `target` is allowed — it's identity-based, so the recursion terminates.

### Result shape

No change to existing result fields. One addition: an optional `notice` field surfaces when unresolved edges were skipped in a way that could have affected results (i.e. `join_filters` or `without_joins` had a `target` constraint and at least one matching-candidate edge had `resolved_target_id IS NULL`).

```json
{
  "nodes": [ ... ],
  "total": 42,
  "notice": "Cross-node join filters applied. 3 candidate edges had unresolved targets and were excluded."
}
```

In `update-node` query-mode dry-run, the notice additionally flags bulk join use: `"Bulk mutation via cross-node join filters — review affected set carefully."`

`notice` is a soft human-readable hint. Agents should relay it to users, not parse it. Content is not a stability contract.

## Semantics

### Composition

- `join_filters: [F1, F2, ...]` compiles to one `EXISTS (...)` subquery per filter, AND'd together in the outer `WHERE`. Each filter is an independent existence check — matching edges need not be the same edge across filters.
- `without_joins: [F1, F2, ...]` compiles to one `NOT EXISTS (...)` per filter, AND'd.
- `rel_type` as array compiles to `IN (?, ?, ...)` within the subquery — OR semantics within the filter.

### Distinctness

Outer query stays `SELECT DISTINCT n.id`. A node with multiple matching edges appears once. No match-count attribution in v1.

### Direction-flipping

| `direction` | Outer edge predicate | `target` filters applied to |
|---|---|---|
| `outgoing` (default) | `r.source_id = n.id` | node at `r.resolved_target_id` |
| `incoming` | `r.resolved_target_id = n.id` | node at `r.source_id` |

`target` semantically always means "the node on the other side of the edge," regardless of direction.

### Unresolved edges

An edge with `resolved_target_id IS NULL` (target text doesn't match any node via the 5-tier resolver) is invisible to join filters:
- For `join_filters`: no target node to inspect, so the filter can't match.
- For `without_joins`: an unresolved edge does **not** count as "having such an edge." A node with only unresolved project edges satisfies `without_joins: [{rel_type:'project', target:{...}}]` if the target filter is present.

Callers who want edges to nonexistent targets use the existing text-based `references` filter.

### `rel_type` semantics

- Stored `rel_type` values are field names (`project`, `parent_project`, etc.) for frontmatter references, or the literal `'wiki-link'` for body-prose wiki-links.
- Omitting `rel_type` matches any edge, including body wiki-links.
- Setting `rel_type: 'wiki-link'` matches only body-prose edges.
- A specific field name like `rel_type: 'project'` matches only edges from that field.
- Empty `target: {}` with `rel_type` set means "has at least one resolved edge of this type" — a permissive wildcard, not an error.

### Composition with other top-level filters

`join_filters` and `without_joins` compose cleanly with every existing `NodeQueryFilter` clause: `types`, `without_types`, `fields`, `without_fields`, `references`, `title_eq`, `title_contains`, `path_prefix`, `without_path_prefix`, `path_dir`, `modified_since`. All applied as AND'd conditions on the outer `n`.

### SQL shape

For each outgoing join filter at alias scope `rN` / `tN`:

```sql
EXISTS (
  SELECT 1 FROM relationships rN
    INNER JOIN nodes tN ON tN.id = rN.resolved_target_id
    /* target's own JOINs (types, fields, etc.) at scope tN */
  WHERE rN.source_id = n.id
    AND rN.resolved_target_id IS NOT NULL
    AND rN.rel_type IN (?, ?, ...)  -- if rel_type present
    /* target's own WHEREs at scope tN */
)
```

Incoming flips `rN.source_id = n.id` → `rN.resolved_target_id = n.id`, and `INNER JOIN nodes tN ON tN.id = rN.source_id`.

`without_joins` wraps the same body in `NOT EXISTS (...)`.

Pagination and `countSql` get the same EXISTS clauses — pagination totals are correct.

## Data Model & Migration

### Schema change

```sql
ALTER TABLE relationships
  ADD COLUMN resolved_target_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_relationships_resolved_target_id
  ON relationships(resolved_target_id);

CREATE INDEX IF NOT EXISTS idx_relationships_source_resolved
  ON relationships(source_id, resolved_target_id);
```

- `ON DELETE SET NULL` — when a target node is deleted, relationship rows lose their resolution but survive. Raw `target` text preserved. Edge becomes invisible to join filters, still visible to text-based `references`.
- `idx_relationships_source_resolved` accelerates outgoing joins. `idx_relationships_resolved_target_id` accelerates incoming joins.
- Existing `idx_relationships_target` retained (used by `references` for text-based matching and by the refresh logic below).

### Indexer-time population

Modify `src/indexer/indexer.ts`'s `insertRelationship` path to run `resolveTarget(db, rel.target)` inline and populate `resolved_target_id` at insert. Cost: a handful of prepared-statement lookups per row; well within the indexer's existing budget.

### Lifecycle-event refresh

A new helper module `src/resolver/refresh.ts` exports `refreshOnCreate`, `refreshOnRename`, `refreshOnDelete`. Each is called from the corresponding node-mutation site.

**On node create** (new id, title, file_path):
For each candidate key derived from the new node (file_path, title, basename, case-folded basename, NFC-normalized basename):
```sql
UPDATE relationships
   SET resolved_target_id = :new_id
 WHERE resolved_target_id IS NULL
   AND /* tier-appropriate comparison on target */;
```
Case-insensitive comparison collapses tiers 4 and 5 most of the time. NFC normalization uses pre-normalized candidate keys generated in JS.

**On node rename** (old → new):
1. `UPDATE relationships SET resolved_target_id = NULL WHERE resolved_target_id = :old_id`
2. Walk the affected rows in JS, dedupe by `target` text, call `resolveTarget()` per unique string, `UPDATE` in a transaction. Dedup keeps cost bounded (if 40 rows share a target, one resolver call covers them all).
3. Run the **create** logic for the new title / file_path on any remaining NULL rows.

**On node delete** (id): `ON DELETE SET NULL` fires automatically via the FK clause. Skipped re-resolution in v1 — rows go NULL, next source re-index self-heals. Documented as a known limitation.

**On file-move-without-rename** (file_path changed, title unchanged): treated as rename internally.

### Mutation sites calling the refresh helpers

- `src/pipeline/execute.ts` — tool-initiated create, rename, delete
- `src/mcp/tools/batch-mutate.ts` — inherited via pipeline (verify)
- `src/sync/watcher.ts` — watcher create, rename, unlink
- `src/sync/reconciler.ts` — reconciler-driven creates/deletes during startup catchup

All already have single choke points for node-state change.

### Startup backfill

New `meta.resolved_targets_version` row (same pattern as `meta.search_version`). When `stored < current`, on startup:
1. Stream all `relationships` rows.
2. Batch-resolve unique `target` strings — dedupe, call `resolveTarget()` per unique string.
3. `UPDATE` in chunks of ~500 rows.
4. Bump stored version on completion.

At production scale (~30k relationships, ~5k unique targets), runs in a few seconds. Logged.

### Known limitations

- **Delete re-resolution skipped in v1.** When a previously-ambiguous target's winning node is deleted, the second-place candidate isn't automatically promoted. Rows go NULL and self-heal on next source re-index.
- **No superseding on new node create.** When a new node becomes a *better* match than what's currently stored for some existing relationship (title match superseding a basename match for the same raw text), the row isn't updated. Scanning non-NULL rows on every node create would be expensive; pragmatic skip.

Both limitations are rare in practice. Documented here, revisit if observed.

## Query Builder Changes

All work in `src/mcp/query-builder.ts`.

### Interface extensions

```ts
interface NodeQueryFilter {
  // ... existing fields ...
  join_filters?:  JoinFilter[];
  without_joins?: JoinFilter[];
}

interface JoinFilter {
  direction?: 'outgoing' | 'incoming';
  rel_type?:  string | string[];
  target?:    NodeQueryFilter;
}
```

### Refactor

Factor `buildNodeQuery`'s body into a helper:

```ts
buildFilterClauses(
  filter: NodeQueryFilter,
  alias: string,
  idx: { n: number },
  db?: Database.Database
): { joins: string[]; joinParams: unknown[]; whereClauses: string[]; whereParams: unknown[] }
```

The recursive path uses this helper at scope `tN` for each join filter's `target`.

New sibling:

```ts
buildJoinExistsClauses(
  filters: JoinFilter[] | undefined,
  parentAlias: string,
  idx: { n: number },
  db: Database.Database | undefined,
  negated: boolean
): { whereClauses: string[]; whereParams: unknown[] }
```

Produces one `EXISTS (...)` (or `NOT EXISTS (...)`) clause per filter. Each clause is fully parameterized. The `idx` counter is passed by reference so recursive calls don't collide on alias names.

No `db` needed for join-filter compilation itself — the migration means `resolved_target_id` is pre-stored, no query-time resolver. `db` is still required for the top-level `references` incoming path (resolves the target text once before query).

### `references` internal simplification

Incoming `references` currently runs `resolveTarget()` + IN-list match at query time. Post-migration, it resolves once and joins on `resolved_target_id`:

```sql
INNER JOIN relationships rN
  ON rN.source_id = n.id
 AND rN.resolved_target_id = ?   -- pre-resolved in JS before query
```

External behavior unchanged. Outgoing `references` unchanged too (already fast).

### Alias discipline

Aliases are deterministic and collision-free under nesting: `n` (outer), `t0`, `t1` (target nodes), `r0`, `r1` (relationship joins), `f0`, `f1` (field joins at outer scope), with nested scopes getting their own prefixes. Param order follows SQL placeholder order: all JOIN params first, then all WHERE params, recursively.

## Bulk Mutation Inheritance

`update-node` query mode already passes its `query` object into `buildNodeQuery`. Two handler-side changes:

1. Extend the zod schema for `query` to accept `join_filters` / `without_joins`.
2. When either is present in the query, include `"notice": "Bulk mutation via cross-node join filters — review affected set carefully."` in the dry-run preview response.

Everything else — dry-run default, best-effort execution, batch guard, `sync_log` / `edits_log` audit — already applies unchanged.

## `references` Filter — External Behavior

Unchanged. `references` remains the identity-based edge filter ("does this node link to **this specific target**?"), `join_filters` is the pattern-based filter ("does this node link to **any node matching this pattern**?"). They coexist; they solve different problems.

Tool descriptions will document the distinction with short examples.

## Testing

### Unit: query builder (`tests/mcp/query-builder.test.ts`, extend)

- Single outgoing `join_filter` with `rel_type` only — EXISTS emitted, no target JOIN.
- `join_filter` with nested `target.types` / `target.fields` / `target.title_eq` / `target.path_prefix` / `target.without_types` / `target.without_fields` / `target.modified_since` / `target.references` — each variant produces correct SQL.
- `rel_type` as string compiles to `= ?`; as array compiles to `IN (?, ?, ...)`.
- `direction: 'incoming'` flips `source_id` / `resolved_target_id`.
- Multiple `join_filters` — N independent EXISTS clauses, AND'd.
- `without_joins` — NOT EXISTS.
- Mixed top-level `fields` / `types` / `references` with `join_filters` — all compose correctly.
- Validation: `JoinFilter` with neither `rel_type` nor `target` rejected.
- Alias uniqueness under nesting (outer `f0` / `t0` vs. inner target's `f0` / `t0` don't collide).
- Parameter ordering matches SQL placeholder order across nested clauses.

### Integration: end-to-end (`tests/integration/cross-node-query.test.ts`, new)

Fixture vault with tasks, projects, people, companies, known cross-links.
- Tier-1 query: open tasks whose project is done. Exact result set asserted.
- `without_joins` variant: tasks with no done-project edge.
- `direction: 'incoming'`: projects with ≥1 open task.
- No-`rel_type` shorthand: meetings linked to any person at Acme, covering field-ref and body-wiki-link edges.
- Unresolved-edge handling: rows with `resolved_target_id IS NULL` invisible to both `join_filters` and `without_joins`; `notice` field surfaces when applicable.
- Pagination / total count correctness with `join_filters` present.
- `references` filter regression (still works, now via `resolved_target_id` internally).
- Composition: top-level `fields` + `join_filters` + `without_joins` + `references` in one query.

### Integration: resolution maintenance (`tests/integration/resolved-target-maintenance.test.ts`, new)

- Startup backfill: pre-migration DB gets `resolved_target_id` populated on first open, version bumped, no duplicate work on second open.
- `create-node`: previously-unresolved edges pointing at the new node resolve.
- `rename-node`: edges to old name re-resolve correctly. Edges to new name become resolved.
- `delete-node`: `ON DELETE SET NULL` fires; rows not orphaned.
- Watcher create / rename / unlink parity via the watcher path.
- `batch-mutate` mixed delete+create leaves resolution consistent.
- Indexer inserts fresh edges with correct resolution.
- False-resolution regression: edges whose `target` doesn't match any resolver tier stay NULL.

### Integration: bulk mutation (`tests/integration/bulk-mutate-join-filters.test.ts`, new)

- `update-node` query-mode dry-run with `join_filters` — affected set correct, `notice` present.
- Same call `dry_run: false` — mutation applied to exactly the previewed set, `edits_log` populated.
- `without_joins` in query mode — correct affected set, correct notice.
- Best-effort behavior preserved: partial failures per node, no rollback, complete audit trail.

### Smoke: live MCP against production vault

- Tier-1 charter query, sanity-check result count against manual spot check.
- `without_joins` query.
- One bulk `update-node` dry-run with `join_filters`, verify notice and affected set.

## Phasing & Delivery

### Block 1 — `resolved_target_id` infrastructure (pre-work)

Ships: column, indexes, indexer-time population, lifecycle-event refresh, startup backfill. No external API change. Internal simplification of `references` incoming.

Modules touched:
- `src/db/schema.ts`, `src/db/migrate.ts` — column + indexes + `meta.resolved_targets_version` scaffolding.
- `src/resolver/refresh.ts` — new module.
- `src/indexer/indexer.ts` — inline resolve during `insertRelationship`.
- `src/pipeline/execute.ts`, `src/sync/watcher.ts`, `src/sync/reconciler.ts`, `src/mcp/tools/batch-mutate.ts` — wire refresh helpers.
- `src/mcp/query-builder.ts` — internal `references` incoming simplification.
- `tests/integration/resolved-target-maintenance.test.ts` — new file.

Self-contained value: cleans up the resolver dance and prepares the ground. Additive, no rollback risk.

### Block 2 — `join_filters` + `without_joins` on `query-nodes`

Ships: outgoing *and* incoming join filters with nested-target shape on `query-nodes`. Phase A and Phase B bundled — shipping them separately would mean landing and reverting half the query builder twice.

Modules touched:
- `src/mcp/query-builder.ts` — `buildFilterClauses` refactor + `buildJoinExistsClauses`.
- `src/mcp/tools/query-nodes.ts` — zod schema + tool description.
- `tests/mcp/query-builder.test.ts` — extend.
- `tests/integration/cross-node-query.test.ts` — new file.

### Block 3 — `update-node` query-mode inheritance

Ships: `join_filters` / `without_joins` accepted in query mode; dry-run notice.

Modules touched:
- `src/mcp/tools/update-node.ts` — zod schema + notice logic + tool description.
- `tests/integration/bulk-mutate-join-filters.test.ts` — new file.

### Dependency order

`Block 1 → Block 2 → Block 3`, strict. Block 2 requires `resolved_target_id`. Block 3 requires Block 2's builder.

No rollback path needed — all changes additive. If Block 2 surfaces a performance problem, `join_filters` can be disabled in the zod schema as a hotfix while leaving the column in place.

## Open Questions (Deferred)

1. **Multi-hop joins** — allowing `join_filters` inside `target`. Interface already accommodates; cap is depth-1 in this pass. Uncap when use case lands.
2. **Aggregation queries** — separate design conversation.
3. **SQL escape hatch** — separate future spec.
4. **Match-count attribution** — easy to add if agent workflows need it.
5. **Re-resolution on delete / on superseding-match create** — documented v1 limitations, may revisit.
