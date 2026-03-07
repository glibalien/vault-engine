# Schema Types + YAML Schema Loader — Design

## Overview

Task 1 of Phase 2. Define TypeScript types for the schema system, build a YAML loader that reads `.schemas/*.yaml` from the vault, resolves `extends` inheritance chains, and stores resolved schemas in the `schemas` DB table.

## Design Decisions

### Resolved

1. **Vault-only schemas** — No built-in/shipped schemas. Users define everything in `.schemas/`. A future `vault-engine init` command can seed starter schemas. Loader reads one directory.

2. **Full reload strategy** — Any change to `.schemas/` triggers reading all YAML files, re-resolving all inheritance, and replacing all rows in the `schemas` table. Schema files are small and few; full reload is trivially fast.

3. **Watcher watches `.schemas/`** — Schema changes picked up automatically. Watcher triggers full schema reload. Nodes are NOT re-validated on schema change — they get re-validated on their next individual re-index.

4. **All-or-nothing reload** — Watcher-triggered reload wraps the full load in try/catch. Success replaces everything. Failure logs the error and the DB retains the complete previous schema set. No partial state.

5. **Separate type systems** — Schema field types (`enum`, `reference`, `list<reference>`, etc.) are schema-level types. The parser's `FieldValueType` stays as-is (describes what was found in the file). Validation (Task 3) bridges the gap.

6. **Parse and store everything** — `SchemaDefinition` includes all YAML properties including `serialization` and `computed`, even though they're not fully used until later phases. No data loss; Phase 3/Task 6 don't need to change the loader.

## TypeScript Types

File: `src/schema/types.ts`

### FieldDefinition

Describes a single field in a schema:

```typescript
interface FieldDefinition {
  type: 'string' | 'number' | 'date' | 'boolean' | 'enum' | 'reference' | 'list<string>' | 'list<reference>';
  required?: boolean;
  default?: unknown;
  values?: string[];          // enum allowed values
  target_schema?: string;     // for reference/list<reference>
}
```

### SchemaDefinition

Raw parsed YAML before inheritance resolution:

```typescript
interface SchemaDefinition {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  fields: Record<string, FieldDefinition>;
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}
```

### ResolvedSchema

After inheritance is resolved — all ancestor fields merged in:

```typescript
interface ResolvedSchema {
  name: string;
  display_name?: string;
  icon?: string;
  extends?: string;
  ancestors: string[];        // base-first resolution order
  fields: Record<string, FieldDefinition>;  // inherited + own, own overrides inherited
  serialization?: {
    filename_template?: string;
    frontmatter_fields?: string[];
  };
  computed?: Record<string, { query: string }>;
}
```

`ancestors` is ordered base-first. For `work-task extends task extends base`: `ancestors: ['base', 'task']`. Fields are applied left-to-right with later entries (closer to the leaf) overriding earlier ones. The leaf schema's own fields override everything.

## Loader

File: `src/schema/loader.ts`

### `loadSchemas(db, vaultPath)`

Main entry point:

1. Glob `.schemas/*.yaml` from vault root
2. Parse each YAML file into `SchemaDefinition`
3. Build dependency graph from `extends` references
4. Detect cycles (error with descriptive message naming the cycle)
5. Topological sort — resolve in dependency order
6. For each schema, merge ancestor fields (base-first) then own fields to produce `ResolvedSchema`
7. Clear `schemas` table, insert all resolved schemas as JSON (full reload)

### `getSchema(db, name)`

Reads one `ResolvedSchema` from the DB by name. Returns `null` if not found.

### `getAllSchemas(db)`

Reads all resolved schemas from the DB.

### Error Handling

- **Cycle detected**: throw `"Schema inheritance cycle: task -> work-task -> task"`
- **Dangling extends**: throw `"Schema 'work-task' extends unknown schema 'task'"`
- **Invalid YAML**: throw with file path and parse error
- **Missing name field**: throw with file path
- **Startup**: errors are fatal — engine shouldn't start with bad schemas
- **Watcher reload**: errors logged, previous schema set kept intact (all-or-nothing)

## Integration Points

- **Startup** (`src/index.ts`): call `loadSchemas(db, vaultPath)` after `createSchema(db)`
- **Watcher** (`src/sync/watcher.ts`): watch `.schemas/*.yaml`, trigger `loadSchemas(db, vaultPath)` on change
- **DB**: uses existing `schemas` table — `name` (PK), `definition` (JSON of `ResolvedSchema`), `file_path` (source YAML path), `updated_at`

## New Files

```
src/schema/
    types.ts      # SchemaDefinition, FieldDefinition, ResolvedSchema
    loader.ts     # YAML loading, inheritance resolution, DB storage
    index.ts      # Re-exports
```

## Testing

Tests in `tests/schema/loader.test.ts` with fixture YAML files:

1. Parse single schema — loads simple YAML, verify `SchemaDefinition` fields
2. Resolve inheritance — `work-task extends task`, verify merged fields, `ancestors: ['task']`
3. Deep inheritance — A extends B extends C, verify `ancestors: ['C', 'B']`, fields resolved base-first
4. Field override — child redefines parent field, child's version wins
5. Cycle detection — A extends B, B extends A -> descriptive error
6. Dangling extends — extends non-existent name -> error
7. DB storage — `loadSchemas` writes to `schemas` table, `getSchema`/`getAllSchemas` read back correctly
8. Full reload — second call replaces previous schemas (removed schema disappears from DB)
9. Empty `.schemas/` dir — no error, clears schemas table
10. Missing `.schemas/` dir — no error, clears schemas table
