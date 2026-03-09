# Schema Introspection MCP Tools — Design

Phase 2, Task 5. Three new tools added to the MCP server: `list-schemas`, `describe-schema`, `validate-node`.

## Context

The schema system (loader, merger, validator) is complete. These tools are thin wrappers exposing that functionality to agents via MCP.

Distinct from existing `list-types` which shows types nodes actually have (from indexed data). `list-schemas` shows what's defined in YAML — these can diverge.

## Tools

### `list-schemas`

**Params:** none.

**Behavior:** Calls `getAllSchemas(db)` and returns a summary array. Keeps response lean — agent uses `describe-schema` to drill into details.

**Response shape:**
```json
[
  {
    "name": "task",
    "display_name": "Task",
    "icon": "📋",
    "extends": null,
    "ancestors": [],
    "field_count": 5
  }
]
```

### `describe-schema`

**Params:** `{ schema_name: string }` (required).

**Behavior:** Calls `getSchema(db, name)`. Returns the full `ResolvedSchema` with inherited fields merged. Returns error if schema not found.

**Response shape:** The full `ResolvedSchema` object as JSON.

### `validate-node`

**Params:** Two modes, at least one of `node_id` or (`types` + `fields`) required.

- `node_id?: string` — Validate an existing indexed node.
- `types?: string[]` — Schema types for hypothetical validation.
- `fields?: Record<string, unknown>` — Field values for hypothetical validation.

**Behavior:**

*By node_id:* Loads the node's types from `node_types` table and fields from `fields` table. Runs `mergeSchemaFields(db, types)` then `validateNode(parsedFile, mergeResult)`.

*Hypothetical:* Takes `types` and `fields` directly. Constructs a minimal `ParsedFile`-shaped object from the provided data (mapping `Record<string, unknown>` entries to `FieldEntry[]` with inferred types). Runs the same merge + validate pipeline.

**Response shape:**
```json
{
  "valid": true,
  "warnings": [
    { "field": "status", "rule": "invalid_enum", "message": "..." }
  ]
}
```

**Error cases:**
- Neither `node_id` nor `types` provided → error.
- `node_id` not found → error.
- Node has no types with schemas → `{ valid: true, warnings: [] }` (nothing to validate against).

## Implementation Notes

- All three tools register in `src/mcp/server.ts` alongside existing tools.
- `validateNode()` takes `ParsedFile` which has `fields: FieldEntry[]`. For the hypothetical path, construct `FieldEntry[]` from the provided `Record<string, unknown>` by inferring `valueType` from JS runtime type (string, number, boolean, Date, array → list).
- For the node_id path, reconstruct `FieldEntry[]` from `fields` table rows. The DB stores `value_type` alongside `value_text`, so we can map DB `value_type` back to `FieldValueType` and use the appropriate column (`value_text`, `value_number`, `value_date`) for the value.
- Both paths feed into the same `mergeSchemaFields` → `validateNode` pipeline.
