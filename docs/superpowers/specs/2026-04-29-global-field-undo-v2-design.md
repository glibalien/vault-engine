# Global-field undo v2 - Design

**Status:** shipped 2026-04-29 via `7ef5f01 feat(undo): add global-field snapshots`
**Date:** 2026-04-29
**Source backlog:** `Vault Engine - Deferred Backlog 2026-04-25`
**Predecessor postmortem:** `docs/superpowers/specs/2026-04-25-bundle-b-postmortem.md`

## Background

Global-field CRUD is the last major schema-surface mutation family outside the undo system. Node tools and schema tools now create undo operations; global-field tools still mutate the DB and render files directly:

- `create-global-field` calls `createGlobalField()` and renders `.schemas/_fields.yaml`.
- `update-global-field` calls `updateGlobalField()`, renders `_fields.yaml`, renders claiming schema YAML, and on confirmed type changes calls `rerenderNodesWithField()`.
- `rename-global-field` calls `renameGlobalField()` and re-renders affected nodes.
- `delete-global-field` calls `deleteGlobalField()`, renders `_fields.yaml`, and renders formerly claiming schema YAML.

Bundle B v1 tried to add this alongside unrelated tool-surface work and was abandoned. The usable decisions from that attempt are:

- Use dedicated global-field undo snapshot tables.
- Capture the global field row plus dependent schema claim rows and node field rows.
- Restore with explicit file re-rendering; DB-only assertions are insufficient.
- Surface `global_field_count` through undo history from the start.

The old blocker, multi-snapshot restore DB atomicity, is no longer current. `restoreOperation` now wraps DB restore work in a transaction and applies file effects after commit (`c78017a fix(undo): make multi-snapshot restore db-atomic`).

## Current facts

### Tables

`global_fields` columns:

- `name`
- `field_type`
- `enum_values`
- `reference_target`
- `description`
- `default_value`
- `required`
- `overrides_allowed_required`
- `overrides_allowed_default_value`
- `overrides_allowed_enum_values`
- `list_item_type`

`schema_field_claims` columns:

- `schema_name`
- `field`
- `label`
- `description`
- `sort_order`
- `required_override`
- `default_value_override`
- `default_value_overridden`
- `enum_values_override`

`node_fields` columns relevant to global-field restore:

- `node_id`
- `field_name`
- `value_text`
- `value_number`
- `value_date`
- `value_json`
- `value_raw_text`
- `source`

`undo_operations` currently has `node_count` and `schema_count`, but no `global_field_count`.

### Rendering helpers

- `renderFieldsFile(db, vaultPath)` renders `.schemas/_fields.yaml`.
- `renderSchemaFile(db, vaultPath, schemaName)` renders one `.schemas/<schema>.yaml`.
- `rerenderNodesWithField(db, writeLock, vaultPath, fieldName, additionalNodeIds, syncLogger)` re-renders nodes that have a field value.
- `restoreOperation()` already has the shape we want: DB changes inside a transaction, file effects accumulated and applied after commit.

## Goal

Add undo support for:

- `create-global-field`
- `update-global-field`
- `rename-global-field`
- `delete-global-field`

Each successful global-field mutation creates an undo operation with one global-field snapshot. Undo restores the pre-mutation global-field state and dependent rows, then re-renders all affected files so the watcher cannot reverse the undo from stale disk content.

## Non-goals

- No new dry-run or preview behavior for global-field tools.
- No per-op `op_index` work for `batch-mutate`.
- No changes to the `update-global-field` discard gate.
- No generic SQL restore framework.
- No schema-level conflict detection beyond existing undo behavior.

## Snapshot model

Add a migration that creates two tables and adds one count column:

```sql
CREATE TABLE IF NOT EXISTS undo_global_field_snapshots (
  operation_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  was_new INTEGER NOT NULL DEFAULT 0,
  was_deleted INTEGER NOT NULL DEFAULT 0,
  was_renamed_from TEXT,
  global_field TEXT,
  schema_claims TEXT NOT NULL DEFAULT '[]',
  node_fields TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (operation_id, field_name),
  FOREIGN KEY (operation_id) REFERENCES undo_operations(operation_id) ON DELETE CASCADE
);

ALTER TABLE undo_operations ADD COLUMN global_field_count INTEGER NOT NULL DEFAULT 0;
```

`global_field`, `schema_claims`, and `node_fields` are JSON-encoded arrays/objects captured from explicit column lists. Do not use `SELECT *`; define shared constants for the column lists in the snapshot module so capture and restore drift loudly together after future migrations.

`field_name` is the post-operation identity for create/update/delete, and the new name for rename. `was_renamed_from` stores the old name for rename restores.

## Capture semantics

Create a new module, `src/undo/global-field-snapshot.ts`.

`captureGlobalFieldSnapshot(db, operation_id, fieldName, opts)` captures the pre-mutation state:

- `was_new: true`: used before `create-global-field`; no existing global field row is required. Restore deletes the created field and dependent rows.
- `was_deleted: true`: used before `delete-global-field`; captures the current global field row, all claims for the field, and all node field values for the field.
- `was_renamed_from`: used before `rename-global-field`; capture the old field name and store the snapshot under the new field name.
- default update mode: used before `update-global-field`; captures the current field row, claims, and node field rows.

For `update-global-field`, capture node field rows even for non-type-change updates. It is cheap enough and avoids subtle misses when enum/list metadata changes alter rendering or validation expectations.

After capture succeeds, set `undo_operations.global_field_count = 1`.

## Restore semantics

Extend `restoreOperation()` with a global-field restore pass, alongside the existing schema and node passes.

Ordering:

1. Restore schema snapshots.
2. Restore global-field snapshots.
3. Restore node snapshots.
4. Mark the operation undone.
5. Apply file effects after commit.

Schema first keeps existing behavior. Global fields before nodes means any later node restore validates against the restored field definitions.

Restore cases:

- `was_new`: delete the current global field row, schema claims for the field, and node field rows for the field.
- `was_deleted`: recreate the global field row, schema claims, and node field rows from the snapshot.
- `was_renamed_from`: delete current rows for the new name, then recreate rows under the old name from the snapshot.
- update: replace the global field row, claims, and node field rows for the field with snapshot contents.

All restore cases should be DB-only inside the transaction. Return file actions to be applied after commit.

## File effects

Global-field undo must render all affected disk files after the DB restore commits:

- Always render `.schemas/_fields.yaml`.
- Render every schema named in the snapshot's `schema_claims`.
- Render every node named in the snapshot's `node_fields`.
- For rename and update, also render nodes currently holding the post-operation field name before restore, because a type-change with `discard_uncoercible: true` can remove rows and a rename moves rows to a different field name.

Implementation can model this as:

```ts
type GlobalFieldRestoreFileAction = {
  renderFieldsCatalog: true;
  schemaNames: string[];
  nodeIds: string[];
};
```

The post-commit renderer should use the same node rendering path as `restoreOperation` uses today for node undo, not `rerenderNodesWithField()` alone, because deleted/restored field rows may no longer be discoverable by field name after restore.

## Tool integration

Wrap the commit path of each MCP handler in undo operation creation:

- `create-global-field`
  - create operation
  - capture snapshot with `was_new: true`
  - call `createGlobalField`
  - render `_fields.yaml`
  - finalize operation

- `update-global-field`
  - preview-only type-change calls (`confirm` omitted) do not create undo operations
  - apply calls create operation, capture update snapshot, call `updateGlobalField`
  - render `_fields.yaml`, claiming schema YAML, and affected nodes as today
  - finalize operation

- `rename-global-field`
  - create operation
  - capture snapshot using old name and `was_renamed_from: old_name`, stored under `new_name`
  - call `renameGlobalField`
  - render `_fields.yaml`, schemas with renamed claims, and affected nodes
  - finalize operation

- `delete-global-field`
  - create operation
  - capture snapshot with `was_deleted: true`
  - snapshot claiming schema names before delete, as today
  - call `deleteGlobalField`
  - render `_fields.yaml` and formerly claiming schemas
  - finalize operation

If a handler throws after `createOperation` but before `finalizeOperation`, the existing orphan undo cleanup path can clean up a `global_field_count=0` operation. If the snapshot has already been written, either finalize or let the operation remain active; do not silently delete evidence of a partial tool failure.

## Undo history

Add `global_field_count` to:

- `UndoOperationRow`
- `list-undo-history` SELECT projection and response shape
- smoke tests that assert undo operation rows

Existing clients tolerate extra response fields under the envelope.

## Tests

Unit tests for `src/undo/global-field-snapshot.ts`:

- capture/restore update round trip restores every `global_fields` column.
- capture/restore delete round trip restores schema claims and node field values.
- capture/restore create undo deletes the created field and dependent rows.
- rename restore returns the old name and removes the new name.
- shared column-list constants cover every current `global_fields`, `schema_field_claims`, and relevant `node_fields` column.

MCP integration tests:

- `create-global-field` appears in `list-undo-history` with `global_field_count=1`; undo removes the field and updates `_fields.yaml`.
- `update-global-field` non-type update undo restores `_fields.yaml` and affected schema YAML.
- `update-global-field` confirmed type change undo restores coerced node values and re-renders affected node markdown.
- `rename-global-field` undo restores DB rows, schema claims, node field names, `_fields.yaml`, schema YAML, and node markdown.
- `delete-global-field` undo restores the field, claims, `_fields.yaml`, and schema YAML; node values remain present and render as claimed again.

Tests must read file contents, not just DB state. The Bundle B v1 postmortem showed DB-only assertions miss the most important failure mode.

## Risks

- **Post-commit file effect failure:** DB restore can commit while rendering fails. This matches current schema/node undo behavior after `c78017a`; surface the error rather than swallowing it.
- **Column drift:** shared column-list constants make migrations fail tests loudly instead of silently losing columns.
- **Type-change data loss undo:** confirmed `discard_uncoercible: true` deletes node field rows. Because the snapshot captures `node_fields` before apply, undo can restore those values.
- **Rename identity confusion:** storing snapshots under the new name with `was_renamed_from` keeps the operation tied to the user-visible mutation while preserving enough data to restore the old name.

## Implementation notes

Prefer a plan with small commits:

1. Migration + type/projection plumbing for `global_field_count`.
2. Snapshot helper and unit tests.
3. Restore pass and post-commit file effects.
4. Tool handler wiring, one tool at a time.
5. End-to-end file-content tests.

Do not bundle unrelated backlog fixes into this branch.
