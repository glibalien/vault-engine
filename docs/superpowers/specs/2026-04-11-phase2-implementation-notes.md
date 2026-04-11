# Phase 2 Implementation Notes

Judgment calls made during implementation that the spec didn't explicitly prescribe. These are places where the implementation had to pick something. Knowing what was picked helps Phase 3 CC understand the code without reading every function.

---

## 1. infer-field-type confidence formula

**Spec says:** Thresholds >0.95, 0.7-0.95, <0.7. No formula.

**Implementation:** `confidence = dominantCount / totalRows`. Simple ratio of the most-common type column to total rows.

**Enum heuristic:** When the dominant type is 'string', auto-proposes 'enum' if: >=5 total instances AND <=10 distinct values AND distinct/total ratio < 0.3. This threshold is a judgment call.

**Dissenter cap:** Limited to 10 dissenters per non-dominant type for response size.

## 2. field_coverage SQL

**Spec says:** "Count nodes of this type that have a value for this field."

**Implementation:** `SELECT COUNT(*) FROM node_fields nf JOIN node_types nt ON nt.node_id = nf.node_id AND nt.schema_type = ? WHERE nf.field_name = ?`. Returns `{have_value, total}` where total = node_count.

## 3. update-global-field confirm:true without prior preview

**Spec says:** Two-step flow (preview then confirm).

**Implementation:** `confirm: true` works standalone — gathers coercible/uncoercible in-line and applies in one call. The two-step flow is a UX recommendation, not an API enforcement. The implementation doesn't require a prior preview call. This reduces round-trips when the agent is confident.

## 4. renameGlobalField FK handling

**Schema_field_claims has FK to global_fields(name) without ON UPDATE CASCADE.** SQLite doesn't support updating a PK that has outstanding FK references. The implementation uses: insert new row → update FKs → delete old row, all in one transaction.

## 5. validate-node data loading (node_id mode)

Loads fields from node_fields and reconstructs `Record<string, unknown>` by checking typed columns in priority order: `value_json` (parsed) > `value_number` > `value_date` > `value_text`. Same priority as the indexer's field classification.

## 6. Single-value-to-list coercion is more permissive than spec

**Spec says:** "For string values and a list<string> field: wrap. For other types: reject."

**Implementation:** Attempts to coerce any single value to the list's item type. If coercion succeeds, wraps as single-element array. This means `42 → list<number>` wraps as `[42]` (spec would reject).

**Rationale:** The generalization is consistent with the coercion philosophy — if the engine can unambiguously transform the value, it should. The spec's restriction to string+list<string> was conservative. The implementation is more permissive but never ambiguous. This was noted as a beneficial deviation during spec review and left in place.

## 7. describe-global-field orphan_count SQL

```sql
SELECT COUNT(DISTINCT nf.node_id) FROM node_fields nf
WHERE nf.field_name = ?
AND NOT EXISTS (
  SELECT 1 FROM node_types nt
  JOIN schema_field_claims sfc ON sfc.schema_name = nt.schema_type AND sfc.field = nf.field_name
  WHERE nt.node_id = nf.node_id
)
```

Counts nodes that have the field but where NONE of their types has a schema claiming it.

## 8. Conformance query count

`getNodeConformance` uses prepared statements in loops: 1 query per type (schema existence), 1 per type with schema (claims), 1 (node fields), 1 per unfilled claim (required lookup). For a node with 2 types (1 with schema, 1 claim, 0 unfilled): ~4 prepared-statement executions. All indexed. The query-count discipline test verifies this stays bounded (not proportional to vault size) by seeding 100 extra nodes and asserting <=10 total queries.

## 9. EffectiveFieldSet serialization in validate-node response

The `EffectiveFieldSet` is a `Map<string, EffectiveField>`. MCP tools return JSON via `toolResult()`. The validate-node handler converts the Map to a plain object using `Object.fromEntries()` before serialization. The `global_field` nested object inside each EffectiveField is already a plain object (GlobalFieldDefinition interface).

## 10. Application-layer invariant validation

Multi-column invariants (enum needs enum_values, list needs list_item_type, no nested lists) are enforced at:
- **createGlobalField:** validated before INSERT
- **updateGlobalField (non-type-change):** validated against effective state after applying proposed changes, before UPDATE (fixed post-implementation — the initial version only validated at creation)
- **updateGlobalField (type-change):** implicit — the new field_type is validated as part of the coercion preview

Not enforced by DB CHECK constraints (SQLite limitation noted in spec).
