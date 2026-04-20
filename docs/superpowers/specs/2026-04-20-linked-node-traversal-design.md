# Linked Node Traversal — Design Spec

**Date:** 2026-04-20
**Status:** Design approved, pending implementation plan
**Supersedes:** `Notes/Vault Engine - Linked Node Traversal Design.md` (vault note, early-thinking draft exploring Shapes A–D)

---

## Problem

`get-node` returns one node's body plus a flat list of relationships. Each relationship carries a `context` snippet — the literal markdown surrounding the link in the source body. For prose-heavy nodes, this snippet is usually enough. For bullet-list-heavy nodes (daily notes, index notes), `context` degenerates to bare `[[Link Name]]` and is useless.

Answering "summarize my week from daily notes" requires N+1 round-trips: one call for the daily note, then one per linked item to read its body. For heavily-linked hub nodes (daily notes linking 15–30 meetings, specs, projects), this is the dominant latency cost. It also forces a judgment call on every link: is the bare title enough, or do I pay the round-trip?

## Design Principles

- **Budget, not depth.** The real constraint is "enough neighborhood context without blowing my context window," not "follow N hops." Expose `max_nodes` as the primary lever.
- **Caller declares intent.** The tool does not guess which links matter. The caller names the types to follow; the tool follows them.
- **Most-recently-modified first.** When truncating, favor recent content. This is the primary sort key.
- **Non-breaking extension.** `get-node` without `expand` behaves exactly as today. Adding `expand` is additive.
- **No recursion.** v1 is one-hop only. Targets' relationships are not traversed.

## Scope

**In scope:**
- `get-node` gains an optional `expand` parameter.
- Expansion follows outgoing, incoming, or both directions from the root.
- Type-filtered, mtime-sorted, count-capped.

**Out of scope for v1:**
- Multi-hop traversal (depth > 1). Adding `depth` later is non-breaking.
- Body truncation / token budgets. Adding `body_mode` or `max_tokens` later is non-breaking.
- A dedicated `expand-subgraph` tool (Shape D from the draft). Revisit if `get-node.expand` proves insufficient.
- Embeds resolved recursively for expanded nodes — too expensive.

---

## Tool Surface

Add an optional `expand` object to `get-node`'s params:

```ts
expand: {
  types: string[];                                      // required when expand is present, non-empty
  direction?: "outgoing" | "incoming" | "both";         // default "outgoing"
  max_nodes?: number;                                   // default 10, min 1, max 25
}
```

**Validation:**
- `expand.types` is a non-empty array when present — `INVALID_PARAMS` otherwise.
- `expand.max_nodes`: integer in `[1, 25]` — `INVALID_PARAMS` otherwise.
- `expand` omitted entirely → behavior is identical to current `get-node`. No new fields in response.

---

## Traversal Algorithm

1. **Resolve root** via existing `get-node` path (`node_id`, `file_path`, or `title`). No change.
2. **Build candidate set** by walking the root's relationships:
   - If `direction` includes `outgoing`: every resolved `target_id` on outgoing relationships.
   - If `direction` includes `incoming`: every `source_id` on incoming relationships.
   - Skip unresolved outgoing targets (link text with no matching node).
   - Exclude the root itself.
   - Dedupe by node_id across rel_types — a node reached via multiple rel_types counts once.
3. **Filter by type.** For each candidate, load its `node_types`. Keep candidates with a non-empty intersection with `expand.types`.
4. **Sort by `file_mtime DESC`, then `id ASC` as deterministic tie-breaker.** Null `file_mtime` sorts last.
5. **Truncate to `max_nodes`.** Track `considered` (post-filter, pre-truncate count) and `returned` (post-truncate count).
6. **Fetch payload** for each surviving node: `{id, title, types, fields, body}`. Reuse the field-resolution logic from `get-node` for `fields`. No embeds, no relationships, no conformance.
7. **Build response.** Attach `expanded` (map keyed by node_id) and `expand_stats` to the envelope data.

**Query shape** (two extra queries on top of current `get-node`):

```sql
-- Candidate set with type match + mtime sort, driven by an IN clause built from step 2
SELECT n.id, n.title, n.file_path, n.body, n.file_mtime
FROM nodes n
WHERE n.id IN (?, ?, ...)
  AND EXISTS (
    SELECT 1 FROM node_types t
    WHERE t.node_id = n.id AND t.schema_type IN (?, ?, ...)
  )
ORDER BY n.file_mtime DESC NULLS LAST, n.id ASC
LIMIT ?;

-- Fields for the surviving nodes
SELECT * FROM node_fields WHERE node_id IN (?, ?, ...);
```

Types per surviving node can be fetched in the same round or loaded from an already-grouped map.

---

## Return Shape

Only new fields shown; the rest of `get-node`'s payload is unchanged.

```jsonc
{
  // ...existing get-node fields...

  "expanded": {
    "<node_id>": {
      "id": "...",
      "title": "...",
      "types": ["meeting"],
      "fields": { "date": {...}, "status": {...} },
      "body": "..."
    }
    // ...
  },

  "expand_stats": {
    "returned": 10,
    "considered": 17,
    "truncated": true
  }
}
```

- `expanded` and `expand_stats` appear only when `expand` is passed.
- Empty filter match → `expanded: {}`, `expand_stats: {returned: 0, considered: 0, truncated: false}`.
- `truncated` is `true` iff `considered > returned`.
- Field shape inside `expanded[id].fields` mirrors the root `fields` shape: `{ value, type, source }`.

---

## Error Handling and Edge Cases

| Case | Behavior |
|---|---|
| `expand.types` empty array | `INVALID_PARAMS` |
| `expand.max_nodes < 1` or `> 25` | `INVALID_PARAMS` |
| `expand.direction` outside enum | `INVALID_PARAMS` |
| Root has zero relationships | `expanded: {}`, stats zeroed |
| No candidates match the type filter | `expanded: {}`, stats zeroed |
| Outgoing link unresolved (no target node) | Silently skipped; not counted in `considered` |
| Candidate node has `file_mtime = NULL` | Sorted last; ties broken by `id ASC` |
| Self-reference (root links to itself) | Excluded from candidate set |
| Same target reached via multiple rel_types | Counted once |

---

## Testing

**Unit (pure traversal logic):**
- Outgoing-only produces the expected candidate set for a known fixture.
- Incoming-only produces the expected backlink set.
- `direction: "both"` unions and dedupes correctly.
- Type filter drops non-matching candidates.
- Dedupe by node_id across rel_types works.
- mtime-desc sort honored; nulls last.
- `max_nodes` truncation gives the top-N by mtime.
- Self-reference excluded.

**Integration (end-to-end via MCP):**
- `get-node` without `expand` — response is byte-identical to today (guard test).
- `get-node` with `expand` on a daily-note fixture — `expanded` contains the expected set, bodies match what `get-node` returns for each individually.
- `expand` with `direction: "incoming"` on a project-note fixture — `expanded` contains backlink sources.
- Truncation case: root with > `max_nodes` matching candidates → `truncated: true`, `considered > returned`.
- Empty-match case: `expanded: {}`, stats zeroed, no error.

**Edge:**
- `expand.types: []` → `INVALID_PARAMS`.
- `expand.max_nodes: 26` → `INVALID_PARAMS`.
- Root with no relationships → expansion succeeds, empty.
- Link to non-existent node — silently excluded, no warning noise.

---

## Open Questions for Future Revisions

Not blocking v1; logged for later.

- **Body truncation / token budget.** If `max_nodes: 10` pulls one 10k-token spec plus nine short meetings, the caller's budget is blown. A later `body_mode: "full" | "head"` or `max_tokens` budget is a non-breaking addition.
- **Multi-hop.** If callers keep asking for "the project's meetings' tasks," revisit. Add `depth` with a small cap (2) only if the use case proves out.
- **Rel_type filter.** Shape B from the draft. Skip unless Shape A proves insufficient.
- **Naming collision.** The `context` field inside `relationships` shares a word with the user-facing `context` task field (`personal`/`work`). Consider renaming to `snippet` or `surrounding_text` in a future tool revision.

---

## Related

- Shape A is the choice; Shapes B/C/D from the vault draft are documented there and summarized above under "Open Questions."
- `src/mcp/tools/get-node.ts` is the single file where expansion lives; traversal helpers likely extract to `src/mcp/expand-traversal.ts` if they grow beyond ~50 lines.
