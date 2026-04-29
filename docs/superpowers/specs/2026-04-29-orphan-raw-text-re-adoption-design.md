# Orphan Raw-Text Re-Adoption

## Problem

Orphan fields preserve `value_raw_text` so wiki-link syntax and aliases can round-trip while the field is unclaimed. When a later schema change claims that field again, the pipeline validates and coerces the structured value, but the old orphan raw text can remain stored beside the coerced value.

That leaves two representations for one claimed field:

- `value_*` columns contain the validated/coerced value.
- `value_raw_text` may still contain stale orphan-era markdown text.

If the field is orphaned again later, rendering can use that stale raw text instead of the current coerced value.

## Rule

`value_raw_text` belongs only to final orphan fields.

When a field is claimed in the final effective schema, successful validation/coercion adopts the structured value and clears any carried raw text for that field. Claimed reference fields continue to render from their typed value via the normal reference renderer. Alias preservation remains an orphan-only behavior.

## Expected Behavior

1. A field can be orphaned with raw text and render that raw text while it remains orphaned.
2. If a schema later claims the field, the pipeline validates/coerces the structured value as usual.
3. The committed `node_fields.value_raw_text` for that claimed field is cleared.
4. If the field is orphaned again, rendering reconstructs from the current typed value rather than resurrecting the old orphan raw text.

## Scope

This is a pipeline persistence invariant. No broad schema refactor is required.

The regression surface is schema-claim propagation because it reloads existing `value_raw_text` from `node_fields` and passes it through `executeMutation`.
