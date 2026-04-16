# Vault Engine - Per-Type Field Overrides Spec

**Status:** Draft — reviewed, revised, ready for implementation
**Goal:** Allow schemas to override selected properties of the global fields they claim — particularly `enum_values`, `default_value`, and `required` — so types can specialize shared fields without forcing per-type shadow fields (`note_status`, `task_priority`, etc.).

---

## Driving use case: `note` schema specialization

This spec is motivated by a concrete pending change to the `note` schema. Once the per-type override mechanism lands, the `note` schema gets two new field claims:

- **`subtype`** — claimed with `enum_values_override: [spec, implementation-plan, bug, observation]`. The global `subtype` field is currently a `list<enum>` claimed by `person` and `company` with their own per-type enum vocabularies. `note` needs its own constrained enum values that are meaningful for notes specifically (distinguishing a spec from a bug report from an observation), without disturbing how `person` and `company` use the same field.
- **`status`** — claimed with `default_value_override: null`. The global `status` field defaults to `"open"`, which is correct for `task` and `project` but wrong for `note` — most notes have no lifecycle and shouldn't auto-populate a status. `note` needs to claim the field (so the values, when present, are validated against the shared lifecycle vocabulary) but suppress the default.

Both changes are blocked today because the schema layer offers no way to make them. The escape hatch — defining `note_subtype` and `note_status` global fields — is exactly the proliferation pattern this spec is designed to prevent. These two `note` claims are the canonical first consumers of the override mechanism and serve as the acceptance test for whether the design works in practice.

### Prerequisite: `subtype` field migration

The global `subtype` field is currently `list<string>` (`field_type: 'list'`, `list_item_type: 'string'`, `enum_values: null`). The existing data is already enum-shaped — proper vocabularies like `Political Figure`, `Author`, `Publication`, not free-form text. The field just hasn't been declared as such.

Before the override mechanism can constrain `subtype` values per-type, the field must be migrated to `list<enum>`:

1. **Update global field:** `list_item_type: 'string'` -> `list_item_type: 'enum'`, set `enum_values` to the union of all existing values (the ~11 distinct strings currently in use), and set `overrides_allowed.enum_values: true`.
2. **Update `person` schema claim:** add `enum_values_override: [Political Figure, Author, Historical Figure, Businessman, Athlete, Actor]`.
3. **Update `company` schema claim:** add `enum_values_override: [Publication, Company, Political Party, NGO, Government Organization]`.
4. **Add `note` schema claim:** `enum_values_override: [spec, implementation-plan, bug, observation]`.

This migration is a follow-on task performed via tool calls after the override mechanism ships, not something the override mechanism itself handles. The global enum_values (the union set) serve as the fallback for any type that claims `subtype` without providing its own override.

---

## Motivation

The global field pool exists so types can share semantics: every type that claims `status` participates in a shared lifecycle vocabulary, every type that claims `date` gets the same date handling. This works well when types want the same behavior.

It breaks down when a type wants the same *field* but different *behavior*. Concrete cases:

- `note` wants a `subtype` field with values `[spec, implementation-plan, bug, observation]`. `person` and `company` already claim `subtype` with their own vocabularies. There's no way for `note` to constrain `subtype` to its own enum without inventing `note_subtype` and abandoning the shared field name.
- `note` wants a `status` field but with no default value. The global `status` defaults to `"open"`, which makes sense for `task` and `project` but not for notes (most of which never have a status at all).
- More generally: every time a type needs a field "almost like the global one but with one tweak," the only escape hatch today is to define a parallel field. This proliferates near-duplicate fields, defeats the pool's purpose, and forces query callers to know which type-specific field to target.

The current `per_type_overrides_allowed` boolean was a first step — it gates `required` and `default_value` overrides at the schema-claim level. But it's a single coarse switch and doesn't cover `enum_values`, which is the most-requested override.

This spec extends per-type overrides to cover `enum_values`, splits the gating flag into per-property switches, and specifies how overrides resolve for multi-type nodes.

---

## Design

### 1. Override semantics: replace, not extend

When a schema claims a field and provides an `enum_values` override, the override **fully replaces** the global field's enum values for nodes of that type. The global enum values are not implicitly merged in.

Rationale: replace is the simplest mental model. Extend (union) preserves shared vocabulary but creates a system where "what values does this field accept?" depends on which type you're asking about *and* which global state existed at the time. Replace is unambiguous: the schema claim is the single source of truth for that type's enum values.

This means schemas that want to extend the global vocabulary must explicitly include the global values in their override list. Slightly more verbose, but the explicitness is worth it.

### 2. Split `per_type_overrides_allowed` into per-property flags

Replace the single boolean with a structured object on the global field definition:

```yaml
overrides_allowed:
  required: true
  default_value: true
  enum_values: false
```

**Default for newly created fields:** all-false. Override permission is opt-in per property. This matches the design intent that overrides are a deliberate choice by the field author, not an ambient capability.

Existing fields with `per_type_overrides_allowed: true` migrate to `{ required: true, default_value: true, enum_values: false }`. Existing fields with `false` (or unset) migrate to all-false. See [section 8 (Migration)](#8-migration) for details.

**Object shape, not list.** The per-property object is preferred over a list of property names (`overrides_allowed: [required, default_value]`). Object is more discoverable when reading YAML, and extends cleanly if future override types are added.

Field-definition-time validation: schemas providing an override for a property where `overrides_allowed[property]` is false -> reject the schema definition with a structured error pointing at the offending claim.

### 3. Multi-type resolution: per-type validation

When a node has multiple types and more than one claims the same field with overrides, the resolution strategy differs by property:

#### `enum_values`: valid-for-any-type

Rather than computing a union set, the validator checks the field value against each claiming type's effective enum values independently. A value is **valid if at least one of the node's types accepts it.**

Example: `note` claims `subtype` with override `[spec, bug]`, `meeting` claims `subtype` with override `[1on1, standup]`. A node with `types: [note, meeting]` and `subtype: spec` is valid (accepted by `note`). `subtype: 1on1` is also valid (accepted by `meeting`). `subtype: unknown` is invalid (rejected by both).

This model handles the **mixed-override case** correctly: if `note` claims `subtype` with override `[spec, bug]` and `person` claims `subtype` with no override (inheriting the global field's enum values), a node with `types: [note, person]` checks the value against both `note`'s override and `person`'s inherited global enum values. A value is valid if either type accepts it.

Rationale: per-type validation is a cleaner mental model than union-of-sets. It avoids computing a synthetic set that no individual type actually defines, and it naturally handles the mixed-override case without special-case logic. The question "is this value valid?" becomes "does at least one of this node's types accept it?" — simple, predictable, and composable.

**`closestMatches()` for `ENUM_MISMATCH` errors:** When a value is rejected by all types, the error collects the effective enum values from all claiming types (deduplicated) for closest-match suggestions. This gives the user the full picture of what any of their types would accept.

#### `default_value`: cancellation on conflict

For single-type nodes, the type's `default_value_override` applies directly.

For multi-type nodes: if all claiming types that provide a `default_value_override` agree on the same value, that value applies. If they **conflict**, the overrides cancel out and the **global default** applies. If the global field has no default either, no default is populated.

Rationale: order-dependent resolution (`types: [note, meeting]` vs `types: [meeting, note]` producing different defaults) is a foot-gun that users won't remember and won't debug easily. Cancellation is the conservative choice — it never silently picks the "wrong" default, and single-type nodes (the common case) always get the right behavior.

#### `required`: cancellation on conflict

Same rule as `default_value`: if all claiming types that provide a `required_override` agree, that value applies. If they conflict, the overrides cancel out and the global field's `required` setting applies.

### 4. Storage: extend `field_claims` with override slots

Each entry in a schema's `field_claims` array gains optional override properties:

```yaml
field_claims:
  - field: subtype
    enum_values_override: [spec, implementation-plan, bug, observation]
  - field: status
    default_value_override: null   # explicit null = no default, even if global has one
    required_override: false
```

Backwards compatible: missing override slots mean "inherit from global." Existing schema definitions are unchanged.

#### Naming convention

All three override properties on claims use the `_override` suffix consistently:

- `enum_values_override`
- `default_value_override`
- `required_override`

The existing `required` and `default_value` columns on `schema_field_claims` are renamed to `required_override` and `default_value_override` in the DB migration. This makes the semantics unambiguous — these columns are overrides, not standalone values.

#### Explicit null vs. absent: discriminated union

`default_value_override: null` must mean "no default" (overriding the global default to nothing), not "no override specified." This distinction is critical and easy to lose in YAML round-trips.

**Internal representation:** Overrides are stored as a discriminated union:
```typescript
type Override<T> = { kind: 'inherit' } | { kind: 'override'; value: T };
```

**Serialization:** `{ kind: 'inherit' }` serializes as an absent key. `{ kind: 'override', value: null }` serializes as `default_value_override: null` (bare key in YAML: `default_value_override:`). The deserializer checks `key in object` to distinguish absent from explicit null.

**Mandatory round-trip test:** A dedicated test must confirm that `default_value_override: null` survives a full load -> edit -> save -> reload cycle without becoming "inherit." This is a hard requirement, not a nice-to-have — any intermediate code path that does `if (!claim.default_value_override) { delete claim.default_value_override; }` would silently break the feature.

### 5. DB storage

#### `global_fields` table: `overrides_allowed` as three columns

Replace the single `per_type_overrides_allowed INTEGER` column with three explicit columns:

```sql
ALTER TABLE global_fields ADD COLUMN overrides_allowed_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0;
```

Three columns is preferred over a JSON TEXT column because:
- The rest of `global_fields` is flat columns, not JSON — consistency matters.
- Individual columns are queryable without JSON extraction functions.
- Each flag is a simple boolean — no structured data to parse.

The deprecated `per_type_overrides_allowed` column is dropped after migration (see [section 8](#8-migration)).

#### `schema_field_claims` table: override columns

Rename existing columns and add the new one:

```sql
-- Rename for clarity (existing columns)
ALTER TABLE schema_field_claims RENAME COLUMN required TO required_override;
ALTER TABLE schema_field_claims RENAME COLUMN default_value TO default_value_override;

-- New column
ALTER TABLE schema_field_claims ADD COLUMN enum_values_override TEXT;
```

Column semantics:
- `required_override INTEGER` — `NULL` = inherit from global. `0` = override to false. `1` = override to true.
- `default_value_override TEXT` — `NULL` = inherit from global. Any other value (including the string `'null'` representing JSON null) = override. See below for the null-vs-absent problem.
- `enum_values_override TEXT` — `NULL` = inherit from global. Non-null = JSON array of enum value strings.

#### Solving the `default_value_override: null` problem in SQLite

SQLite `NULL` means "no override" (inherit). But we need to represent "override to no default" (explicit null). Two options were considered:

**Option A: Boolean flag column.** Add `default_value_overridden INTEGER DEFAULT 0`. When `1`, the `default_value_override` column is the override value even if it's `NULL`.

**Option B: Sentinel value.** Store a JSON sentinel like `"__INHERIT__"` to mean inherit, and SQL `NULL` means override-to-null.

**Decision: Option A (boolean flag).** It's explicit, doesn't pollute the value space, and is easy to query:

```sql
ALTER TABLE schema_field_claims ADD COLUMN default_value_overridden INTEGER NOT NULL DEFAULT 0;
```

Reading logic:
- `default_value_overridden = 0` -> `{ kind: 'inherit' }`
- `default_value_overridden = 1, default_value_override = NULL` -> `{ kind: 'override', value: null }`
- `default_value_overridden = 1, default_value_override = '...'` -> `{ kind: 'override', value: JSON.parse(...) }`

This ensures the discriminated union survives DB round-trips without ambiguity.

### 6. Validation pipeline integration

The validation engine currently resolves a field's effective definition by looking up the global field. After this change, it must:

1. For each type in the node's `types` array, find the schema's claim for the field (if any).
2. Collect any per-type overrides from those claims.
3. Resolve to the effective definition per the rules in [section 3](#3-multi-type-resolution-per-type-validation):
   - `enum_values`: check the field value against each claiming type's effective enum independently. Valid if at least one type accepts it. If none accept it, collect all effective enum values (deduplicated) for `closestMatches()`.
   - `default_value`: if all overriding types agree, use that value. If they conflict, fall back to global. If no type overrides, use global.
   - `required`: if all overriding types agree, use that value. If they conflict, fall back to global. If no type overrides, use global.
4. Validate the field value against the resolved effective definition.

#### Behavior change from current MERGE_CONFLICT handling

Currently, `merge.ts` surfaces `MERGE_CONFLICT` issues in two cases:
1. Overrides exist but `per_type_overrides_allowed` is false (internal consistency error).
2. Multiple types override and disagree (conflict).

After this change:
- **Case 1 is eliminated.** The split `overrides_allowed` flags are enforced at schema-definition time. If a schema passes validation on create/update, its overrides are always allowed. No runtime MERGE_CONFLICT for "override not allowed."
- **Case 2 becomes silent cancellation.** Disagreeing overrides cancel to the global default instead of surfacing a MERGE_CONFLICT issue. This is the intended behavior per [section 3](#3-multi-type-resolution-per-type-validation) — cancellation is conservative and predictable, not an error.

The `MERGE_CONFLICT` issue code is retained for potential future use but will not be emitted by the override resolution logic.

#### Enum validation for `list` fields with enum items

When a `list` field has `list_item_type: 'enum'`, enum validation applies to each list item individually. Per-type `enum_values_override` replaces the effective enum values used for item validation. This is already how `coerceValue` works — `coerceList` delegates each element to `coerceValue(item, list_item_type, options)` — so the override mechanism only needs to swap the `enum_values` in the options, not add special list handling.

`enum_values_override` is only valid on fields where enum validation is structurally meaningful:
- `field_type: 'enum'` (direct enum field)
- `field_type: 'list'` with `list_item_type: 'enum'` (list of enum items)

Any other combination (e.g., `list<string>`, `number`, `json`) is rejected at schema-definition time with a structured error.

#### Schema-load-time structural compatibility check

When a schema claim provides an `enum_values_override`, the global field must have a type that supports enum constraints (per the list above). If the global field's type is structurally incompatible with enum validation, reject the schema claim at definition time with a structured error. This prevents nonsensical overrides from entering the system.

### 7. Tool surface changes

- `create-schema` and `update-schema`: `field_claims` accepts the new override slots (`enum_values_override`, `default_value_override`, `required_override`).
- `describe-schema`: returns each claim's effective resolved definition alongside the global field reference, so callers can see at a glance what values/defaults apply for that type. Always returned — no `include_resolved` flag. Callers shouldn't have to ask twice for what they almost always want.
- `describe-global-field`: returns the new `overrides_allowed` structure and lists which claiming types provide overrides for which properties.
- `create-global-field` and `update-global-field`: accept the new `overrides_allowed` object (`{ required?: boolean, default_value?: boolean, enum_values?: boolean }`).
- `validate-node` and the `ENUM_MISMATCH` details (per Stabilization Spec Change 1): `allowed_values` returns the deduplicated effective values across all of the node's claiming types, not the raw global values.
- `list-field-values`: returns raw stored values regardless of per-type enum constraints. A value that was valid when written under type A's enum may appear in results even after the node's types change. This is correct behavior (data is never silently deleted), but worth noting: `list-field-values` shows what *is*, not what's currently *valid*.

No new tools.

### 8. Migration

#### DB migration

Run in a single migration transaction:

```sql
-- Step 1: Add new overrides_allowed columns to global_fields
ALTER TABLE global_fields ADD COLUMN overrides_allowed_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN overrides_allowed_default_value INTEGER NOT NULL DEFAULT 0;
ALTER TABLE global_fields ADD COLUMN overrides_allowed_enum_values INTEGER NOT NULL DEFAULT 0;

-- Step 2: Migrate existing per_type_overrides_allowed values
UPDATE global_fields
SET overrides_allowed_required = per_type_overrides_allowed,
    overrides_allowed_default_value = per_type_overrides_allowed,
    overrides_allowed_enum_values = 0;

-- Step 3: Drop deprecated column
ALTER TABLE global_fields DROP COLUMN per_type_overrides_allowed;

-- Step 4: Rename existing claim columns for clarity
ALTER TABLE schema_field_claims RENAME COLUMN required TO required_override;
ALTER TABLE schema_field_claims RENAME COLUMN default_value TO default_value_override;

-- Step 5: Add new claim columns
ALTER TABLE schema_field_claims ADD COLUMN enum_values_override TEXT;
ALTER TABLE schema_field_claims ADD COLUMN default_value_overridden INTEGER NOT NULL DEFAULT 0;

-- Step 6: Mark existing non-null default_value_override rows as overridden
UPDATE schema_field_claims SET default_value_overridden = 1 WHERE default_value_override IS NOT NULL;
```

#### Data migration notes

- Existing fields with `per_type_overrides_allowed: true` get `overrides_allowed_required: 1, overrides_allowed_default_value: 1, overrides_allowed_enum_values: 0`. The default for `enum_values` is intentionally `false` everywhere — it's a more invasive override than `required`/`default_value` and should be opted into per-field.
- Existing fields with `per_type_overrides_allowed: false` (or `0`) get all-zero. No change in behavior.
- Existing schema `field_claims` are unchanged in behavior. Column renames are cosmetic. The `default_value_overridden` backfill (step 6) preserves existing semantics: any non-null `default_value_override` was already treated as an override.
- The deprecated `per_type_overrides_allowed` column is dropped in the same release. There are few enough global fields and no external consumers, so a clean break beats long-term parallel-flag maintenance.

#### TypeScript type migration

- `GlobalFieldDefinition.per_type_overrides_allowed: boolean` is replaced by `GlobalFieldDefinition.overrides_allowed: { required: boolean; default_value: boolean; enum_values: boolean }`.
- `FieldClaim.required: boolean | null` is renamed to `FieldClaim.required_override` (same type).
- `FieldClaim.default_value: unknown` is replaced by a discriminated union accessed via helper (the raw DB columns are `default_value_override` + `default_value_overridden`).
- `FieldClaim` gains `enum_values_override: string[] | null` (null = inherit).

---

## Scope

- `src/db/schema.ts` — migration SQL, new columns.
- `src/validation/types.ts` — type definitions (`GlobalFieldDefinition`, `FieldClaim`, `EffectiveField`, `MergeConflict`).
- `src/validation/merge.ts` — override resolution logic: per-type enum validation, cancellation-on-conflict for default/required, removal of MERGE_CONFLICT emission for override disagreements.
- `src/validation/validate.ts` — pass resolved effective enum_values to coercion, collect deduplicated enum values for ENUM_MISMATCH details.
- `src/validation/coerce.ts` — no changes expected (enum validation for list items already works via delegation).
- `src/schema/crud.ts` — claim validation (enforce `overrides_allowed` per-property), `ClaimInput` shape, `insertClaims` with new columns.
- `src/global-fields/crud.ts` — CRUD for `overrides_allowed` object (three columns).
- `src/pipeline/schema-context.ts` — load new columns into `FieldClaim` and `GlobalFieldDefinition`.
- `src/mcp/tools/create-schema.ts`, `update-schema.ts` — accept new override slots on claims.
- `src/mcp/tools/describe-schema.ts` — surface resolved effective definitions per claim.
- `src/mcp/tools/describe-global-field.ts` — surface `overrides_allowed` object, list which types override which properties.
- `src/mcp/tools/create-global-field.ts`, `update-global-field.ts` — accept `overrides_allowed` object.
- `src/schema/render.ts` — YAML serialization of new shapes (`overrides_allowed` object, claim overrides).
- Tests:
  - Schema-definition-time rejection of overrides for properties where `overrides_allowed[property]` is false.
  - Schema-definition-time rejection of `enum_values_override` on a structurally incompatible global field type (e.g., `list<string>`, `number`).
  - Schema-definition-time acceptance of `enum_values_override` on `enum` and `list<enum>` fields.
  - Single-type override resolution for each of the three properties.
  - Multi-type `enum_values`: valid-for-any-type (value accepted by at least one type passes; value rejected by all fails with deduplicated closest-match suggestions).
  - Multi-type `enum_values` mixed-override case: one type overrides, another inherits global enum — value checked against both.
  - Multi-type `default_value`: agreeing overrides apply; conflicting overrides cancel to global default.
  - Multi-type `required`: agreeing overrides apply; conflicting overrides cancel to global setting.
  - `default_value_override: null` correctly produces "no default" (not "inherit").
  - **DB round-trip:** `default_value_overridden = 1, default_value_override = NULL` survives full CRUD cycle without becoming "inherit."
  - **YAML round-trip:** `default_value_override: null` survives load -> edit -> save -> reload without becoming "inherit."
  - **Override removal:** `update-schema` setting an override back to absent correctly reverts the field to global behavior (sets `default_value_overridden = 0`).
  - `closestMatches()` operates on resolved effective values (deduplicated across claiming types), not global values.
  - Migration: existing `true` and `false` flags map correctly to the three-column representation.
  - MERGE_CONFLICT is no longer emitted for override disagreements (cancellation-to-global instead).

---

## Non-goals

- No changes to the field type system (no new field types, no changes to coercion rules).
- No `done_values` integration (out of scope; `done_values` may not ship at all).
- No "extend" or "intersect" override modes — replace only (per-claim level). Multi-type resolution uses valid-for-any-type, not set operations on a synthetic union.
- No stricter multi-type conflict mode beyond cancellation-to-global — if cancellation proves insufficient, a follow-up spec can add explicit conflict errors.
- No changes to `query-nodes` filter semantics. Filters still match on field values directly; the resolved-effective-values logic is purely for validation.
- `description` overrides on claims remain freely overridable as today — pure documentation with no validation impact, so they stay outside the `overrides_allowed` gate.
- No automatic migration of `list<string>` fields to `list<enum>`. Fields that want enum overrides must be explicitly migrated to an enum-compatible type first (see Prerequisite section).

---

## Follow-on work after this lands

### 1. `subtype` field migration and `note` schema update

The driving `note` schema changes require two steps:

**Step 1 — Migrate `subtype` field:**
```
update-global-field subtype:
  list_item_type: enum
  enum_values: [Political Figure, Author, Historical Figure, Businessman, Athlete, Actor, Publication, Company, Political Party, NGO, Government Organization]
  overrides_allowed: { enum_values: true }
```

**Step 2 — Update schemas:**
```yaml
# person schema claim
- field: subtype
  enum_values_override: [Political Figure, Author, Historical Figure, Businessman, Athlete, Actor]

# company schema claim
- field: subtype
  enum_values_override: [Publication, Company, Political Party, NGO, Government Organization]

# note schema, new field_claims
- field: subtype
  enum_values_override: [spec, implementation-plan, bug, observation]
- field: status
  default_value_override: null
```

### 2. `status` field override enablement

The `status` field needs `overrides_allowed.default_value: true` before `note` can override its default:

```
update-global-field status:
  overrides_allowed: { default_value: true }
```

These serve as the integration test for whether the override mechanism works end-to-end in practice.
