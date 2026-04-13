# `include_fields` for `query-nodes`

## Problem

The `query-nodes` tool returns node summaries (id, title, types, field_count) but never includes field values in results. To answer a question like "open tasks broken out by project," a caller must:

1. `query-nodes` with `status = open` to get node IDs (1 call)
2. `get-node` on each result to read the `project` field (N calls)
3. Group client-side

This turns a single aggregation question into 45+ tool calls. The N+1 problem is the primary barrier to AI agents answering field-based queries efficiently.

## Origin

ChatGPT was asked "how many open tasks do I have right now, broken out by project?" and struggled through many tool calls with unreliable results. The filtering itself works correctly (object-shaped filter syntax `{eq: "open"}` returns accurate results), but the inability to read field values from query results forced a multi-step workaround that degraded the experience. See vault note "Vault Engine Issue Answering Task Query" for ChatGPT's report.

## Design

### New parameter

```
include_fields: string[]   // optional, e.g. ["project", "status"] or ["*"]
```

- When omitted or empty: behavior unchanged, results have `field_count` only (backwards compatible)
- When provided: each result node gets a `fields` object with resolved values
- `["*"]` is a wildcard that returns all fields for each matched node

### Response shape change

When `include_fields` is omitted (unchanged):

```json
{
  "id": "...",
  "file_path": "...",
  "title": "...",
  "types": ["task"],
  "field_count": 8
}
```

When `include_fields` is provided:

```json
{
  "id": "...",
  "file_path": "...",
  "title": "...",
  "types": ["task"],
  "field_count": 8,
  "fields": {
    "project": ["Cora Citizenship"],
    "status": "open"
  }
}
```

Key behaviors:

- `field_count` always reflects total fields on the node, not just the requested ones
- `fields` only contains fields that exist on the node. If a requested field is absent from the node, the key is omitted (not null)
- Values are flat (just the resolved value), not wrapped in `{value, type, source}` like `get-node`. The full metadata is available via `get-node` when needed. This keeps the response compact for bulk queries.
- Value resolution: `value_json` (JSON-parsed) > `value_number` > `value_date` > `value_text`, same priority as `get-node`

### Implementation

Single primary change site: `src/mcp/tools/query-nodes.ts`.

1. **Add parameter**: `include_fields` to `paramsShape` as `z.array(z.string()).optional()`

2. **Enrich results**: In the existing enrichment loop (lines 68-74), when `include_fields` is provided:
   - Prepare a statement: `SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?`
   - If specific fields (not wildcard): append `AND field_name IN (?, ?, ...)`
   - For each result row, resolve values and attach as `fields: Record<string, unknown>`

3. **Extract shared helper**: Move value resolution logic into a shared function (`resolveFieldValue`) so `get-node` and `query-nodes` use the same code path and don't drift. Likely in a shared location like `src/mcp/field-value.ts` or similar.

4. **Update tool description**: Mention `include_fields` in the tool's description string so AI agents discover it.

### No changes to query-builder.ts

This is a response enrichment, not a filter change. The query builder constructs the WHERE/JOIN for filtering; `include_fields` controls what data is returned for already-matched nodes.

### Performance

One prepared statement per result row — same pattern as the existing `getTypes` and `getFieldCount` queries at lines 65-66. For 200 rows with wildcard, that's 200 simple indexed lookups on `node_id`. SQLite handles this trivially.

### Deferred: aggregation tool

A dedicated `aggregate-nodes` tool (GROUP BY with counts) was considered and deferred. Once `include_fields` is available, AI agents can group client-side from a single query response. Aggregation may be revisited if the pattern proves insufficient.

## Example usage

"Open tasks by project" becomes one call:

```
query-nodes({
  types: ["task"],
  fields: { status: { eq: "open" } },
  include_fields: ["project"],
  limit: 200
})
```

Returns all 42 open tasks with their project field inline. The AI groups the results and reports the breakdown.
