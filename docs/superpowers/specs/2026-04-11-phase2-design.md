# Phase 2 Design — Schema System and Field Pool

**Date:** 2026-04-11
**Status:** Approved
**Charter reference:** ~/Documents/archbrain/Notes/Vault Engine - Charter.md
**Phase 1 spec:** docs/superpowers/specs/2026-04-10-phase1-design.md

## How to use this spec

Every implementation question should be checked against the principles in Section 1 before proceeding. If a principle and a later section conflict, the principle wins and the section is wrong. This is the same rule the charter applies to itself: principles are foundational, everything else is downstream.

## Overview

Phase 2 delivers a validated schema system and global field pool. The engine can define field shapes, create type definitions with field claims, validate nodes against schemas, and report conformance — all without writing back to files. Schemas and global fields live in the DB only; rendering to disk is Phase 3.

At the end of Phase 2: the engine knows about schemas and fields but still doesn't write back. It can report validation results without taking action.

---

## Section 1: Operational Principles

Three rules that govern every Phase 2 design decision:

**1. The indexer mirrors, the validation engine judges, and in Phase 2 nothing acts on the judgment yet — Phase 3 is where judgment becomes action.** The indexer's job is storing raw parsed file state. The validation engine is a pure function that produces reports. The indexer does not consult `global_fields` or `schemas`. It writes whatever the parser found. The global field pool is a separate concept that the validation engine consults; the indexer doesn't care whether a field name exists in the pool.

**2. Derived facts about schema conformance are computed at query time, never materialized.** Claimed/orphan classification, drift detection, enum membership, field coverage — all are joins or computations over current DB state. No stored columns, no re-indexing on schema change. Adding a schema immediately changes what counts as orphan with zero propagation work. This principle appears in: Section 2 (delete-global-field is metadata-only), Section 3 (delete-schema leaves node_types intact), Section 4 (orphan classification is a join), Section 5 (drift detection is validate-node's job), Section 6 (get-node conformance is cheap joins).

**3. The global field pool is source of truth for field shape; types claim fields and may layer presentation metadata, but cannot redefine semantics without explicit permission (via `per_type_overrides_allowed` on the global field).** Same pattern as "DB is source of truth, files are rendered views" — one canonical definition, layered views on top, conflicts between views are errors not negotiations.

**Corollary: read-path boundary rule.** `get-node` and `describe-schema` answer structural questions via joins on existing DB state (always-on, free). `validate-node` answers value-level questions by running the validation engine (opt-in, judgment). Structural questions show what exists; value-level questions evaluate whether what exists is valid. Facts about field definitions (like `required`) are structural; judgments about field values (like "this value doesn't match the enum") are validation.

---

## Section 2: Global Field Pool

*Governed by Principle 3: the global field pool is source of truth for field shape.*

### Data model

The `global_fields` table exists from Phase 1 (empty). Phase 2 adds three columns:

```sql
ALTER TABLE global_fields ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN list_item_type TEXT;
```

**Convention:** SQLite booleans are `INTEGER 0/1`. The TypeScript layer exposes them as real `boolean` values. `0 = false`, `1 = true`.

Full column set after Phase 2:

| Column | Type | Notes |
|--------|------|-------|
| name | TEXT PK | field name |
| field_type | TEXT NOT NULL | string, number, date, boolean, reference, enum, list |
| enum_values | TEXT | JSON array, nullable |
| reference_target | TEXT | nullable |
| description | TEXT | nullable |
| default_value | TEXT | JSON, nullable |
| required | INTEGER NOT NULL DEFAULT 0 | 0=false, 1=true |
| per_type_overrides_allowed | INTEGER NOT NULL DEFAULT 0 | 0=false, 1=true |
| list_item_type | TEXT | only when field_type='list'; may be any field_type except list (no nested lists) |

**Interpretation rule for list fields:** `reference_target` and `enum_values` describe the element type when `field_type = 'list'`, and the field type otherwise. A `list<reference>` field has `field_type = 'list'`, `list_item_type = 'reference'`, and `reference_target` set to the target type. A `list<enum>` field has `field_type = 'list'`, `list_item_type = 'enum'`, and `enum_values` set to the declared values.

**All multi-column invariants are enforced at the application layer**, not by DB constraints. SQLite's CHECK constraint support is limited and we don't rely on it. The invariants:
- `list_item_type` non-null only when `field_type = 'list'`
- `list_item_type` may not be `'list'` (no nested lists)
- `enum_values` non-null only when `field_type = 'enum'` or (`field_type = 'list'` and `list_item_type = 'enum'`)
- `reference_target` meaningful only when `field_type = 'reference'` or (`field_type = 'list'` and `list_item_type = 'reference'`)

### MCP tools

**`create-global-field`** — Parameters: `name`, `field_type`, plus optional `enum_values`, `reference_target`, `description`, `default_value`, `required`, `list_item_type`, `per_type_overrides_allowed`. Validates: name uniqueness, `enum_values` required when type is enum, `list_item_type` required when type is list, invariants above. Returns the created field.

**`update-global-field`** — Parameters: `name` (identifies field), plus any subset of mutable properties.

Changing `field_type` is a potentially destructive operation. Two-step flow:

- **Without `confirm: true`:** returns a preview with no DB changes:
  ```typescript
  {
    preview: true;
    affected_nodes: number;
    coercible: Array<{node_id: string, old_value: any, new_value: any}>;
    uncoercible: Array<{node_id: string, value: any, reason: string}>;
    would_orphan: number;  // count of uncoercible nodes whose values become orphans
  }
  ```
- **With `confirm: true`:** applies the change. Coercible values are coerced in `node_fields`. Uncoercible values are preserved as orphans — the field on those nodes becomes detached from the global field's new type. Returns the same structure with `preview: false, applied: true`.

Uncoercible values become orphans rather than failing the whole transaction. The charter says "data is never silently deleted," and refusing to commit because of a few uncoercible values would force the user to manually fix every dissenter before the migration could proceed.

**`rename-global-field`** — Parameters: `old_name`, `new_name`. Atomic single transaction: updates `global_fields.name`, every `node_fields.field_name` row, and every `schema_field_claims.field` row. Returns count of affected nodes and schemas.

**No aliasing in Phase 2.** The charter mentions aliases as a reconciliation feature; that's Phase 5. Rename is immediate and callers using the old name will get errors. Stated explicitly as a deferral.

**`delete-global-field`** — Parameters: `name`. **Metadata-only operation.** Removes the row from `global_fields` and removes all `schema_field_claims` rows referencing this field. `node_fields` rows are **untouched** — those fields are still in the DB, they just no longer have a global field definition. The orphan-ness is emergent: the join that would classify them as claimed no longer matches anything. Returns count of affected nodes and schemas. (Principle 2 in action: derived facts are query-time, never materialized.)

### Discovery tools

**`list-field-values`** — Parameters: `field_name`, optional `types` filter (string[]), optional `limit` (default 50). Queries `node_fields` for distinct values of that field name across the vault (optionally scoped to nodes of specified types), with counts.

Returns:
```typescript
{
  values: Array<{value: any, count: number}>;
  total_nodes: number;
  total_distinct: number;
}
```

`list-field-values` operates on `node_fields` directly. It works whether or not a global field exists with that name. This is intentional: discovery comes before definition.

**`infer-field-type`** — Parameters: `field_name`. Scans `node_fields` for that field name, analyzes the distribution of which typed columns are populated, distinct value counts, and patterns.

Returns:
```typescript
{
  proposed_type: string;
  confidence: number;  // 0.0–1.0
  evidence: {
    distinct_values: number;
    sample_values: any[];
    type_distribution: Record<string, number>;  // e.g., {"string": 45, "number": 3}
    dissenters: Array<{node_id: string, value: any}>;
  };
}
```

**Confidence thresholds (documented, heuristic):**
- `> 0.95`: all observed values fit one type cleanly
- `0.7–0.95`: dominant type with a few dissenters
- `< 0.7`: ambiguous — the agent should look at the evidence and probably ask the user

**Dissenter algorithm:** the proposer picks the type that fits the largest fraction of values; dissenters are values that don't fit that type.

`infer-field-type` is **purely observational** and ignores any existing global field with the same name. It infers from data only, never from existing definitions. If the agent wants "is the existing definition correct?", that's a different concern. This matters because the clean indexer boundary (raw parsed values, no coercion) is what makes honest inference possible — if the indexer were coercing, inference would be circular.

`infer-field-type` is a **proposer, not an enforcer**. The output is a suggestion the agent reviews and accepts. The engine never infers and writes in the same step.

### Enriched: `describe-global-field`

The existing tool (Phase 1, returns `NOT_FOUND`) gains cheap-join derived facts:

```typescript
{
  // ... full global field definition
  claimed_by_types: string[];   // which schemas have a claim on this field
  node_count: number;           // how many nodes have a value for this field
  orphan_count: number;         // how many of those nodes have the field but no claiming type
}
```

No drift detection — that's `validate-node`'s job.

---

## Section 3: Schema System

*Governed by Principle 3: types claim fields and may layer presentation, but cannot redefine semantics without explicit permission.*

### Data model

The `schemas` table is unchanged from Phase 1. The `schemas.field_claims` JSON column becomes unused in Phase 2 — not dropped (SQLite table recreation cost), just ignored. This column will be dropped or repurposed in Phase 3 when the renderer lands.

**New join table** replacing the JSON column:

```sql
CREATE TABLE IF NOT EXISTS schema_field_claims (
  schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
  field TEXT NOT NULL REFERENCES global_fields(name),
  label TEXT,
  description TEXT,
  sort_order INTEGER DEFAULT 1000,
  required INTEGER,
  default_value TEXT,
  PRIMARY KEY (schema_name, field)
);
CREATE INDEX IF NOT EXISTS idx_sfc_field ON schema_field_claims(field);
```

Promoting claims from JSON to a relational table makes cross-schema queries trivial: "which schemas claim `due_date`?" is a single indexed lookup. Rename and delete operations become clean SQL UPDATEs. Every cheap-join operation in this spec benefits.

### Per-claim metadata

Per-claim metadata is a **closed list**:

| Property | Category | Notes |
|----------|----------|-------|
| `label` | Presentation | display label override |
| `description` | Presentation | per-type description override |
| `sort_order` | Presentation | sort position in rendered frontmatter; default 1000 |
| `required` | Semantic | only non-null when global field has `per_type_overrides_allowed = 1` |
| `default_value` | Semantic | only non-null when global field has `per_type_overrides_allowed = 1` |

**Sort order tiebreaker:** claims are sorted by `sort_order` ascending, then by `field` name ascending. Unspecified-order claims (default 1000) sort to the end in field-name order.

**Validation rules on claim creation/update:**
- `field` must exist in `global_fields`. Claiming a nonexistent field is an error — create the global field first.
- `required` and `default_value` on a claim are rejected unless the referenced global field has `per_type_overrides_allowed = true`. Error message names the field and tells the agent to either set the property on the global field or enable overrides.
- Duplicate claims (same field twice in one schema) are an error (enforced by PK).
- The constraint that `required`/`default_value` are non-null only when permitted is **application-layer enforced** in `create-schema`/`update-schema`, not by a DB constraint.

### Phase 2 schema operations are metadata operations — no propagation to node data

Creating or updating a schema does not propagate to nodes. Adding a `due_date` claim to the `task` schema does not populate `due_date` on existing task nodes. The claim just exists, and the cheap joins immediately reflect it (e.g., `get-node` will show `due_date` in `unfilled_claims` for task nodes that lack it). Phase 3 adds propagation when the write path exists.

### MCP tools

**`create-schema`** — Parameters: `name`, `display_name` (optional), `icon` (optional), `filename_template` (optional), `field_claims` (array of claim objects), `metadata` (optional JSON). Validates: name uniqueness, every claimed field exists in `global_fields`, semantic override rules respected. Returns the created schema.

`create-schema` does not create the type in the data sense — it adds a definition to an existing or future type. The indexer already wrote `node_types` rows for types found in frontmatter. Calling `create-schema` for a name that has no `node_types` rows is allowed — the schema waits for nodes to claim the type.

**`update-schema`** — Parameters: `name` (identifies schema), plus any subset of mutable properties. `field_claims` **replaces the entire array** (not a patch). To add or remove a single claim, the agent reads the current schema with `describe-schema`, modifies the claims array, and sends the full array back via `update-schema`. There is no `add-claim` or `remove-claim` tool in Phase 2 — those are convenience layers that can be added later if the read-modify-write pattern proves verbose in practice.

Validates same rules as create. When a field is removed from claims, `node_fields` is untouched — those fields become orphans on affected nodes (query-time classification, Principle 2).

**`delete-schema`** — Parameters: `name`. Removes the schema row and all `schema_field_claims` rows (CASCADE). Does **NOT** touch `node_types` rows — nodes that had this type still have it, but the type now has no schema definition. Those nodes' fields become orphans (no claims exist to classify them). Returns count of affected nodes.

The agent can then decide whether to also remove the type from those nodes (Phase 3 mutation) or leave them as-is.

### Enriched: `describe-schema`

```typescript
{
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  metadata: any;
  field_claims: Array<{
    field: string;
    label?: string;
    description?: string;
    sort_order: number;
    required?: boolean;
    default_value?: any;
    global_field: {  // inlined for self-contained responses
      field_type: string;
      enum_values?: string[];
      reference_target?: string;
      description?: string;
      default_value?: any;
      required: boolean;
      per_type_overrides_allowed: boolean;
      list_item_type?: string;
    };
  }>;
  node_count: number;
  field_coverage: Record<string, {
    have_value: number;
    total: number;  // same as node_count
  }>;
  orphan_field_names: Array<{
    field: string;
    count: number;
  }>;
}
```

**`field_coverage` denominator:** all nodes where this type appears in `node_types` (multi-type aware — a node with `types: [meeting, task]` counts toward both schemas). Coverage counts a node toward a schema's `field_coverage[fieldName]` whenever the node has the type, the schema claims the field, and the node has a value for the field — independent of which other types the node has or which other schemas claim the same field.

**`orphan_field_names` interpretation:** fields that appear on nodes having this type but are **not in this schema's claims**. A field that another schema claims still appears here if this schema doesn't claim it. The semantic is "should this schema consider claiming this field," not "is this field orphaned on the node." This differs from `get-node`'s node-level orphan classification and the distinction is intentional.

The inlining of global field definitions in each claim is for caller convenience — `describe-schema` is self-contained and the agent doesn't need a second call to `describe-global-field`. The cost is mild duplication when the agent fetches related schemas.

No drift detection, no value validation — those are `validate-node`'s job.

---

## Section 4: Multi-Type Field Merging

*Governed by Principle 3: the global field pool is source of truth for field shape; types cannot redefine semantics without explicit permission.*

When a node has multiple types, tools compute the effective field set by merging claims. This is conceptually simple once the global field pool is in place — most of what was complicated about multi-type merging disappears when fields are global.

### Merge algorithm

Given a node's types array and the current schemas:

**Step 1: Collect claims.** For each type in array order, look up `schema_field_claims` rows. Types without schemas contribute no claims.

**Step 2: Union by field name.** Build an effective field set keyed by field name. Each field appears once.

**Step 3: Resolve per-field metadata.** For each field claimed by multiple types:

- **Presentation metadata** (`label`, `description`, `sort_order`): **first-defined wins.** Walk the types array in order; take the first non-undefined value for each presentation property. If no type sets the property, the global field's value (or a fallback derived from the field name) applies. This matters for optional metadata: if `meeting` doesn't set a label and `task` provides one, the user putting `[meeting, task]` shouldn't lose the label just because `meeting` is listed first. **Types array order matters for presentation** — document this to users.

  Note on `sort_order`: orders from different types are in different namespaces. `meeting` ordering claims 1–10 and `task` ordering claims 1–10 doesn't mean their values are comparable. The merge takes the first-defined order per field, then the rendering layer (Phase 3) sorts the merged set globally. Cross-type order normalization is not the merge algorithm's job.

- **Semantic metadata** (`required`, `default_value`): only present when the global field has `per_type_overrides_allowed = true`.
  - If all claiming types agree on the value: use it.
  - If they disagree: **error** (not warning). The merge refuses to produce a complete result for that field and surfaces the conflict. The agent must resolve it by (a) moving the property to the global field, (b) removing the override from one claim, or (c) making the claims agree.
  - When no claim overrides semantic metadata (the common case): the global field's own `required` and `default_value` apply.

- **All conflicts are collected before returning.** The merge does not short-circuit on the first conflict.

**Result:** Either `{ok: true, effective_fields: EffectiveFieldSet}` or `{ok: false, conflicts: MergeConflict[], partial_fields: EffectiveFieldSet}`.

```typescript
interface EffectiveField {
  field: string;
  global_field: GlobalFieldDefinition;
  resolved_label: string | null;
  resolved_description: string | null;
  resolved_order: number;
  resolved_required: boolean;
  resolved_default: any;
  claiming_types: string[];
}

type EffectiveFieldSet = Map<string, EffectiveField>;

interface MergeConflict {
  field: string;
  property: 'required' | 'default_value';
  conflicting_claims: Array<{type: string, value: any}>;
}
```

When conflicts exist, `partial_fields` contains all non-conflicting fields. Conflicting fields are excluded from the partial set but appear in `conflicts`.

### Internal consistency check

If a claim contains `required` or `default_value` and the referenced global field has `per_type_overrides_allowed = false`, the merge raises an `INTERNAL_CONSISTENCY` error. This state should be unreachable through the schema CRUD tools; encountering it indicates database corruption or a tool bypass. In Phase 3, when humans can edit `.schemas/*.yaml` files directly, the parser could introduce this state — the validation layer catches it.

### Where merging runs

The merge module has **one algorithm with two entry points**, not two parallel implementations:

- **`get-node` conformance** — runs steps 1–2 only: collect claims and union by field name. Produces the `claimed_fields` / `orphan_fields` / `unfilled_claims` partition without resolving per-field metadata or detecting conflicts. Cheap joins, always-on.
- **`validate-node`** — runs the full algorithm (steps 1–3). Produces the effective field set and surfaces conflicts. Opt-in, judgment.
- **Phase 3 write pipeline** — same full algorithm, called by `create-node`/`update-node` before applying mutations. Same module, new callers. Nothing to refactor.

### Structural impossibilities

**Field type conflicts between claims are structurally impossible.** The field type lives on the global field, not on the claim. Two schemas claiming `priority` both get the same `field_type` because there's only one `priority` in the global pool. This is a class of bug the global field pool eliminates by construction. The old system had to reason about field type conflicts because fields lived on schemas; the new system cannot have them because fields don't live on schemas. No one should add a `type_override` to claims — the answer is no.

### Orphan fields and merging

The merge algorithm operates only on claims. Fields present on a node but absent from all claiming types' schemas are orphans, classified at query time, and do not participate in merging. A node with `types: [task]` and a `priority` field that no claim covers is in a perfectly legal state — `priority` is an orphan, `validate-node` reports it without raising errors.

Orphan classification is a current-state fact, not a permanent property of the data. Adding a schema later, or adding a field claim to an existing schema, automatically reclassifies fields without re-indexing — because it's a query-time join (Principle 2).

---

## Section 5: Validation Engine

*Governed by Principle 1: the validation engine judges; in Phase 2 nothing acts on the judgment yet.*

The validation engine is a pure function module. In Phase 2, its only MCP caller is `validate-node`. In Phase 3, the write pipeline calls the same functions.

### Interface

```typescript
interface ValidationResult {
  valid: boolean;  // true iff issues.filter(i => i.severity === 'error').length === 0
  effective_fields: EffectiveFieldSet;  // partial if merge conflicts exist
  coerced_state: Record<string, CoercedValue>;  // everything that would end up in the node
  issues: ValidationIssue[];
  orphan_fields: string[];  // convenience list of orphan field names
}

interface CoercedValue {
  field: string;
  value: any;
  source: 'provided' | 'defaulted' | 'orphan';
  changed: boolean;  // true if value differs from input (coercion applied)
}

interface ValidationIssue {
  field: string;
  severity: 'error';  // always 'error' in Phase 2; field exists for future warning support
  code: string;
  message: string;
  details?: any;
}
```

**Issue codes:**
- `REQUIRED_MISSING` — required field not provided
- `ENUM_MISMATCH` — value not in declared enum_values (details: `{closest_matches: string[]}`)
- `TYPE_MISMATCH` — value type doesn't match field_type and coercion failed
- `COERCION_FAILED` — coercion attempted but failed (details: `{from_type, to_type, reason}`)
- `LIST_ITEM_COERCION_FAILED` — list element failed coercion (details: `{index, value, reason}`)
- `MERGE_CONFLICT` — multi-type semantic metadata conflict (details: `MergeConflict`)
- `INTERNAL_CONSISTENCY` — claim has override on non-permitting field

**In Phase 2, all issues have `severity: 'error'`.** Successful coercions go in `coerced_state` with `changed: true`, not in `issues`. The `severity` field exists for Phase 3+ when the engine might want warnings (e.g., "coerced 'TODO' to 'todo' — matched but didn't match exactly").

### Algorithm

Given `(proposed_fields: Record<string, any>, types: string[], db)`:

**Step 1: Run the merge** (Section 4, full algorithm). If merge conflicts exist, **do not bail** — fall back to the partial effective field set (non-conflicting fields), add conflict issues, and continue validating values against the partial set. The agent sees all problems at once.

**Step 2: Check required fields and defaults.** For each field in the effective field set:
- If `required` and missing from `proposed_fields`: issue `REQUIRED_MISSING`.
- If missing and has a `default`: include in `coerced_state` with `source: 'defaulted'`.
- Explicit `null` overrides defaults — `null` is deletion intent. If the field was required, `REQUIRED_MISSING` is raised. The default is not applied. This is the only way for the agent to say "I really mean no value here."

**Step 3: Validate and coerce each provided field.** For each field in `proposed_fields` that IS in the effective field set:

Type check against the global field's `field_type`. If mismatch, attempt coercion.

**Coercion rules (deterministic, no LLM):**

| From → To | Rule |
|-----------|------|
| string → number | The entire string must parse cleanly as a number. Use strict check — reject trailing non-numeric characters, `Infinity`, `-Infinity`, empty string. `"42 dollars"` fails. |
| string → date | Parse ISO 8601. Accepts date-only (`2026-04-11`) and date-time (`2026-04-11T14:30:00`). Store as-is (date-only stays date-only). Fail if unparseable. |
| string → boolean | Case-insensitive: `"true"/"false"/"yes"/"no"`. Fail otherwise. `"1"/"0"` are not accepted — predictability over cleverness. |
| string → enum | Trim whitespace, then case-insensitive match against declared `enum_values`. Fail if no match. For non-string input: attempt `String(value)` first, then case-insensitive match. |
| string → reference | References are stored as wiki-link strings (`[[target]]`). If value doesn't start with `[[` and end with `]]`, wrap it. If already wrapped (including `[[Alice\|nickname]]` aliases), leave alone — preserve aliases. |
| number → string | `String(n)` |
| Date → string | ISO 8601 |
| single value → list | For string values and a `list<string>` field: wrap as single-element array (`"alice"` → `["alice"]`). For other types: reject (`TYPE_MISMATCH`). |
| list elements | Coerce each element against `list_item_type`. Element failures produce `LIST_ITEM_COERCION_FAILED` with `{index, value, reason}` in details. |

**Enum validation:** post-coercion, value must be in `enum_values`. Issue `ENUM_MISMATCH` with closest matches if not.

**Reference validation:** target string stored as-is. No validation that the target node exists — dangling references are valid per the charter. Resolution is query-time per Phase 1 design.

**Step 4: Handle orphan fields.** Fields in `proposed_fields` NOT in the effective field set are orphans. No validation — they pass through unchanged into `coerced_state` with `source: 'orphan'`. Not errors. Data is never silently deleted.

**Step 5: Return `ValidationResult`.** `valid = (issues.filter(i => i.severity === 'error').length === 0)`. The engine collects all issues, never bails early.

### `validate-node` MCP tool

**Parameters (two modes, exactly one required):**
- `node_id` — validate the current state of an existing node against its current types and schemas
- `proposed: {types: string[], fields: Record<string, any>}` — validate hypothetical state without a real node

The hypothetical mode is exactly what Phase 3's `create-node` and `update-node` will call internally before writing.

**Response:**
```typescript
{
  valid: boolean;
  effective_fields: EffectiveFieldSet;  // partial if merge conflicts exist
  coerced_state: Record<string, CoercedValue>;
  issues: ValidationIssue[];
  orphan_fields: string[];
  types_without_schemas: string[];  // cheap join, not validation engine output
}
```

`types_without_schemas` is a cheap join composed into the tool's response alongside the validation engine's output. The engine itself doesn't compute structural facts — the tool composes engine output with cheap joins. Same boundary rule from Section 1.

**When all types lack schemas:** the effective field set is empty, all fields are orphans, and validation succeeds trivially. `types_without_schemas` signals this to the caller: "none of your types have schemas, so this validation is essentially a no-op."

**When merge conflicts exist:** `effective_fields` contains the non-conflicting fields and `issues` contains the conflict errors. Value validation still runs against the partial set.

---

## Section 6: Enrichments to Existing Tools

*Governed by the read-path boundary rule: structural questions via joins are always-on; value-level questions via the validation engine are opt-in.*

### `get-node` enrichment

The existing response gains a `conformance` block:

```typescript
{
  // ... existing fields (id, file_path, title, types, fields, relationships, body, etc.)
  conformance: {
    claimed_fields: Array<{
      field: string;
      claiming_types: string[];
    }>;
    orphan_fields: string[];
    unfilled_claims: Array<{
      field: string;
      claiming_types: string[];
      required: boolean;  // from the global field definition (fact, not judgment)
    }>;
    types_with_schemas: string[];
    types_without_schemas: string[];
  }
}
```

**Three-way field classification:**
- `claimed_fields`: fields the node has AND at least one type's schema claims
- `orphan_fields`: fields the node has but NO type's schema claims
- `unfilled_claims`: fields a type's schema claims but the node doesn't have a value for

This is steps 1–2 of the merge algorithm (Section 4) applied to a specific node. No metadata resolution, no conflict detection.

**`claimed_fields` shape:** `claiming_types` is always an array, even for single-typed nodes. Consistency matters more than terseness.

**Cost:** at most 3 indexed queries (node_types, schema_field_claims join, node_fields lookup). For a vault with thousands of nodes and dozens of schemas, sub-millisecond overhead per call. If implementation exceeds this target, the implementation is wrong.

### `describe-schema` enrichment

See Section 3 for the full response shape. Key additions:
- `node_count`, `field_coverage` (raw `{have_value, total}` counts per field), `orphan_field_names`
- All cheap joins, no drift detection

### `list-types` enrichment

```typescript
Array<{
  type: string;
  count: number;
  has_schema: boolean;
  claim_count: number | null;  // number of field claims; null if has_schema is false
}>
```

### `describe-global-field` enrichment

See Section 2. Key additions: `claimed_by_types`, `node_count`, `orphan_count`. All cheap joins.

### Unchanged tools

`vault-stats`, `query-nodes`, `list-schemas`, `list-global-fields` are unchanged. The list tools return the full set; the cheap-join enrichments the agent might want are in the `describe-*` tools, not the list views.

### Universal consistency rule

**Wherever a tool returns a type name as part of its output, the response shape makes schemaless types distinguishable from schema-backed types.** Specific implementations vary by tool (`has_schema: boolean`, `types_with_schemas/types_without_schemas: string[]`, etc.) but the rule is universal. Future tools (Phase 3's `add-type-to-node`, workflow tools) inherit this pattern automatically.

---

## Section 7: DB Migration Strategy

### Fresh installs

For fresh installs (no existing DB), the Phase 2 columns are folded into the Phase 1 `CREATE TABLE` statement so a fresh install gets the full schema in one shot. `createSchema()` produces the complete table definitions.

### Existing DB upgrades

For existing DBs (Phase 1 already ran), a separate upgrade path runs conditional `ALTER TABLE` statements after checking column existence via `PRAGMA table_info()`.

All migration operations run in a **single transaction** — if any fails, the migration rolls back. No half-migrated DB state.

### Migration block (upgrade path)

```sql
-- Phase 2: global_fields additions
ALTER TABLE global_fields ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN per_type_overrides_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN list_item_type TEXT;

-- Phase 2: schema_field_claims join table
CREATE TABLE IF NOT EXISTS schema_field_claims (
  schema_name TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
  field TEXT NOT NULL REFERENCES global_fields(name),
  label TEXT,
  description TEXT,
  sort_order INTEGER DEFAULT 1000,
  required INTEGER,
  default_value TEXT,
  PRIMARY KEY (schema_name, field)
);
CREATE INDEX IF NOT EXISTS idx_sfc_field ON schema_field_claims(field);
```

---

## Section 8: Testing Strategy

### Validation engine unit tests (no DB)

**Coercion tests:**
- Each type pair: string→number (clean, trailing junk, Infinity, empty string), string→date (date-only, date-time, invalid), string→boolean (true/false/yes/no, rejected values), string→enum (case-insensitive, whitespace trimming, non-string input), string→reference (bare value wrapping, alias preservation), number→string, Date→string
- Single value → list wrapping (string wraps, other types reject)
- List element coercion with index tracking in errors
- Null as deletion intent: null on required field → REQUIRED_MISSING, null overrides default

**Merge tests:**
- Single type, single claim
- Multi-type, no conflicts, presentation first-defined-wins (first type undefined, second type defined → second wins)
- Multi-type, semantic conflict → error with all conflicts collected (no short-circuit)
- All types schemaless → empty effective set
- Internal consistency error: claim has override on non-permitting field
- Cross-type sort_order: namespaces not comparable, first-defined wins

**Full validation tests:**
- Required missing, default supplied (source: 'defaulted')
- Enum mismatch with closest matches
- List element failure with index in details
- Orphan pass-through (source: 'orphan')
- Merge conflicts + value errors in same run (no bail on conflicts — partial set + continued validation)
- Hypothetical mode: proposed state input, no real node
- All-schemaless: empty effective set, all orphans, validation passes trivially
- Explicit null overrides default on non-required field

### Schema CRUD integration tests (in-memory SQLite)

- Create schema: claim validation (nonexistent field → error, semantic override without permission → error)
- Update schema: full-replace claims, removed claims don't touch node_fields
- Delete schema: node_types untouched, orphan-ness emergent
- Rename global field: propagates to `schema_field_claims.field` and `node_fields.field_name` atomically
- Delete global field: removes from `schema_field_claims`, `node_fields` untouched
- Update global field type change: preview returns coercible/uncoercible, confirm applies with orphaning of uncoercible values

### MCP tool tests (pre-populated DB)

- `get-node` conformance: claimed_fields, orphan_fields, unfilled_claims for single-type, multi-type, and schemaless nodes
- `describe-schema`: node_count, field_coverage (multi-type denominator correctness), orphan_field_names (interpretation (a) — includes fields claimed by other schemas)
- `list-types`: has_schema, claim_count
- `describe-global-field`: claimed_by_types, node_count, orphan_count
- `validate-node`: both modes (real node + hypothetical), all issue codes
- `list-field-values`: with and without type filter, works without existing global field
- `infer-field-type`: confidence thresholds, dissenter algorithm, ignores existing global field

### Query-count discipline tests

Wrap `get-node` and `describe-schema` in a query counter. Assert the conformance/enrichment block stays within the stated cost bounds (at most 3 indexed queries for `get-node` conformance). Regressions caught immediately.

### Cross-tool schemaless consistency test

A single test that creates a schemaless-type fixture and calls `get-node`, `describe-schema` (for a different type on the same node), `list-types`, and `validate-node`. Asserts each tool marks the schemaless type consistently per the universal rule (Section 6). Contracts across multiple tools need explicit cross-tool tests.

### End-to-end integration test

1. Index fixture vault
2. Create global fields (string, enum, reference, list types)
3. Create schemas with field claims
4. Call `get-node` — verify conformance (claimed, orphan, unfilled)
5. Call `validate-node` — verify issues and coerced_state
6. Rename a global field — verify propagation across node_fields and schema_field_claims
7. Update a global field's type with preview/confirm — verify coercible values coerced, uncoercible values orphaned
8. Delete a schema — verify node_types untouched, orphan emergence
9. Call `list-types`, `describe-global-field` — verify enrichments reflect all changes

---

## Section 9: Phase 2 Non-Goals

Explicit non-goals to prevent scope creep:

- **No schema YAML rendering.** Schemas are DB-only in Phase 2. `.schemas/*.yaml` files are a Phase 3 renderer target.
- **No node mutation.** Validation is dry-run only. `create-node`, `update-node`, `delete-node`, `rename-node`, `batch-mutate` are Phase 3.
- **No automatic propagation on schema change.** Adding a claim doesn't populate values on existing nodes; creating a schema doesn't modify any node's fields. The claim exists and cheap joins reflect it immediately, but no data moves. Propagation is Phase 3.
- **No type assignment tools.** `add-type-to-node` and `remove-type-from-node` require the write path. Phase 3.
- **No alias support on `rename-global-field`.** Rename is immediate; old name returns errors. Aliasing is Phase 5 reconciliation.
- **No drift detection in `describe-schema`.** Drift (value-level conformance checking) is `validate-node`'s job. `describe-schema` does structural joins only.
- **No warnings in validation issues.** All issues are errors in Phase 2. The `severity` field exists for future use.
- **No `infer-schemas` orchestrator.** The discovery primitives (`infer-field-type`, `list-field-values`) are Phase 2; the workflow tool that composes them into a full schema proposal is Phase 5.
- **No field reconciliation.** `reconcile-fields` is Phase 5.

---

## Section 10: Build Sequence

Implementation order, stating dependencies explicitly:

1. **DB migration** — `createSchema()` changes: fresh-install full schema, upgrade path with conditional ALTERs, `schema_field_claims` table. Everything else depends on this.

2. **Validation pure modules with unit tests** — `src/validation/coerce.ts`, `src/validation/merge.ts`, `src/validation/validate.ts`. No DB dependency (except merge reading schemas, which can be injected). Test-first: coercion edge cases, merge algorithm, full validation. These modules are the architectural core of Phase 2.

3. **Global field CRUD** — `src/global-fields/`. Create, update (including type-change preview/confirm), rename (propagation), delete (metadata-only). Integration tests against in-memory SQLite.

4. **Schema CRUD** — `src/schema/`. Create, update (full-replace claims with validation), delete. Depends on global fields existing. Integration tests.

5. **Discovery tools** — `src/discovery/`. `infer-field-type`, `list-field-values`. Pure queries against `node_fields`. Can be built in parallel with steps 3–4.

6. **MCP tool handlers** — `src/mcp/tools/`. Wire up all new tools (10 handlers). Wire up `validate-node` to the validation engine.

7. **Enrichments to existing tools** — Update `get-node`, `describe-schema`, `describe-global-field`, `list-types` with conformance/cheap-join data.

8. **Integration and cross-cutting tests** — Query-count discipline, cross-tool schemaless consistency, end-to-end integration test.

---

## Dependencies

No new npm dependencies required for Phase 2. All functionality uses existing packages (better-sqlite3, nanoid) and standard library.

---

## Summary

Phase 2 adds 10 new MCP tools, enriches 4 existing tools, introduces a pure-function validation engine, and establishes the global field pool and schema system as DB-first data. The indexer is unchanged. All conformance facts are query-time derived. The validation engine is ready for Phase 3's write pipeline with zero refactoring — same module, new callers.
