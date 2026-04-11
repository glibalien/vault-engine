# Phase 3 Design — Write Path and Rendering

**Date:** 2026-04-11
**Status:** Approved
**Charter reference:** ~/Documents/archbrain/Notes/Vault Engine - Charter.md
**Phase 2 spec:** docs/superpowers/specs/2026-04-11-phase2-design.md
**Implementation notes:** docs/superpowers/specs/2026-04-11-phase3-implementation-notes.md

## How to use this spec

Every implementation question should be checked against the principles in Section 1 before proceeding. If a principle and a later section conflict, the principle wins and the section is wrong. This is the same rule the charter applies to itself: principles are foundational, everything else is downstream.

## Overview

Phase 3 delivers the write path: deterministic rendering, mutation tools, the watcher write-back loop, schema change propagation, and schema/global field rendering to disk. At the end of Phase 3, the engine is a fully functional bidirectional sync system — the minimum shippable product.

At the end of Phase 3: the engine reads, validates, writes, and renders. The canonical sync loop works end to end.

---

## Section 1: Operational Principles

Phase 2's three principles remain in force: the indexer mirrors without consulting schemas, derived conformance facts are query-time joins, and the global field pool is source of truth for field shape. Where Phase 3 introduces apparent tensions with Phase 2 principles (e.g., schema change propagation materializes field values on nodes, which might look like it contradicts "derived facts are query-time"), the relevant Phase 3 section resolves the tension explicitly.

Six rules that govern every Phase 3 design decision:

**1. One pipeline, two entry points, one set of rules.** Every write — whether initiated by an MCP tool call or absorbed from a watcher-detected file edit — flows through the same pipeline: validate → coerce → reconcile → apply → render → write. There is no parallel code path for "this is a tool call so we skip rendering" or "this is a watcher event so we skip validation." The pipeline is the pipeline. The two entry points differ in how they *acquire input* (tool calls receive structured parameters; the watcher parses a file and diffs against DB state) and how they *handle errors at the end* (Principle 2). Everything between input acquisition and error handling is shared.

**2. Tools reject; the watcher absorbs.** When the pipeline produces `valid: false`, the two entry points diverge:

- **Tool-initiated writes** return the validation errors to the caller. The write does not proceed. The agent sees the issues and can fix the input or fix the schema. The tool's response contains the full `ValidationResult` so the agent has complete information.
- **Watcher-initiated writes** absorb what they can. The file is already on disk in the new state — the engine cannot "reject" it without creating a DB/disk divergence. Values that pass validation are committed to the DB. Values that fail validation are discarded and the previous DB value is retained. Every discarded or coerced value is logged to the edits log. The file is then re-rendered from the resulting DB state.

This asymmetry is inherent to the two input sources, not a per-issue-type decision. It applies uniformly to all validation issues (`TYPE_MISMATCH`, `REQUIRED_MISSING`, `ENUM_MISMATCH`, `MERGE_CONFLICT`, etc.).

**3. The write lock depends on rendering determinism.** The renderer is a pure function: given identical DB state, it produces identical bytes. The write lock relies on this: the engine renders, computes a hash, writes the file, and the watcher compares the on-disk hash against the expected hash to know whether an external edit occurred. If determinism breaks, the write lock breaks, and re-index loops follow. Any code path that introduces non-determinism in rendering (timestamps, random IDs, map iteration order, floating-point formatting differences) is a bug.

**4. Merge conflicts don't block writes.** When the validation engine encounters a `MERGE_CONFLICT` on semantic metadata (`required`, `default_value`), the write still proceeds for values the engine is confident about. Specifically: provided values for conflicted fields are validated against the global field definition (which can't conflict, because field type is global) and written with `source: 'provided'`. Unprovided values for conflicted fields are omitted — the engine can't determine the correct default or required status. When types agree that a field is required but disagree on the default, and no value is provided, both `REQUIRED_MISSING` and `MERGE_CONFLICT` are surfaced. The conflict is reported in the validation result's `issues` array and logged to the edits log. This applies identically to tool and watcher paths. It is not an exception to Principle 2: the value itself isn't invalid (field type is global and unambiguous), so tools don't reject it; the watcher writes it normally. The conflict is a schema-design problem reported for the agent to resolve, not a per-write blocking condition.

**5. Data is never silently deleted; the edits log explains every deviation.** This is the charter's principle made operational for the write path. When the engine changes, discards, or omits a value during a write, the edits log records what happened, why, and what the original value was. The edits log records only writes where the engine's output differs from the input. It is not an activity log — a clean write where all values are accepted unchanged produces no log entry. A coerced write (value transformed) produces an entry. A rejected write (value discarded, old DB value retained) produces an entry. A conflicted write (merge conflict on metadata) produces an entry.

**6. Every write ends with a canonical re-render.** After the pipeline commits changes to the DB, the affected node is re-rendered from DB state and written to disk. This applies even when the engine accepted every value unchanged — the re-render canonicalizes formatting (YAML style, field order, reference syntax) and ensures the on-disk file matches what the engine would produce. The hash check prevents unnecessary disk I/O: if the rendered bytes match the file already on disk, no write occurs. This is what makes the watcher's absorb-then-re-render loop safe: the re-rendered file is canonical, its hash matches the engine's expectation, and the watcher ignores it.

---

## Section 2: Deterministic Renderer

*Governed by Principle 3: The write lock depends on rendering determinism. Governed by Principle 6: Every write ends with a canonical re-render.*

The renderer is a pure function: given a node's DB state, it produces the canonical markdown bytes for that node. It is the inverse of the parser+indexer pipeline. The parser strips structure from markdown into data; the renderer assembles data back into markdown.

Two properties, stated separately because they serve different purposes:

**Determinism:** The same DB state always produces the same bytes. This is what makes the write lock safe — the engine can predict the hash of what it just wrote.

**Idempotency:** Rendering a node that was already in canonical form produces identical bytes to what's on disk. This is what prevents unnecessary disk writes — the hash check detects "nothing changed" and skips the write. Determinism is necessary for idempotency but not sufficient; idempotency also requires that the renderer's formatting choices match the parser's expectations (the round-trip contract).

### Phase 3 indexer changes required by the renderer

The renderer depends on one indexer change. This is a prerequisite for the renderer, not an afterthought.

**`value_raw_text` column on `node_fields`.** Populated unconditionally by the indexer when the original string value contained `[[...]]` patterns that the parser strips. "Unconditionally" means for any field, regardless of whether it is currently claimed by a schema — claim status is a query-time derived fact (Phase 2 Principle 2) and the indexer does not consult `global_fields` or `schemas`. A field that is claimed today may be an orphan tomorrow; unconditional population prevents retroactive bracket loss.

Migration: conditional `ALTER TABLE` in the Phase 3 upgrade path, same pattern as Phase 2 migrations. Existing rows get `value_raw_text = NULL` (no backfill — orphan brackets were already lost for previously indexed data; the fix applies to future indexing only).

```sql
ALTER TABLE node_fields ADD COLUMN value_raw_text TEXT;
```

### Interface

```typescript
interface RenderInput {
  title: string;
  types: string[];
  fields: Record<string, unknown>;        // field values from DB (reconstructed)
  body: string;
  fieldOrdering: FieldOrderEntry[];        // resolved ordering from merge algorithm
  referenceFields: Set<string>;            // fields whose values need [[wiki-link]] wrapping
  listReferenceFields: Set<string>;        // list fields whose elements need [[wiki-link]] wrapping
  orphanRawValues: Record<string, string>; // field → value_raw_text for orphans with wiki-links
}

interface FieldOrderEntry {
  field: string;
  category: 'claimed' | 'orphan';
}

function renderNode(input: RenderInput): string;  // returns complete file content
```

The caller (write pipeline, Section 5) is responsible for loading DB state and computing the field ordering. The renderer does not query the DB — it is a pure transformation from structured input to string output.

### Value reconstruction from DB columns

Before rendering, the pipeline reconstructs JS values from `node_fields` typed columns. This is the inverse of the indexer's `classifyValue`:

| DB state | Reconstructed value |
|----------|-------------------|
| `value_json` is not null | `JSON.parse(value_json)` (boolean, array, object, or null) |
| `value_number` is not null | the number directly |
| `value_date` is not null | the date string directly |
| `value_text` is not null | the string directly |
| all null | `null` |

Priority: `value_json` > `value_number` > `value_date` > `value_text`. This is an **indexer invariant**: the indexer guarantees exactly one typed column is populated per row (or all null for explicit null). The renderer trusts this invariant. If multiple columns are populated (database corruption or manual edit), the priority order above is the tiebreaker and the renderer logs a warning — but this is a defensive measure, not an expected code path.

**Date handling:** Under YAML 1.2 (the `yaml` package's default, which the parser uses without overriding), date-like strings (`2026-04-11`) are parsed as strings, not Date objects. They are stored in `value_text` and round-trip without special handling. The `value_date` column is effectively unused by the current parser but retained in the reconstruction priority for safety. See implementation notes (note 4) for the full verification.

### YAML frontmatter serialization

The renderer uses the `yaml` package's `stringify()` function (same package the parser uses for `parse()`). Empirically verified configuration for deterministic round-trip:

```typescript
import { stringify } from 'yaml';

const YAML_OPTIONS = {
  indent: 2,
  lineWidth: 0,             // no line wrapping — preserves long values
  defaultKeyType: 'PLAIN',   // unquoted keys unless quoting is required
  defaultStringType: 'PLAIN', // unquoted strings unless quoting is required
};
```

**`lineWidth: 0`** disables line wrapping. YAML line-folding would produce valid YAML but inconsistent formatting that harms determinism and readability in Obsidian.

**YAML version:** The parser uses the `yaml` package's default (YAML 1.2). The renderer uses the same default. No explicit `version` option is passed to either `parse()` or `stringify()`. YAML 1.2 does not auto-parse date-like strings or `yes`/`no` as typed values, which eliminates an entire class of round-trip problems. The spec commits to YAML 1.2 behavior for both parsing and serialization.

### Frontmatter structure and field ordering

The frontmatter is assembled as a plain object with insertion-order keys (JavaScript preserves insertion order for string keys). The order is:

1. **`title`** — always first
2. **`types`** — always second
3. **Claimed fields** — in the order specified by `fieldOrdering` (resolved from `sort_order` across all claiming schemas, with ties broken by field name ascending in Unicode codepoint order)
4. **Orphan fields** — after all claimed fields, sorted in Unicode codepoint order by field name

Orphan sort is Unicode codepoint order (JavaScript's default string comparison), not locale-aware collation. This is deterministic across all environments without ICU dependency. Documented explicitly because locale-aware sorting would break determinism on machines with different locale settings.

**Fields with `null` values are omitted from the frontmatter.** A field present in the DB with a null value (all typed columns are null) is not rendered. This matches the parser's behavior: absent keys parse as missing, not as null. `null` is deletion intent (established in Phase 2 Section 5). If a required field is null, that's a validation error caught upstream — the renderer doesn't validate, it serializes.

**Fields excluded by merge-conflict omission:** When the write pipeline omits a conflicted field because no value was provided and the default is ambiguous (Principle 4, Section 1), the field is absent from `RenderInput.fields` entirely. The renderer never sees it. The pipeline owns the omission decision; the renderer serializes what it's given.

### Wiki-link re-wrapping

The parser strips `[[...]]` brackets from field values during parsing (frontmatter.ts line 67). Wiki-links are stored separately in the `relationships` table. The renderer must re-wrap reference-typed field values.

**Claimed fields:** For each field in `referenceFields`, wrap the string value: `value` → `[[value]]`. For each field in `listReferenceFields`, wrap each list element. The `referenceFields` and `listReferenceFields` sets are computed by the caller from the global field pool: any field with `field_type = 'reference'` or (`field_type = 'list'` and `list_item_type = 'reference'`).

**Orphan fields:** Orphan fields have no global field definition, so the renderer cannot determine whether to re-wrap from type information. Instead, the renderer checks `orphanRawValues`: if the field has an entry, the raw text (with original `[[...]]` brackets intact) is used instead of the reconstructed value. If the field has no entry in `orphanRawValues`, the reconstructed value from the typed column is used as-is.

**Alias handling — claimed vs orphan asymmetry:** For claimed reference fields, aliases are lost. The parser stores the canonical target; the renderer re-wraps as `[[target]]` without alias. This is a known canonicalization. For orphan fields with `value_raw_text`, the original alias syntax (`[[target|alias]]`) is preserved because the raw text is used verbatim. This asymmetry is intentional: claimed fields have a well-defined serialization format from the global field pool; orphan fields preserve whatever the user wrote.

### Types field serialization

`types` is always serialized as a YAML block sequence, even for single-type nodes:

```yaml
types:
  - task
```

The parser accepts both scalar (`types: task`) and list forms as input. The renderer always outputs block list format. This is a canonicalization.

### String quoting

The `yaml` package handles quoting automatically under YAML 1.2 defaults. Under YAML 1.2, date-like strings and `yes`/`no` are not auto-parsed as typed values, so they don't need protective quoting. The renderer does not add manual quoting logic.

If edge cases arise where the `yaml` package's automatic quoting is insufficient (strings that parse differently after a round-trip), those are bugs to be caught by the round-trip test suite and fixed with targeted quoting rules. The spec does not pre-commit to a manual quoting table — it commits to the round-trip contract, and individual quoting fixes are implementation details.

### Body content

The body is appended after the closing `---` verbatim. The file structure is:

```
---\n{YAML frontmatter}---\n{body}
```

Where `{YAML frontmatter}` is the output of `yaml.stringify()` (which includes a trailing newline) and `{body}` is the raw body string from the DB.

The parser's `splitFrontmatter` strips exactly one `\n` after the closing `---` (the delimiter newline). The renderer format above produces this same structure: the `---\n` accounts for the delimiter newline, and the body follows immediately. Verified empirically: `splitFrontmatter('---\n' + yaml + '---\n' + body).body === body` for all tested cases (standard body, no blank line, empty body, blank line before content). See implementation notes (note 7).

**Empty body:** If the body is empty string, the file ends with `---\n`. No trailing content.

### Content hash

The content hash is computed over the rendered bytes (the complete file string). Algorithm: SHA-256, hex-encoded. Same `sha256()` function the indexer uses. The hash serves two purposes:

1. **Write-lock comparison:** After writing a file, the engine stores the hash. When the watcher detects a change, it hashes the file and compares. If hashes match, the watcher skips the file (the engine wrote it).
2. **Unnecessary-write prevention:** Before writing, the engine hashes the current file on disk. If the rendered hash matches the on-disk hash, no write occurs (Principle 6 optimization).

### Round-trip contract

The correctness invariant:

```
render(loadFromDB(node)) → file_content
parse(file_content) → ParsedNode
store(ParsedNode) → DB state
loadFromDB(node) → identical to original input (modulo known canonicalizations)
```

**Known canonicalizations** (round-trip changes that are intentional, not bugs):
- `types: task` (scalar) → `types:\n  - task` (list)
- Field order normalized to schema-defined order + alphabetical orphans
- Whitespace normalization in YAML formatting
- Wiki-link aliases stripped on claimed reference fields (`[[target|alias]]` → `[[target]]`); aliases preserved on orphan fields via `value_raw_text`

These canonicalizations are the reason Principle 6 requires a re-render after every write: the first render after a human edit may change formatting, and the resulting hash becomes the new canonical hash the watcher checks against.

---

## Section 3: Write Lock

*Governed by Principle 3: The write lock depends on rendering determinism. Governed by Principle 6: Every write ends with a canonical re-render.*

### Design overview

The hash check is the durable protection against re-index loops. The write lock is a narrow race-condition guard.

The watcher already compares the on-disk file hash against `nodes.content_hash` (watcher.ts lines 64-75). When they match, the watcher skips the file. This means: if the engine writes a file and updates `content_hash` in the DB, the watcher will see the hashes match and do nothing. No re-index loop.

The lock's job is to guard the window between "file written to disk" and "DB transaction committed with new content_hash." During this window, the watcher could see the new file but the old hash, triggering a spurious re-index. The lock prevents this by making the watcher skip the file entirely while the window is open.

### Atomic file writes

All engine-initiated file writes use write-to-temp-then-rename. The engine writes rendered content to a temp file (in `.vault-engine/tmp/`), then renames to the target path. `rename(2)` is atomic on POSIX filesystems within the same mount. This eliminates partial-write failures — the file is either fully written (rename succeeded) or not updated at all.

### Hash-after-write sequence

The write pipeline performs these steps under the lock:

```
1. Acquire lock for file path
2. Render node to string, compute SHA-256 hash
3. Write rendered string to temp file
4. Rename temp file to target path          ← file on disk is now canonical
5. Commit DB transaction (node_fields,      ← DB now matches file
   nodes.content_hash = rendered hash)
6. Release lock
```

Steps 3-5 are the critical section the lock guards. The lock is held across both the file write and the DB commit so the watcher never sees a state where the file is new but the hash is old.

**Transaction boundary:** The DB transaction is opened before step 2 (the pipeline needs to read current DB state to render) and committed at step 5. The rendered content is computed within the transaction's read snapshot, ensuring consistency between what's rendered and what's committed.

### Failure ordering and recovery

**Crash after step 4, before step 5 (file written, DB not committed).** The file on disk is canonical — fully rendered from valid DB state. The DB still has the old state. On restart, the reconciler re-indexes the file, finds the hash doesn't match `content_hash`, and re-indexes. The re-index stores the same data the failed transaction would have committed. Self-healing.

**Crash after step 3, before step 4 (temp file written, not renamed).** The target file is unchanged. The temp file is orphaned in `.vault-engine/tmp/`. On startup, the engine cleans up `.vault-engine/tmp/` (delete all files). No data loss, no inconsistency.

**Crash during step 5 (DB commit fails after file written).** SQLite WAL mode makes partial commits impossible — the transaction either commits fully or rolls back. If rollback: same as "crash after step 4" — file is ahead of DB, reconciler heals on restart.

File-first ordering (write file, then commit DB) is chosen over DB-first because the user always sees correct content in their editor, even if the engine crashes. The reverse would leave the user seeing stale content until the reconciler runs.

### Lock granularity

Per-file path. Each file path is locked independently. Concurrent writes to different files are not blocked. The write pipeline acquires one lock per file it writes. `batch-mutate` (Section 6) acquires locks for all affected files. Schema change propagation (Section 9) acquires locks sequentially as it renders each affected node.

### Stale lock recovery

The lock is in-memory only (`Set<string>`). If the process crashes while a lock is held, the lock evaporates with the process. On restart, no stale locks exist. This is correct because:

- The hash check is the durable protection, not the lock
- Crash recovery is handled by the failure ordering above (file-first, reconciler heals)

No file-based lock files, no lock timeouts, no lock cleanup.

### Watcher behavior on locked files

Skip, not queue. If the watcher's debounce fires and the file is locked, the event is dropped (watcher.ts line 61). This is safe because:

- The write pipeline will update the DB and the hash. The watcher doesn't need to re-index.
- If the file changes again after the lock is released (another external edit), chokidar fires a new event.

### Schema file locking

Schema YAML files (`.schemas/*.yaml`) use the same write lock mechanism. The watcher skips `.schemas/` entirely (Section 10), so the lock does not guard against watcher re-indexing for schema files. The lock IS load-bearing for schema files in a different way: it guards against concurrent schema renders within the engine. If two MCP tool calls trigger schema changes that both need to re-render the same schema YAML file, the lock serializes those writes. In practice, MCP tool calls are serialized by the transport layer, but the lock makes the guarantee explicit rather than relying on an implementation detail of the transport.

### Interface

```typescript
export class WriteLockManager {
  private locks = new Set<string>();

  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    this.locks.add(filePath);
    try {
      return await fn();
    } finally {
      this.locks.delete(filePath);
    }
  }
}
```

The type signature is unchanged from Phase 1. The **caller contract** changes in Phase 3: the function passed to `withLock` must perform both the file write (temp + rename) and the DB commit before returning. The lock must be held across both operations. Calling `withLock` for only the file write — releasing the lock before the DB commit — defeats the race-condition guard and reintroduces the re-index window.

---

## Section 4: Edits Log

*Governed by Principle 5: Data is never silently deleted; the edits log explains every deviation.*

The edits log records writes where the engine's output differs from the input. It is the user's audit trail for "what happened to my edit" — when the engine coerces, rejects, or omits a value, the log explains why. It is not an activity log of all engine operations.

### Existing schema

The `edits_log` table exists from Phase 1:

```sql
CREATE TABLE IF NOT EXISTS edits_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT
);
```

Phase 3 does not alter this schema. The existing columns are sufficient: `event_type` discriminates the entry kind, `details` is a JSON text blob whose shape varies by event type, `node_id` identifies the affected node (nullable for system-level events), `timestamp` is Unix epoch milliseconds.

### Existing event types (Phase 1, unchanged)

| Event type | Source | Purpose |
|---|---|---|
| `file-indexed` | indexer | Node was indexed (created or updated) |
| `file-deleted` | indexer | Node file was removed from vault |
| `index-error` | indexer | Error during indexing |
| `reconciler-sweep` | reconciler | Full sweep completed with stats |

These are operational events. Phase 3 does not modify or remove them.

### Phase 3 event types

Phase 3 adds deviation events — entries that record when the engine's output differs from its input during a write. These are the events Principle 5 requires.

**`value-coerced`** — A field value was transformed during validation. The coerced value was written; the original was not.

```typescript
{
  event_type: 'value-coerced',
  node_id: string,
  details: {
    source: 'tool' | 'watcher',
    field: string,
    original_value: any,
    coerced_value: any,
    coercions: Array<{
      step: string,   // human-readable: "string → number", "enum case normalization"
      code: string,   // machine-queryable: "STRING_TO_NUMBER", "ENUM_CASE_MATCH"
    }>,
    node_types: string[]
  }
}
```

The `coercions` array captures multi-step transformations. A single value can go through multiple coercion steps (e.g., `string → number` then `single value → list wrapping`). Each step has a human-readable `step` description and a stable machine-queryable `code`. Codes are identifiers agents and scripts can filter on; step descriptions are for human log readers.

Coercion codes (closed list, extended as new coercions are added):

| Code | Step description |
|---|---|
| `STRING_TO_NUMBER` | string → number |
| `STRING_TO_DATE` | string → date |
| `STRING_TO_BOOLEAN` | string → boolean |
| `STRING_TO_ENUM` | string → enum (case/whitespace normalization) |
| `STRING_TO_REFERENCE` | string → reference (wiki-link wrapping) |
| `NUMBER_TO_STRING` | number → string |
| `DATE_TO_STRING` | date → string |
| `SINGLE_TO_LIST` | single value → list wrapping |
| `LIST_ELEMENT_COERCION` | list element coerced (details in step text) |

**`value-rejected`** — A field value failed validation and was discarded. Only logged for the watcher path — tool-path rejections are returned to the caller as errors and not logged (the tool response IS the record).

```typescript
{
  event_type: 'value-rejected',
  node_id: string,
  details: {
    source: 'watcher',
    field: string,
    rejected_value: any,
    retained_value: any | null,   // previous DB value, or null if field was new
    reason_code: string,           // validation issue code
    reason: string,                // human-readable message
    node_types: string[]
  }
}
```

Reason codes include all validation issue codes (`TYPE_MISMATCH`, `ENUM_MISMATCH`, `COERCION_FAILED`, `LIST_ITEM_COERCION_FAILED`) plus one edits-log-specific code:

- **`EXPLICIT_NULL_OVERRIDE`** — The user provided explicit `null` for a field that has a default value. The null suppressed the default (Phase 2 spec: null is deletion intent). If the field is required, this also triggers `REQUIRED_MISSING` in the validation result. Logged as `value-rejected` because the user's intent (null) prevented the normal default-application path — the log records that the default was available but not applied, and what happened as a result.

**`merge-conflict`** — A write encountered a merge conflict on field metadata. Logged for both tool and watcher paths. **One entry per (field, property) pair.** A field conflicting on both `required` and `default_value` produces two entries.

```typescript
{
  event_type: 'merge-conflict',
  node_id: string,
  details: {
    source: 'tool' | 'watcher',
    field: string,
    property: 'required' | 'default_value',
    conflicting_claims: Array<{ type: string; value: any }>,
    resolution: 'value_written' | 'field_omitted',
    value_written?: any,          // present only when resolution is 'value_written'
    node_types: string[]
  }
}
```

**`field-defaulted`** — A field was missing and a default value was applied. Logged because the engine added a value the user didn't provide — a deviation from input.

```typescript
{
  event_type: 'field-defaulted',
  node_id: string,
  details: {
    source: 'tool' | 'watcher',
    field: string,
    default_value: any,
    default_source: 'global' | 'claim',
    node_types: string[]
  }
}
```

`default_source` indicates where the default came from: `'global'` for the global field definition's `default_value`, `'claim'` for a schema claim's `default_value` override (including cases where multiple claims agree and the merge resolves to their shared value).

**`fields-orphaned`** — Fields became orphans as a result of a type removal or schema change. Logged once per operation with all affected fields, not once per field.

```typescript
{
  event_type: 'fields-orphaned',
  node_id: string,
  details: {
    source: 'tool' | 'watcher',
    trigger: string,             // e.g., "remove-type-from-node: meeting"
    orphaned_fields: string[],
    node_types: string[]         // types AFTER the change
  }
}
```

**`parse-error`** — The watcher encountered malformed YAML frontmatter. For existing nodes, DB state is preserved; for new files, a minimal node is created.

```typescript
{
  event_type: 'parse-error',
  node_id: string | null,    // existing node ID, or null for new files
  details: {
    source: 'watcher',
    file_path: string,
    error: string,            // the parse error message
    db_state: 'preserved' | 'created-minimal'
  }
}
```

**`schema-file-render-blocked`** — A schema YAML file was externally edited. The engine refused to overwrite it. The DB operation committed; the file stays in the user's edited state.

```typescript
{
  event_type: 'schema-file-render-blocked',
  node_id: null,
  details: {
    file_path: string,
    expected_hash: string,
    found_hash: string,
    resolution: "Delete the file to let the engine re-create it, or restore it to its canonical content. The schema change has been applied to the database."
  }
}
```

**`schema-file-delete-blocked`** — A schema was deleted from the DB but the corresponding YAML file was externally edited. The file was not deleted.

```typescript
{
  event_type: 'schema-file-delete-blocked',
  node_id: null,
  details: {
    file_path: string,
    expected_hash: string,
    found_hash: string,
    resolution: "The schema was deleted from the database but the file was externally edited and was not deleted. Delete it manually if no longer needed."
  }
}
```

### What is NOT logged

- **Clean writes.** A write where all values are accepted unchanged produces no log entry. The write itself is visible in `nodes.indexed_at`; the edits log adds nothing.
- **Tool-path rejections.** When a tool call fails validation, the error is returned to the caller. No log entry — the tool response is the record. Logging it would duplicate information the agent already has.
- **Schema CRUD operations.** Creating, updating, or deleting schemas and global fields are not logged to the edits log. These are MCP tool calls with structured responses. The edits log is for deviations during writes, not for recording every mutation.
- **Successful coercions that don't change the value.** If a value validates without transformation, no entry. The `changed: true` flag on `CoercedValue` determines whether a `value-coerced` entry is created.

### Logging responsibility

The write pipeline (Section 5) is responsible for writing edits log entries. It has access to the full `ValidationResult` including `coerced_state` (with `changed` flags and `original` values) and `issues`. The pipeline iterates these and writes log entries for deviations.

Edits log writes are part of the same DB transaction as the node mutation. If the transaction rolls back, the log entries roll back too. This ensures the log never records a deviation that didn't actually happen.

### Retention

The edits log grows indefinitely. No automatic rotation or truncation in Phase 3. The table is append-only and queryable by `node_id` and `timestamp`.

A future `edits-log` MCP tool (charter lists it under Introspection, Phase 7) will provide querying. For Phase 3, the log is write-only from the engine's perspective — the user can query it directly via SQLite if needed.

If the log grows large enough to affect performance (unlikely for a single-user system), a manual `DELETE FROM edits_log WHERE timestamp < ?` is the escape valve. The spec does not build automatic retention because the threshold is unknowable and the cost of keeping entries is negligible.

---

## Section 5: Write Pipeline Architecture

*Governed by Principle 1: One pipeline, two entry points, one set of rules. Governed by Principle 2: Tools reject; the watcher absorbs.*

The write pipeline is the single code path through which every mutation flows. It composes the validation engine (Phase 2), the renderer (Section 2), the write lock (Section 3), and the edits log (Section 4) into a unified pipeline. This section defines the pipeline stages, the data that flows between them, and where the two entry points (tools and watcher) diverge.

### Pipeline input: ProposedMutation

Both entry points produce a `ProposedMutation` before entering the pipeline. Everything after this point is shared.

```typescript
interface ProposedMutation {
  source: 'tool' | 'watcher';
  node_id: string | null;           // null for create-node
  file_path: string;                 // vault-relative path
  title: string;
  types: string[];
  fields: Record<string, unknown>;   // proposed field values
  body: string;
  raw_field_texts?: Record<string, string>;  // watcher path: pre-stripped text for wiki-link fields
}
```

**Tool entry point:** The tool handler constructs a `ProposedMutation` from the tool's parameters. For `create-node`, `node_id` is null and `file_path` is derived from the title (or a filename template if the type has one). For `update-node`, the handler loads the current DB state, applies the requested changes, and produces a mutation representing the full proposed state — not a delta. `raw_field_texts` is absent for tool-originated mutations (tools provide structured values, not raw text).

**Watcher entry point:** The watcher parses the edited file, diffs against current DB state (Section 8 defines the diff), and produces a `ProposedMutation` representing the full proposed state of the node as parsed from the file. `raw_field_texts` is populated from the parser's pre-wiki-link-stripping output.

**Relationships are not part of `ProposedMutation`.** They are derived in Stage 6 from the final validated state — frontmatter reference field values produce typed relationships, body wiki-links are re-extracted via `extractBodyWikiLinks()`. Deriving in Stage 6 guarantees relationships reflect the coerced/retained values, not the raw proposed values.

### Tool-block predicate

A named predicate determines whether tool-path writes are blocked:

```typescript
function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some(i => i.severity === 'error' && i.code !== 'MERGE_CONFLICT');
}
```

Tool writes proceed when the only error-severity issues are `MERGE_CONFLICT` (Principle 4: merge conflicts are schema-design problems, not bad data). All other error-severity issues block the write. This predicate has a single definition; all tool handlers use it. If future issue codes should also be non-blocking, they are added here.

### Pipeline stages

The DB transaction spans Stages 1–6. The write lock spans Stages 5–6.

```
ProposedMutation
    ↓
╔══ DB Transaction ════��══════════════════════════════════════╗
║                                                             ║
║  ┌─ Stage 1: Load schema context ────────────────────────┐  ║
║  │  Load claims-by-type, global field definitions        │  ║
║  │  from DB for the proposed types                       │  ║
║  └───────────────────────────────────────────────────────┘  ║
║      ↓                                                      ║
║  ┌─ Stage 2: Validate and coerce ────────────────────────┐  ║
║  │  validateProposedState(fields, types, claims, globals) │  ║
║  │  → ValidationResult                                    │  ║
║  └───────────────────────────────────────────────────────┘  ║
║      ↓                                                      ║
║  ┌─ Stage 3: Source-specific error handling ──────────────┐  ║
║  │  Tool: hasBlockingErrors? → rollback, return errors    │  ║
║  │  Watcher: partition into accepted/rejected,            │  ║
║  │           merge with retained DB values                │  ║
║  └───────────────────────────────────────────────────────┘  ║
║      ↓                                                      ║
║  ┌─ Stage 4: Compute final state ────────────────────────┐  ║
║  │  Field ordering, reference sets, orphan raw values     │  ║
║  │  → RenderInput                                         │  ║
║  └───────────────────────────────────────────────────────┘  ║
║      ↓                                                      ║
║  ╔══ Write Lock ════════════════════════════════════════╗    ║
║  ║                                                      ║    ║
║  ║  ┌─ Stage 5: Render ─────────────────────────────┐   ║    ║
║  ║  │  renderNode(input) → file content              │   ║    ║
║  ║  │  sha256(content) → rendered hash               │   ║    ║
║  ║  │  Hash match? → rollback, return (no-op)        │   ║    ║
║  ║  └────────────────────────────────────────────────┘   ║    ║
║  ║      ↓                                                ║    ║
║  ║  ┌─ Stage 6: Write ──────────────────────────────┐   ║    ║
║  ║  │  Write temp file, rename to target             │   ║    ║
║  ║  │  Commit DB: nodes, types, fields, rels, log   │   ║    ║
║  ║  └────────────────────────────────────────────────┘   ║    ║
║  ║                                                      ║    ║
║  ╚══════════════════════════════════════════════════════╝    ║
║                                                             ║
╚═════════════════════════════════════════════════════════════╝
    ↓
  Return result to caller
```

The DB transaction is opened at Stage 1 and ensures schema context consistency: the claims and global fields read in Stage 1 are guaranteed to be the same at commit time in Stage 6. SQLite WAL mode allows concurrent readers during the write transaction, so query tools are not blocked.

The write lock is acquired at Stage 5 (Render), not Stage 1. The lock guards file writes and the DB commit, not DB reads. Holding the lock during Stages 1–4 would serialize all mutations even when they affect different files.

### Stage 1: Load schema context

Same data-loading pattern as the `validate-node` tool handler. For each type in `proposed.types`:

1. Query `schema_field_claims` to get claims
2. Collect all referenced field names from claims
3. Load `global_fields` rows for those names via `getGlobalField()`

This produces `claimsByType: Map<string, FieldClaim[]>` and `globalFields: Map<string, GlobalFieldDefinition>` — the inputs to `validateProposedState`.

Types without schemas contribute no claims. This is normal — many types exist without schema definitions, and the pipeline handles them (all fields become orphans, validation is trivially successful).

### Stage 2: Validate and coerce

Calls `validateProposedState(proposed.fields, proposed.types, claimsByType, globalFields)`. This is the Phase 2 validation engine, with the Phase 3 merge-conflict recovery (Principle 4): provided values for conflicted fields are validated against the global field definition and included in `coerced_state` with `source: 'provided'`.

The output is `ValidationResult`:
- `coerced_state`: every field value the engine is confident about, classified by source
- `issues`: every validation problem found
- `orphan_fields`: field names not claimed by any type
- `effective_fields`: the merged field set (partial if conflicts exist)
- `valid`: true iff no error-severity issues

### Stage 3: Source-specific error handling

This is the only stage where the two entry points diverge.

**Tool path (`source === 'tool'`):**

If `hasBlockingErrors(issues)`, the pipeline rolls back the DB transaction and returns the full `ValidationResult` as an error response. No DB mutation, no file write, no edits log entry.

If no blocking errors, the pipeline proceeds. `coerced_state` is the final field state. If `MERGE_CONFLICT` issues exist, they are included in the success response as non-blocking warnings.

**Watcher path (`source === 'watcher'`):**

The pipeline always proceeds, regardless of `valid`. The watcher partitions the result into accepted and rejected fields, then merges accepted values with retained DB values for rejected fields.

**Retained-DB-value lookup:** For each field in `proposed.fields` that produced a validation error and is NOT in `coerced_state` (meaning coercion failed entirely):

1. Query `node_fields` for the field: `SELECT value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ? AND field_name = ?`
2. **If a row exists:** Reconstruct the value using the standard priority order (Section 2). This value replaces the rejected proposed value in the final state. The existing `value_raw_text` is carried forward alongside the retained typed-column values.
3. **If no row exists:** The field was newly added by the human edit and failed validation. The field is omitted from the final state entirely — there is no previous value to retain, and the invalid value cannot be written. The proposed value is still captured in the `value-rejected` edits log entry's `rejected_value` field, with `retained_value: null`.

**Edits log entries generated in Stage 3 (watcher path):**
- One `value-rejected` entry per rejected field (captures `rejected_value` — the human's original edit — and `retained_value` — the DB value that was kept, or null)
- One `value-coerced` entry per coerced field with `changed: true`
- One `field-defaulted` entry per field where a default was applied
- `merge-conflict` entries per Section 4 rules

These entries are accumulated and written to the DB in Stage 6 (within the transaction).

### Stage 4: Compute final state

Given the final field values (from Stage 3), assemble the `RenderInput` (Section 2):

1. **Field ordering:** Walk `effective_fields` in resolved order (by `resolved_order`, ties broken by field name in Unicode codepoint order). Claimed fields first, orphans appended in Unicode codepoint order by field name.

2. **Reference field sets:** From `globalFields`, compute `referenceFields` (fields with `field_type = 'reference'`) and `listReferenceFields` (fields with `field_type = 'list'` and `list_item_type = 'reference'`).

3. **Orphan raw values:** For each orphan field in the final state, look up `value_raw_text`. The source depends on how the value arrived:
   - **Parser-originated (watcher accepted):** `value_raw_text` comes from `proposed.raw_field_texts[fieldName]`, populated by the parser's pre-stripping output.
   - **Tool-originated:** `value_raw_text` is null. Tools provide structured values; reference rendering uses the `referenceFields` set, not raw text.
   - **Retained from DB (watcher rejected):** `value_raw_text` comes from the existing `node_fields` row, loaded in Stage 3's retained-value query.

4. **Assemble `RenderInput`:** `{ title, types, fields: finalFields, body, fieldOrdering, referenceFields, listReferenceFields, orphanRawValues }`.

### Stage 5: Render

Call `renderNode(input)` (Section 2) to produce the file content string. Compute `sha256(content)` for the content hash.

**No-op write rule:** If the file already exists on disk, hash the current file content. If the rendered hash matches the on-disk hash, the write is a complete no-op:

- No file write occurs
- No DB changes are committed (the transaction is rolled back)
- No edits log entries are written
- The pipeline returns with `file_written: false`

This is a complete rule, not an optimization. If the rendered output is byte-identical to what's on disk, the DB state already matches the rendered state (Principle 3: determinism means same DB state → same bytes). Committing changes would update `indexed_at` unnecessarily and could produce spurious edits log entries. Rollback is the correct behavior.

For `create-node` (no file on disk yet), the no-op check is skipped — the file doesn't exist, so there's nothing to compare against.

### Stage 6: Write

Within the write lock (acquired at Stage 5):

1. **Write file to disk:** Write rendered content to temp file in `.vault-engine/tmp/`, rename to target path (Section 3: atomic file writes).

2. **Commit DB transaction:**
   - Upsert `nodes` row: `title`, `body`, `content_hash` (rendered hash), `file_mtime`, `indexed_at`
   - Delete and reinsert `node_types` rows for this node
   - Delete and reinsert `node_fields` rows from the final state. Each value is classified via `classifyValue`. `value_raw_text` is populated per the provenance rule in Stage 4. `source` column is `'frontmatter'` (matching existing indexer convention).
   - Delete and reinsert `relationships` rows. Derived from the final state:
     - For each claimed reference field in the final field values: `relationship(source_id, target=fieldValue, rel_type=fieldName, context=fieldName)`
     - For each orphan field with `value_raw_text`: extract wiki-links from the raw text using the `WIKILINK_RE` pattern, create relationships with `rel_type=fieldName`
     - For body wiki-links: `extractBodyWikiLinks(proposed.body)` → relationships with `rel_type='wiki-link'` or field name if the context matches a field name
   - Write accumulated edits log entries (from Stage 3)
   - Update FTS index (delete old entry, insert new)

3. **Release write lock.**

### Transaction boundaries

**Single-node mutations** (`create-node`, `update-node`, `delete-node`, watcher write-back): one DB transaction per node spanning Stages 1–6, committed within the write lock.

**Multi-node mutations** (`rename-node` updating wiki-link references, `batch-mutate`, schema change propagation): one DB transaction covering all affected nodes. Write locks are acquired for all affected file paths before the first file write. Files are written to temp files first, then all renames happen, then the DB transaction commits. Atomic from the DB perspective (one commit); nearly atomic from the filesystem perspective (individual renames are atomic, sequence is not).

If any file rename fails mid-sequence, the transaction rolls back. Successfully renamed files are reverted (renamed back from the target to a recovery location). The temp files serve as rollback points.

### Pipeline function signature

```typescript
interface PipelineResult {
  node_id: string;
  validation: ValidationResult;
  rendered_hash: string;
  edits_logged: number;               // count of edits log entries created
  file_written: boolean;              // false if hash matched (no-op)
}

function executeMutation(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  mutation: ProposedMutation,
): PipelineResult;
```

The pipeline is one function. The `source` field on `ProposedMutation` controls Stage 3 behavior. Tool handlers call it and check for errors in the result; the watcher calls it and ignores validation results (they're handled internally in Stage 3).

Throws on tool-path blocking errors (the caller catches and returns the error response to the agent). Returns `PipelineResult` on success.

### Data flow summary

| Stage | Input | Output | Modules used |
|---|---|---|---|
| 1 | ProposedMutation.types | claimsByType, globalFields | global-fields/crud, DB queries |
| 2 | fields, types, claims, globals | ValidationResult | validation/validate |
| 3 | ValidationResult, source, DB state | final fields + edits log entries | pipeline logic, DB queries |
| 4 | final fields, effective_fields, globalFields | RenderInput | pipeline logic |
| 5 | RenderInput, on-disk hash | file content, rendered hash (or no-op) | renderer, sha256 |
| 6 | file content, final DB state, log entries | committed DB + file on disk | write-lock, DB, fs |

---

## Section 6: Mutation Tools

*Governed by Principle 1: One pipeline, two entry points. All mutation tools use the tool entry point of the write pipeline (Section 5).*

Each mutation tool is a thin handler that constructs a `ProposedMutation`, calls `executeMutation`, and formats the result. The pipeline does the work; the tool does the wiring.

Phase 3 delivers five mutation tools: `create-node`, `update-node`, `delete-node`, `rename-node`, `batch-mutate`. The charter's `add-relationship` / `remove-relationship` are dropped from Phase 3 — see implementation notes (note 17) for the rationale. Relationships are derived state in this architecture; they're managed through `update-node` with reference-typed fields or body edits.

### Node identity resolution

All mutation tools that operate on existing nodes accept `node_id`, `file_path`, or `title` as the identifier, matching `get-node`'s resolution pattern:

```typescript
const nodeIdentifier = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
};
```

Exactly one must be provided. Resolution uses the existing `resolveTarget` five-tier matching (file_path → title → basename → case-insensitive → NFC-normalized). If resolution is ambiguous (multiple matches), the tool returns `AMBIGUOUS_MATCH` with the candidates. If no match, `NOT_FOUND`.

Factored into a shared `resolveNodeIdentity(db, params)` function used by all mutation tools.

### `create-node`

Creates a new node and writes it to disk.

**Parameters:**

```typescript
{
  title: z.string(),
  types: z.array(z.string()).default([]),
  fields: z.record(z.string(), z.unknown()).default({}),
  body: z.string().default(''),
  path: z.string().optional(),  // explicit vault-relative directory; default: vault root
}
```

**Path derivation:**

1. If `path` is provided: `{path}/{title}.md`
2. If the node has exactly one type with a schema that has a `filename_template`: evaluate the template. Template syntax is `{variable_name}` where variables are resolved from: `title`, `date` (current date as `YYYY-MM-DD`), and field values by name. If any variable is unresolved (not in the available values), the tool returns `INVALID_PARAMS` with reason code `MISSING_TEMPLATE_VARIABLE` naming the unresolved variable.
3. Otherwise: `{title}.md` at the vault root.

**Conflict check:** If the derived file path already exists on disk or in the DB, the tool returns `INVALID_PARAMS` with the conflicting node's details. No overwrite, no automatic suffixing.

**Pipeline call:** Constructs a `ProposedMutation` with `source: 'tool'`, `node_id: null`, the derived `file_path`, and the provided `title`, `types`, `fields`, `body`. Calls `executeMutation`.

**Response:**

```typescript
{
  node_id: string;
  file_path: string;
  title: string;
  types: string[];
  coerced_state: Record<string, CoercedValue>;
  issues: ValidationIssue[];  // merge conflicts only (blocking errors prevent reaching here)
  orphan_fields: string[];
}
```

### `update-node`

Updates an existing node. Two modes: single-node and query-mode bulk update.

**Single-node parameters:**

```typescript
{
  // identity (exactly one required)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  // updates (all optional, at least one required)
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),     // replaces entire types array
  set_fields: z.record(z.string(), z.unknown()).optional(),  // patch semantics
  set_body: z.string().optional(),               // replaces entire body
  append_body: z.string().optional(),            // appends to body
}
```

**Field merge semantics (`set_fields`):** Patch, not replace. The tool loads the node's current fields from the DB, merges `set_fields` on top:

- New keys are added
- Existing keys are overwritten with the new value
- Keys with value `null` are removed (null is deletion intent, consistent with the validation engine)
- Absent keys retain their current value

The merged result is the full proposed field state passed to the pipeline. **Fields in `set_fields` that are not claimed by any schema become orphans** — this is not an error. The pipeline classifies them as orphans (source: `'orphan'`) and they pass through validation unchanged. This matches the charter's principle that unknown fields are preserved, not rejected.

`set_types` is a full replacement because type order matters (it affects merge presentation metadata) and partial type operations have their own tools (Section 7).

`set_body` and `append_body` are mutually exclusive. `append_body` appends the string to the current body with a `\n\n` separator (if the body is non-empty) or sets the body directly (if the body is empty).

**Response shape:** Same as `create-node`.

**Query-mode bulk update:**

```typescript
{
  query: {
    types: z.array(z.string()).optional(),
    where: z.record(z.string(), z.unknown()).optional(),  // field filters
  },
  set_fields: z.record(z.string(), z.unknown()),
  dry_run: z.boolean().default(false),
}
```

Queries nodes matching the filter (using the same query engine as `query-nodes`), then applies `set_fields` to each matched node.

**`dry_run: true`:** Runs the full pipeline through Stage 2 (validate and coerce) for each matched node but does not commit. Returns the preview:

```typescript
{
  dry_run: true;
  matched: number;
  would_update: number;
  would_skip: number;
  would_fail: number;
  details: Array<{
    node_id: string;
    title: string;
    coerced_state: Record<string, CoercedValue>;
    issues: ValidationIssue[];
  }>;  // capped at 50 entries
}
```

**`dry_run: false` (default):** Applies `set_fields` to every matched node in a single multi-node transaction (Section 5). Returns:

```typescript
{
  dry_run: false;
  matched: number;
  updated: number;
  skipped: number;         // nodes where set_fields produced no change (no-op rule)
  errors: Array<{ node_id: string; issues: ValidationIssue[] }>;
}
```

If any node fails validation (`hasBlockingErrors`), the entire batch rolls back. The per-node errors tell the agent which nodes have problems.

Query-mode does not support `set_title`, `set_types`, `set_body`, or `append_body` — these are inherently per-node operations.

**Mutual exclusion:** The two parameter sets (node identity vs `query`) are mutually exclusive. Providing both is `INVALID_PARAMS`.

### `delete-node`

Deletes a node and its file from disk.

**Parameters:**

```typescript
{
  // identity (exactly one required)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  confirm: z.boolean().default(false),
  referencing_nodes_limit: z.number().default(20),
}
```

**Two-step flow:**

Without `confirm: true`, returns a preview:

```typescript
{
  preview: true;
  node_id: string;
  file_path: string;
  title: string;
  types: string[];
  field_count: number;
  relationship_count: number;      // outgoing relationships from this node
  incoming_reference_count: number; // other nodes referencing this one
  referencing_nodes: Array<{       // capped at referencing_nodes_limit
    node_id: string;
    title: string;
    field: string;                 // field name or 'wiki-link' for body references
  }>;
  warning: string | null;  // non-null when incoming references exist
}
```

The `referencing_nodes_limit` parameter controls how many referencing nodes are returned in the preview. Default 20 is a reasonable page size for the agent to present to the user. The agent can request more if needed by passing a higher limit.

With `confirm: true`, the deletion proceeds:

1. Delete the file from disk (under write lock)
2. In the DB transaction: delete from `nodes` (CASCADE handles `node_fields`, `node_types`, `relationships` where `source_id` matches)
3. Log `file-deleted` to edits log
4. Incoming relationships from other nodes are **not modified** — they become dangling references. Consistent with the charter: dangling references are valid, resolution is query-time, references store raw target strings not foreign keys.

**Response on confirm:**

```typescript
{
  deleted: true;
  node_id: string;
  file_path: string;
  dangling_references: number;
}
```

### `rename-node`

Renames a node: updates file path, title, and all wiki-link references vault-wide.

**Parameters:**

```typescript
{
  // identity (exactly one required)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  // new identity
  new_title: z.string(),
  new_path: z.string().optional(),  // new vault-relative directory; default: same directory
}
```

**Reference update algorithm:**

The rename updates all references vault-wide that resolve to the node being renamed. The algorithm uses full five-tier resolution in reverse:

1. Query all distinct `target` values from `relationships`
2. For each unique target, run `resolveTarget(db, target)`. If it resolves to the node being renamed, collect that target string
3. For each collected target string, find all nodes that have relationships with that target (the referencing nodes)
4. For each referencing node, update references:
   - **Frontmatter reference fields:** The field value (stored as stripped target string) is updated from old to new title. The pipeline re-renders the node, re-wrapping in `[[...]]` per the renderer's reference field handling.
   - **Body wiki-links:** String replacement in the body text. `[[Old Title]]` → `[[New Title]]`. `[[Old Title|display text]]` → `[[New Title|display text]]` (alias preserved). The replacement is applied to all matching link syntaxes found by the resolver, including case-insensitive and basename matches.

This is O(distinct_targets) resolver calls. For a 7k-node vault (~20k relationships), this completes in well under a second. No indexed `resolved_target_node_id` column — that's a future optimization (Model B from the resolver comments) if performance demands it.

**Operations (single multi-node transaction):**

1. Derive new file path. If `new_path` provided, `{new_path}/{new_title}.md`. Otherwise, `{current_dir}/{new_title}.md`. Conflict check same as `create-node`.
2. Rename the file on disk (under write lock for both old and new path).
3. Update `nodes.file_path`, `nodes.title` in DB.
4. Re-render the renamed node at the new path.
5. For each referencing node: update field values and body text, re-render, write to disk.
6. Commit DB transaction.

All re-renders happen within one transaction with write locks held for all affected files.

**Response:**

```typescript
{
  node_id: string;
  old_file_path: string;
  new_file_path: string;
  old_title: string;
  new_title: string;
  references_updated: number;  // count of referencing nodes re-rendered
}
```

### `batch-mutate`

Executes multiple mutation operations atomically.

**Parameters:**

```typescript
{
  operations: z.array(z.object({
    op: z.enum(['create', 'update', 'delete']),
    params: z.record(z.string(), z.unknown()),
  })),
}
```

Each operation's `params` matches the individual tool's parameters, without `confirm` (batch-mutate is inherently confirmed) and without `dry_run`.

**Semantics:**

- All operations execute within a single multi-node DB transaction.
- Operations execute in array order. Later operations can reference nodes created by earlier operations — the resolver sees in-progress creates within the transaction because SQLite transaction isolation makes earlier writes visible to later reads within the same transaction.
- If any operation fails validation (`hasBlockingErrors`), the entire batch rolls back. No partial application.
- Write locks are acquired for all affected file paths before the first file write.
- `rename-node` is not supported in `batch-mutate`. Renames have vault-wide reference-update side effects that interact unpredictably with other operations in the batch. Use `rename-node` standalone.

**Response on success:**

```typescript
{
  applied: true;
  results: Array<{
    op: string;
    node_id: string;
    file_path: string;
    coerced_state?: Record<string, CoercedValue>;
    issues?: ValidationIssue[];
  }>;
}
```

**Response on failure:**

```typescript
{
  applied: false;
  failed_at: number;  // 0-indexed position of the failed operation
  error: {
    op: string;
    issues: ValidationIssue[];
  };
}
```

### Shared patterns

**Error codes:** All mutation tools use the existing `toolErrorResult(code, message)`. Codes: `NOT_FOUND`, `INVALID_PARAMS`, `AMBIGUOUS_MATCH`, `VALIDATION_FAILED` (new — wraps the `ValidationResult` for pipeline rejections).

**Node identity:** Factored into `resolveNodeIdentity(db, params)` returning `{node_id, file_path, title}` or an error.

---

## Section 7: Type Assignment Tools

*Governed by Principle 1: One pipeline. Both tools construct a `ProposedMutation` and call `executeMutation`.*

Two tools for explicit type management: `add-type-to-node` and `remove-type-from-node`. These exist as dedicated tools rather than being subsumed by `update-node`'s `set_types` because they have distinct semantics: `add-type-to-node` triggers automatic field addition from schema claims, and `remove-type-from-node` triggers field orphaning with a confirmation gate. `set_types` on `update-node` replaces the entire types array and feeds the result through the pipeline — it doesn't have special add/remove logic.

### `add-type-to-node`

Adds a type to a node, automatically populating claimed fields.

**Parameters:**

```typescript
{
  // identity (exactly one required)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
}
```

**Behavior:**

1. Resolve the node. Load current types, fields, body from DB.
2. If the node already has this type, return success with `already_present: true` and no changes.
3. Append the new type to the node's types array.
4. **Run the full merge algorithm** on the complete new type set (all existing types plus the new one). This produces the effective field set with resolved defaults, or merge conflicts if the new type's claims conflict with existing types' claims. The merge algorithm (Phase 2 Section 4) is the single source of truth for default resolution — looking up defaults directly from the new type's claim would ignore conflicts with existing types.
5. For each field in the effective field set that the node does not currently have a value for:
   - If `resolved_default_value` is non-null: populate with the default.
   - Otherwise: omit (null values are not rendered per Section 2).
6. For each field the node already has a value for (from another type's claim, or as an orphan): **re-adopt** — the existing value is kept unchanged. This is the re-adoption behavior described in the charter: an orphan field matching a new claim becomes claimed again automatically. No validation is run against the re-adopted value in this step — the pipeline's Stage 2 validates the complete state.
7. If the merge produced conflicts, conflicted fields receive no default (Principle 4: the engine can't determine the correct default when claims disagree). The conflicts appear in the response.
8. Construct a `ProposedMutation` with the updated types and fields. Call `executeMutation`.

**Response:**

```typescript
{
  node_id: string;
  file_path: string;
  types: string[];             // full types array after addition
  added_fields: string[];      // fields populated from defaults
  readopted_fields: string[];  // orphan fields re-adopted by the new type's claims
  issues: ValidationIssue[];   // merge conflicts, if any
  already_present: boolean;
}
```

### `remove-type-from-node`

Removes a type from a node, orphaning its exclusively-claimed fields.

**Parameters:**

```typescript
{
  // identity (exactly one required)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  confirm: z.boolean().default(false),
}
```

**Behavior:**

1. Resolve the node. Load current types, fields from DB.
2. If the node doesn't have this type, return `NOT_FOUND` with a message.
3. Compute the resulting types array (current types minus the removed type).
4. **If the resulting types array is empty and `confirm` is not true**, return a preview instead of proceeding:

```typescript
{
  preview: true;
  node_id: string;
  file_path: string;
  current_types: string[];
  removing_type: string;
  resulting_types: [];           // empty
  would_orphan_fields: string[];
  warning: "Removing this type leaves the node with no types. All fields will become orphans."
}
```

5. If `confirm: true` or the resulting types array is non-empty, proceed. Determine which fields become orphans: fields claimed by the removed type's schema that are NOT claimed by any remaining type's schema. These fields are not deleted — their values remain in `node_fields` intact. Their classification changes from claimed to orphan at query time (Phase 2 Principle 2).
6. Construct a `ProposedMutation` with the updated types and current fields (unchanged). Call `executeMutation`. The pipeline re-validates with the new type set — some fields that were claimed are now orphans, which the pipeline handles normally (orphans pass through with `source: 'orphan'`).

**No data deletion.** The charter is explicit: "Removing a type leaves the fields behind as orphans." The field values are preserved. The only structural change is the types array. The re-render moves newly-orphaned fields to the orphan section of the frontmatter (after claimed fields, alphabetical order per Section 2).

A `fields-orphaned` edits log entry (Section 4) is written if any fields were orphaned, with `trigger: "remove-type-from-node: {type}"`.

**Response (on execution):**

```typescript
{
  node_id: string;
  file_path: string;
  types: string[];               // full types array after removal
  orphaned_fields: string[];     // fields that became orphans due to this removal
  edits_logged: number;
}
```

### Relationship to `update-node` with `set_types`

`update-node` with `set_types` replaces the entire types array. It does NOT auto-populate defaults for newly-claimed fields and does NOT require confirmation for typeless results. It constructs a `ProposedMutation` with the new types and existing fields, and the pipeline validates and renders. Fields becoming orphaned or claimed is a natural consequence of the type change, handled by query-time classification.

The difference: `add-type-to-node` runs the merge to fill defaults. `remove-type-from-node` gates on the typeless edge case. `set_types` is the raw operation — full types array replacement with no special logic. The dedicated tools add the safety and convenience that make type management a first-class workflow rather than a raw mutation.

This asymmetry — thin tools wrapping the same pipeline but adding workflow-specific logic at the input boundary — is the pattern Principle 1 enables. The pipeline is one code path; the tools shape what enters it.

---

## Section 8: Watcher Write-Back

*Governed by Principle 1: One pipeline, two entry points. The watcher is the second entry point. Governed by Principle 2: The watcher absorbs. Governed by Principle 6: Every write ends with a canonical re-render.*

The watcher detects human edits to `.md` files and feeds them into the write pipeline (Section 5) as the watcher entry point. This section defines the watcher-specific concerns: how a file change event becomes a `ProposedMutation`, what diff is computed against current DB state, and how the watcher composes with the existing debounce and mutex infrastructure.

### What changes from Phase 1

In Phase 1, the watcher calls `indexFile()` — it parses the file and stores the raw parsed state in the DB. No validation, no coercion, no re-rendering.

In Phase 3, the watcher calls the write pipeline instead. The file is parsed, the parsed state is diffed against the current DB state, a `ProposedMutation` is constructed (including default population for newly-added types), and `executeMutation` validates, coerces, commits, and re-renders.

### Watcher flow

```
chokidar detects file change (add | change)
    ↓
shouldIgnore(relPath)?  → skip
    ↓
writeLock.isLocked(absPath)?  → skip
    ↓
Debounce (500ms default, 5s max-wait)
    ↓
Hash check: sha256(file) === nodes.content_hash?  → skip     ← outside mutex
    ↓
mutex.run(async () => {
    ↓
  ┌─ Parse ────────────────────────────────────────────────┐
  │  Read file, parseMarkdown(raw, filePath) → ParsedNode   │
  │  If parseError: handle per parse-error rules, return     │
  └────────────────────────────────────────────────────────┘
    ↓
  ┌─ Diff + default population ──���─────────────────────────┐
  │  Load current DB state for this node                    │
  │  Detect type additions → populate defaults              │
  │  Produce ProposedMutation                               │
  └────────────────────────────────────────────────────────┘
    ↓
  ┌─ Pipeline ─────────────────────────────────────────────┐
  │  executeMutation(db, writeLock, vaultPath, mutation)     │
  │  → validates, coerces, commits, re-renders               │  ← in-pipeline
  │  (includes Stage 5 no-op check as correctness guarantee) │     hash check
  └────────────────────────────────────────────────────────┘
})
```

The existing infrastructure (debounce, max-wait, mutex, write-lock check) is unchanged. Phase 3 replaces what happens inside `mutex.run()`.

**Hash check and mutex relationship:** The pre-pipeline hash check (watcher.ts lines 64-75) runs OUTSIDE the mutex for performance — most events are rejected here without acquiring the mutex. The pipeline's no-op rule (Section 5, Stage 5) runs INSIDE the mutex and DB transaction. The outer check is an optimization; the inner check is the correctness guarantee. Both are needed: the outer check avoids mutex contention for unchanged files; the inner check catches the race where a file changes between the outer check and pipeline execution.

### Parse errors

If `parseMarkdown` returns a `parseError` (malformed YAML frontmatter):

**Existing node (found in DB by file_path):** The DB state is left untouched. The node's types, fields, relationships, and body are preserved exactly as they were before the parse error. A `parse-error` edits log entry is written recording the file path and error message. The file on disk is NOT re-rendered — the user is mid-edit and the engine should not interfere.

**New file (no existing node):** Fall back to Phase 1 indexer behavior — create a minimal node with no types, no structured fields, the entire file content as body, and the parse error recorded. A `parse-error` edits log entry is written.

**Rationale:** The user is mid-edit. Their YAML is temporarily broken (missing colon, unclosed quote, etc.). Wiping the existing node's structured state to body-only would destroy types, fields, and relationships that were valid moments ago. Leaving DB state untouched during the broken-YAML window preserves the user's data. When the user fixes the YAML and saves again, the watcher parses successfully and runs the full pipeline.

### The diff: parsed state vs DB state

The diff determines what changed between the file on disk and the current DB state. It produces a `ProposedMutation` representing the full new state of the node, including defaults for newly-added types.

**Loading current DB state:**

```typescript
interface CurrentNodeState {
  node_id: string;
  title: string;
  types: string[];
  fields: Record<string, unknown>;  // reconstructed from typed columns
  body: string;
  raw_field_texts: Record<string, string>;  // value_raw_text for existing fields
}
```

Loaded via the same queries as `get-node` (node row, node_types, node_fields with all typed columns plus `value_raw_text`).

**For existing nodes (node found in DB by file_path):**

1. Compare `parsed.types` against `currentState.types` to detect type additions.
2. For each newly-added type (present in parsed, absent in current): run the merge algorithm on the full new type set, populate defaults for newly-claimed fields that the node doesn't have a value for — same logic as `add-type-to-node` (Section 7, steps 4-7). Defaults are merged into the proposed fields.
3. Construct the mutation:

```typescript
{
  source: 'watcher',
  node_id: currentState.node_id,
  file_path: relPath,
  title: parsed.title ?? currentState.title,
  types: parsed.types,
  fields: { ...parsedFields, ...populatedDefaults },
  body: parsed.body,
  raw_field_texts: extractRawFieldTexts(rawContent, parsed),
}
```

The populated defaults are included in `fields` before the mutation enters the pipeline. `field-defaulted` edits log entries are written for each default populated (via the pipeline's normal logging in Stage 3/6).

**For new files (no node in DB with this file_path):**

Same as above but with `node_id: null` and no current state to diff against. Type-addition default population still applies (all types are "newly added" for a new file).

**For deleted files (unlink event):**

Handled separately — not a `ProposedMutation`. The watcher deletes the node from the DB (same as Phase 1: `deleteNodeByPath`). No pipeline involvement.

### Extracting raw field texts

The `raw_field_texts` map provides `value_raw_text` values for the pipeline (Section 5, Stage 4). It's extracted by re-parsing the frontmatter YAML without wiki-link stripping:

```typescript
function extractRawFieldTexts(
  rawContent: string,
  parsed: ParsedNode,
): Record<string, string> {
  const { yaml: yamlStr } = splitFrontmatter(rawContent);
  if (!yamlStr) return {};
  const rawParsed = parseYaml(yamlStr) as Record<string, unknown>;
  
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(rawParsed)) {
    if (key === 'title' || key === 'types') continue;
    if (typeof rawValue === 'string' && rawValue.includes('[[')) {
      result[key] = rawValue;
    }
    if (Array.isArray(rawValue)) {
      const hasLinks = rawValue.some(v => typeof v === 'string' && String(v).includes('[['));
      if (hasLinks) {
        result[key] = JSON.stringify(rawValue);
      }
    }
  }
  return result;
}
```

This is a second YAML parse of the same frontmatter, without wiki-link processing. The alternative would be modifying the main parser to optionally return pre-stripped values alongside stripped values, which would complicate `ParsedNode`'s interface and every caller that uses it for a concern that is watcher-specific. The second parse is fast (YAML parsing is microseconds for typical frontmatter) and keeps the concern contained in the watcher module.

### Type changes via frontmatter editing

A human can change a node's types by editing the `types:` field in frontmatter. The watcher treats this as part of the normal diff:

- **Adding a type by editing frontmatter:** The diff detects the new type, runs the merge algorithm, populates defaults for newly-claimed fields — same behavior as `add-type-to-node`. The user gets the same result regardless of whether they add a type via the MCP tool or by editing the file.

- **Removing a type by editing frontmatter:** Fields that were claimed exclusively by the removed type become orphans. A `fields-orphaned` edits log entry is written. No confirmation gate — the human already made the edit and saved; the engine absorbs it. This is Principle 2: the watcher cannot gate because the file is already on disk.

- **Changing types to empty:** All fields become orphans. Absorbed without confirmation (unlike `remove-type-from-node` which gates on this for tool callers).

### The re-render and its visible effects

After the pipeline commits, the file is re-rendered from DB state (Principle 6). The user may see their file change on disk moments after they save. Visible effects include:

- **Field reordering** to schema-defined order
- **YAML formatting canonicalization** (indentation, quoting, block style)
- **Coerced values** (e.g., `"TODO"` → `"todo"` for case-insensitive enum matching)
- **Rejected values reverted** (failed validation → previous DB value retained)
- **Wiki-link re-wrapping** on reference fields
- **Types normalized** to block list format
- **Defaults populated** for newly-added types

All deviations are explained by the edits log (Section 4).

### No-op behavior on the watcher path

Two cases, clearly separated:

**Case 1: File unchanged from canonical state.** The pre-pipeline hash check catches this: `sha256(file) === nodes.content_hash`. The watcher skips the file entirely. No mutex acquired, no parse, no pipeline. This is the common case for engine-initiated writes that the watcher sees — the write lock may have already released, but the hash matches.

**Case 2: File changed, but pipeline produces the same DB state.** The user edited the file, but after validation and coercion the result is identical to what was already in the DB (e.g., the user changed a value and the engine coerced it back). The pipeline's Stage 5 renders from the new DB state and compares the hash against the on-disk file. The on-disk file was edited by the user (different formatting or values), so the hashes won't match — the pipeline writes the canonical rendering back to disk. Edits log entries for coercions and rejections are committed because the pipeline ran and deviations occurred. The re-render may change the file back to its pre-edit state, which is correct behavior documented by the edits log.

### Reconciler integration

The reconciler (Phase 1: periodic full vault sweep) also receives the Phase 3 upgrade. In Phase 1 it calls `fullIndex()`. In Phase 3, the reconciler performs the same parse-diff-pipeline flow as the watcher for each file whose mtime has changed since last index.

The reconciler serves two purposes:
1. **Safety net for dropped watcher events.** Chokidar occasionally loses events under load. The reconciler catches files that changed but weren't processed.
2. **Offline absorption.** Files created or modified while the engine was stopped (e.g., during a restart or system downtime) are processed on the next reconciler sweep.

The reconciler does NOT re-render files whose hashes match (no-op rule). It only processes files where the on-disk hash differs from `nodes.content_hash`. This keeps the periodic sweep fast.

### Files the watcher skips

The existing `shouldIgnore()` function skips:
- Non-`.md` files
- `.sync-conflict-*` files
- Paths containing `.vault-engine`, `.schemas`, `.git`, `.obsidian`, `.trash`, `node_modules`

Phase 3 adds no new ignore rules. `.schemas` was already in the ignore list (Phase 1), confirming the watcher skips schema YAML files (Section 10: schema YAML is one-way).

---

## Section 9: Schema Change Propagation

*Governed by Phase 2 Principle 2: Derived facts are query-time, never materialized. Phase 3 does not violate this — propagation writes new field values (data), not derived classification facts (orphan/claimed status remains query-time).*

Schema change propagation is the bridge between Phase 2's "schemas are metadata-only" and Phase 3's "the engine writes back." In Phase 2, changing a schema immediately changes what `get-node` reports (via cheap joins) but doesn't touch node data. In Phase 3, certain schema changes also modify node data and re-render affected files.

### The distinction: what propagates vs what doesn't

**Changes that propagate (modify node data or rendered file content):**

| Operation | Effect on nodes |
|---|---|
| `update-schema`: add a field claim | Populate default on affected nodes (via merge algorithm) |
| `update-schema`: remove a field claim | Re-render (field moves to orphan section) |
| `update-schema`: change claim metadata (sort_order, label) | Re-render (field order/presentation changes) |
| `rename-global-field` | Update `node_fields.field_name`, re-render |
| `update-global-field`: type change with `confirm: true` | Coerce values in `node_fields`, re-render |

**Changes that don't propagate (query-time effects only):**

| Operation | Why no propagation |
|---|---|
| `create-schema` | Cheap joins immediately reflect the new schema; no data to change |
| `delete-schema` | Node types untouched, orphan-ness emergent via query-time joins |
| `create-global-field` | No nodes have this field from the pool yet |
| `delete-global-field` | `node_fields` untouched, orphan-ness emergent |
| `update-global-field`: non-type-change metadata (description, required, per_type_overrides_allowed, enum_values, default_value) | These affect future validation/query results, not stored node data. Notably, changing `required` or `default_value` on a global field does NOT retroactively populate or remove values on existing nodes — it changes what `validate-node` reports and what defaults future writes use. |

### Propagation trigger: update-schema with field_claims changes

When `update-schema` is called with a new `field_claims` array, the tool diffs the old claims against the new claims:

**Added claims** (field in new claims, not in old claims):

For each node of this type (queried from `node_types`):
1. If the node already has a value for this field: no data change (re-adoption — the existing value becomes claimed).
2. If the node does not have a value: resolve the default via the **merge algorithm** on the node's full type set. Run `mergeFieldClaims` for the node's types, extract `resolved_default_value` for this field. If non-null, populate the field. If the merge produces a conflict on this field's default (another type disagrees), no default is populated (Principle 4).
3. Re-render the node.

Default resolution uses the merge algorithm per-node, the same rule as `add-type-to-node` and the watcher path. There is one rule for default resolution across all entry points. Since many nodes of the same type have the same type combination, the merge result is cached by type-set (sorted types array as cache key) to avoid redundant computation across hundreds of nodes.

**Removed claims** (field in old claims, not in new claims):

No data change. Field values remain in `node_fields`. Classification changes from claimed to orphan at query time. Re-render needed: the field moves from the claimed section to the orphan section.

For each affected node: re-render. Write a `fields-orphaned` edits log entry.

**Changed claim metadata** (sort_order, label, description, required, default_value):

Presentation changes (sort_order, label, description) require re-render only.

Semantic changes (required, default_value) don't propagate to node data — they affect future validation, not stored values.

Re-render all affected nodes.

### Propagation trigger: rename-global-field

Already handled at the DB level by Phase 2's `renameGlobalField()`: updates `global_fields.name`, `node_fields.field_name`, `schema_field_claims.field`.

Phase 3 adds: re-render every node that has a `node_fields` row with the renamed field.

### Propagation trigger: update-global-field type change

Already handled at the DB level by Phase 2's `updateGlobalField()` with `confirm: true`: coerces values in `node_fields`, orphans uncoercible values.

Phase 3 adds: re-render every affected node.

### Propagation mechanics

Propagation uses a subset of the write pipeline's stages. It does NOT use the full pipeline because there is no user input to validate or accept/reject. The full pipeline's Stage 2 (validation of proposed values) and Stage 3 (source-specific error handling) exist to handle the gap between what a user proposed and what the engine accepts. Propagation has no user input — it's the engine applying changes to its own committed data. The parts of the pipeline that handle user input don't apply. The parts that compute structure and render do apply.

The propagation render path for each affected node:

1. Load the node's full DB state (types, fields, body)
2. Run the merge algorithm on the node's types → effective field set
3. Compute field ordering, reference sets, orphan raw values → `RenderInput`
4. `renderNode(input)` → file content string
5. Hash-compare against on-disk file
6. If changed: write via temp-file-and-rename under write lock

### Transaction boundaries and rollback

**Single atomic transaction.** The schema change and all node re-renders happen in one DB transaction. If any step fails, the entire transaction rolls back.

**File rollback on failure.** If the transaction rolls back after some files have already been written, those file writes must be reverted. The approach: before each file write during propagation, back up the existing file content to `.vault-engine/tmp/`. If the transaction commits successfully, delete the backups. If the transaction rolls back, restore each file from its backup.

This is more implementation work than waiting for the reconciler to fix stale files, but it produces a correct state immediately. The reconciler is a safety net for rare edge cases, not the primary recovery mechanism for a structured operation like propagation.

**Write locks:** Acquired sequentially, one per affected file, during the re-render pass. Not held simultaneously across all files. The issue with acquiring all locks upfront (as `batch-mutate` does) is that propagation can affect an unbounded number of nodes — holding hundreds of locks simultaneously is impractical. Sequential lock-per-file is safe because propagation runs within the mutex (no concurrent watcher events) and within a single DB transaction (no concurrent schema changes).

### Propagation response

The schema/global-field MCP tool responses are extended:

```typescript
// update-schema response addition
{
  propagation: {
    nodes_affected: number;
    nodes_rerendered: number;
    defaults_populated: number;
    fields_orphaned: number;
  }
}

// rename-global-field response addition
{
  nodes_rerendered: number;
}

// update-global-field type change response addition
{
  nodes_rerendered: number;
}
```

### Relationship to Phase 2 Principle 2

Propagation does not violate "derived facts are query-time, never materialized." The distinction:

- **Derived facts** (orphan/claimed classification, field coverage, conformance) remain query-time. Removing a claim doesn't write an `is_orphan` flag.
- **Data** (field values, field names, rendered file content) is materialized when it changes. Adding a claim with a default populates a field value — that's data. Renaming a field changes the field name — that's data.

The re-render after claim removal is a file presentation change (field moves between frontmatter sections), not a data change. DB values are untouched; only the rendered markdown changes.

---

## Section 10: Schema and Global Field Rendering

*Charter reference: "Schemas and fields live in the vault. `.schemas/*.yaml` for schemas, `.schemas/_global.yaml` (or similar) for the global field pool. The vault is self-contained."*

Schema and global field rendering produces YAML files that make the engine's type system visible and browsable in the vault. These files are one-way renderings of DB state — the engine writes them, but does not read them back. The watcher skips `.schemas/` entirely (confirmed: `shouldIgnore()` includes `.schemas` in `IGNORED_DIRS`).

### File layout

```
.schemas/
  _fields.yaml          ← global field pool
  task.yaml             ← one file per schema
  meeting.yaml
  note.yaml
  ...
```

One file per schema, named `{schema_name}.yaml`. The global field pool renders to `_fields.yaml` (underscore prefix to sort it first and distinguish it from schema files).

**Reserved prefix:** `create-schema` rejects schema names starting with `_`. This prevents user-created schemas from colliding with `_fields.yaml` or any future engine-managed files in `.schemas/`.

### Schema YAML format

Each schema file contains the schema definition and its field claims, with global field definitions inlined for readability:

```yaml
name: task
display_name: Task
filename_template: "TaskNotes/Tasks/{title}.md"
field_claims:
  - field: status
    sort_order: 100
    required: true
    default_value: open
    global_field:
      field_type: enum
      enum_values: [done, open, pending, in-progress]
      required: false
  - field: due
    sort_order: 200
    global_field:
      field_type: date
  - field: project
    sort_order: 400
    global_field:
      field_type: list
      list_item_type: reference
```

**Design choices:**

- `field_claims` is an ordered array (by sort_order), not a map. Preserves the ordering that determines frontmatter field order.
- Each claim inlines its `global_field` definition. Same self-contained pattern as `describe-schema`'s response (Phase 2 spec Section 3).
- Null/default properties are omitted to reduce noise. Only non-null, non-default values are rendered.
- Claim-level `required` and `default_value` are rendered when the claim has an override value — regardless of whether `per_type_overrides_allowed` is true on the global field. If the DB contains an override value, the file reflects it. This is defensive serialization: the file shows what the DB contains, not what the validation rules say it should contain. If an inconsistency exists (override present but not allowed), the file makes it visible.

### Global field pool YAML format

`_fields.yaml` contains all global field definitions:

```yaml
fields:
  - name: due
    field_type: date
  - name: priority
    field_type: enum
    enum_values: [normal, medium, none]
  - name: project
    field_type: list
    list_item_type: reference
  - name: status
    field_type: enum
    enum_values: [done, open, pending, in-progress]
    required: false
    per_type_overrides_allowed: true
```

Sorted by field name in Unicode codepoint order. Null/default properties omitted.

### Serialization

Schema and field YAML uses the same `yaml.stringify()` with the same options as node frontmatter (Section 2: `indent: 2`, `lineWidth: 0`, YAML 1.2). Deterministic output — same DB state produces same bytes.

**Performance target:** All schema YAML files and `_fields.yaml` rendered in under 200ms for a vault with 50 schemas and 200 global fields. This is a best-guess target; the actual bottleneck is file I/O, not YAML serialization. If measured performance is significantly worse, investigate whether batching file writes helps.

### When rendering triggers

| Trigger | Files re-rendered |
|---|---|
| `create-schema` | New `{name}.yaml` |
| `update-schema` | `{name}.yaml` |
| `delete-schema` | `{name}.yaml` deleted (with hash check) |
| `create-global-field` | `_fields.yaml` |
| `update-global-field` | `_fields.yaml` + schema files with claims on this field |
| `rename-global-field` | `_fields.yaml` + schema files with claims on old or new name |
| `delete-global-field` | `_fields.yaml` + schema files that had claims on this field |

Schema YAML rendering happens after the schema/field DB operation commits and after any node propagation (Section 9) completes.

### Hash-check protection: refuse on mismatch

Schema YAML files can be edited by humans (they're in the vault, visible in any editor). The engine detects external edits via hash comparison and **refuses to overwrite** them.

**Hash storage:**

```sql
CREATE TABLE IF NOT EXISTS schema_file_hashes (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  rendered_at INTEGER NOT NULL
);
```

After each successful render, the engine stores the file's content hash. Before the next render, the engine hashes the on-disk file and compares.

**Render-time behavior:**

- **Hash matches (or file missing):** Render proceeds normally. Write the file, update the stored hash.
- **Hash mismatch (external edit detected):** Render is **blocked**. The DB operation (schema change) still commits — the DB is authoritative. The file stays in the user's edited state. A `schema-file-render-blocked` edits log entry is written.

**Persistent refusal:** The engine refuses every subsequent render attempt for a blocked file. Each schema mutation that would re-render the file produces another `schema-file-render-blocked` entry. The file stays in the user's edited state indefinitely. The DB continues to be authoritative — the stale file doesn't affect engine behavior because schema YAML is never read by the engine.

**Resolution path:** The user either:
1. Deletes the file → the engine re-creates it on the next schema render trigger.
2. Restores the file to the expected content (e.g., via `git checkout`) → the hash matches on the next render, and the engine proceeds.

**Delete-schema with hash-check:** `delete-schema` also checks the hash before deleting the file. If the on-disk hash doesn't match, the file is NOT deleted. A `schema-file-delete-blocked` log entry is written. The schema DB row is still deleted. The file remains on disk as an orphaned artifact with an explanation in the log.

### One-way rendering: what this means in practice

The engine never reads `.schemas/*.yaml` files. Schema state comes from the DB. This means:

- Schema files can drift arbitrarily from DB state if renders are blocked, with no effect on engine behavior.
- Schema files are purely for human consumption: browsing the type system in a file manager or editor.
- The hash-check refusal mechanism protects human edits without creating a read-back path.
- Future phases may add schema YAML absorption (the watcher reads edits back), but this is explicitly not Phase 3 scope.

### Startup behavior

On engine startup:

1. For each row in `schema_file_hashes`: hash the on-disk file, compare to stored hash.
   - **Match:** File is canonical. No action.
   - **Mismatch:** External edit detected. Log `schema-file-render-blocked`. Do NOT re-render.
   - **File missing:** Re-render from DB state. Update stored hash.
2. For schemas in DB with no `schema_file_hashes` entry (new schemas, or first startup after Phase 3 migration): render, insert hash row.
3. Re-render `_fields.yaml` (always, since global field changes are cheap and the file is small).

This startup flow respects external edits made while the engine was stopped. It never overwrites a file it didn't write.

### Directory creation

The `.schemas/` directory is created on first schema render if it doesn't exist. The engine does not create the directory at startup if there are no schemas.

### DB migration

Phase 3 adds the `schema_file_hashes` table:

```sql
CREATE TABLE IF NOT EXISTS schema_file_hashes (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  rendered_at INTEGER NOT NULL
);
```

Conditional `CREATE TABLE IF NOT EXISTS` — no migration needed for existing DBs beyond table creation.

---

## Section 11: Testing Strategy

*Same pattern as Phase 2: unit tests for pure modules, integration tests for DB-backed operations, MCP tool tests for response shapes, cross-cutting tests for contracts that span multiple modules.*

### Renderer unit tests (no DB)

The renderer is a pure function. Test it in isolation.

**Round-trip determinism:**
- Parse a fixture file → store fields via `classifyValue` → reconstruct values → build `RenderInput` → render → parse again → assert identical `ParsedNode` (modulo known canonicalizations)
- Fixture files covering: simple scalar fields, lists, nested objects, wiki-link references, dates, booleans, empty body, body with headings, multi-type nodes

**Field ordering:**
- Claimed fields appear in sort_order, ties broken by Unicode codepoint field name
- Orphan fields appear after claimed fields, in Unicode codepoint order
- `title` always first, `types` always second

**Wiki-link re-wrapping:**
- Claimed reference field: value `"Alice"` → `"[[Alice]]"` in rendered YAML
- Claimed list<reference> field: `["Alice", "Bob"]` → `["[[Alice]]", "[[Bob]]"]`
- Orphan field with `value_raw_text`: raw text used verbatim (preserves `[[target|alias]]`)
- Orphan field without `value_raw_text`: value used as-is (no wrapping)

**Types serialization:**
- Single type rendered as block list: `types:\n  - task`
- Multiple types rendered in array order
- Empty types array: `types: []`

**Null handling:**
- Null-valued field omitted from frontmatter
- Field with value `0`, `false`, `""` NOT omitted (only null)

**Body content:**
- Non-empty body appended after `---\n`
- Empty body: file ends with `---\n`
- Body with leading newline preserved

**Content hash:**
- `sha256(renderNode(input))` is deterministic across repeated calls

### Write pipeline integration tests (in-memory SQLite + temp directory)

**Tool path — create-node:**
- Valid input: node created, file written, DB populated, hash matches file
- Missing required field: pipeline rejects, no file written, no DB change
- Coerced value: file contains coerced value, `coerced_state` has `changed: true`
- Merge conflict on provided value: write proceeds, issue in response, edits log entry
- Merge conflict on unprovided field with conflicted default: field omitted, both `MERGE_CONFLICT` and `REQUIRED_MISSING` if applicable
- Path conflict: error returned, no file written

**Tool path — update-node:**
- Patch semantics: set one field, other fields unchanged
- Null in `set_fields` removes field
- `append_body` appends with separator
- Query-mode: bulk update applies to all matched nodes atomically
- Query-mode dry_run: returns preview, no DB changes
- Query-mode failure: any node fails → entire batch rolls back

**Watcher path:**
- Valid edit: file parsed, pipeline runs, file re-rendered, edits log clean
- Coerced value: old file has `"TODO"`, pipeline coerces to `"todo"`, file re-rendered with `"todo"`, `value-coerced` log entry
- Rejected value: old file has invalid enum, pipeline retains old DB value, file re-rendered with old value, `value-rejected` log entry
- Type addition via frontmatter: defaults populated same as `add-type-to-node`
- Type removal via frontmatter: fields orphaned, `fields-orphaned` log entry
- Parse error on existing node: DB state untouched, `parse-error` log entry

**No-op write rule:**
- Render produces same hash as on-disk file → no file write, no DB change, transaction rolled back
- File mtime unchanged
- No edits log entries produced

**Transaction boundary:**
- DB state and file content are consistent after a successful write
- On simulated failure mid-pipeline: DB rolled back, file unchanged (or reverted)

### Write lock tests

- Lock acquired before file write, released after DB commit
- Watcher skips locked files (assert via `isLocked` check, not timing)
- Hash check works after lock release: watcher sees hash match, skips
- Mutex serialization: instrumented entry/exit assertions — add a counter that increments on mutex enter and decrements on mutex exit, assert it never exceeds 1. Separate unit test for the mutex, not a timing-dependent concurrent file change test.

### Edits log tests

- `value-coerced`: correct coercions array with step and code
- `value-rejected`: correct rejected_value, retained_value, reason_code
- `merge-conflict`: one entry per (field, property) pair
- `field-defaulted`: correct default_value and default_source
- `fields-orphaned`: correct orphaned_fields list and trigger
- `parse-error`: existing node → `db_state: 'preserved'`, new file → `db_state: 'created-minimal'`
- Clean write: no edits log entries produced
- Tool-path rejection: no edits log entry (error returned to caller)

### Mutation tool tests

**delete-node:**
- Preview mode: returns referencing nodes, no deletion
- Confirm mode: file deleted, DB cleaned, dangling references counted
- `referencing_nodes_limit` parameter respected

**rename-node:**
- File renamed on disk, DB updated, referencing nodes re-rendered
- Full five-tier resolution: references via basename, case-insensitive match, and NFC-normalized match are all found and updated
- Body wiki-links updated: `[[Old Title]]` → `[[New Title]]`
- Alias preservation: `[[Old Title|display]]` → `[[New Title|display]]`
- Frontmatter reference fields updated via pipeline re-render (canonical `[[New Title]]`, no alias)
- Path conflict: error, nothing changed

**batch-mutate:**
- Multi-operation success: all ops applied atomically
- Failure rolls back all ops (including file writes)
- In-flight reference: later op references node created by earlier op (by title)
- Dangling in-flight reference: later op references nonexistent title → `NOT_FOUND`, batch rolls back
- Collision: two creates with same title in one batch → error on second op, batch rolls back
- Rename excluded: error if op includes rename

### Type assignment tool tests

**add-type-to-node:**
- Type added, defaults populated via merge algorithm
- Re-adoption: orphan field matching new claim becomes claimed
- Merge conflict on defaults: conflicted field gets no default, issue in response
- Already-present type: no-op, `already_present: true`

**remove-type-from-node:**
- Fields orphaned, log entry written
- Confirmation gate: removing last type without `confirm` returns preview
- Removing last type with `confirm` succeeds, all fields become orphans

### Watcher integration tests (temp vault + chokidar)

- Write file → debounce fires → pipeline runs → file re-rendered
- Engine writes file → watcher detects → hash matches → skips (no re-index loop)
- Rapid saves (simulate Obsidian auto-save): debounce collapses, single pipeline run
- Delete file → node removed from DB

**Parse-error preservation cycle:**
- Write valid file → watcher indexes → verify DB has structured state
- Overwrite with broken YAML → watcher fires → verify DB state UNCHANGED, `parse-error` log entry
- Overwrite with fixed YAML → watcher fires → verify DB state UPDATED to new content

### Schema change propagation tests

**update-schema add claim:**
- Nodes of type get default populated (merge algorithm, not direct lookup)
- Nodes with existing value for the field: value unchanged (re-adoption)
- Merge conflict on default across types: no default populated for conflicting field
- All affected nodes re-rendered atomically

**update-schema remove claim:**
- Field values preserved in DB, classified as orphans at query time
- Re-render moves field to orphan section
- `fields-orphaned` log entry per node

**rename-global-field with propagation:**
- `node_fields.field_name` updated (Phase 2 DB)
- All affected nodes re-rendered with new field name

**Propagation rollback:**
- Simulate failure mid-propagation (e.g., inject error after N file writes)
- DB transaction rolled back
- Files already written are reverted from `.vault-engine/tmp/` backups
- Verify: DB state matches pre-propagation, all files match pre-propagation content
- Backup files in `.vault-engine/tmp/` cleaned up after successful revert

### Schema/global field rendering tests

**Schema YAML output:**
- Deterministic: same DB state → same bytes
- Field claims ordered by sort_order
- Inlined global_field definitions correct
- Null properties omitted
- Claim-level overrides rendered regardless of `per_type_overrides_allowed`

**Global field pool YAML:**
- All fields present, sorted by name
- Round-trip: parse `_fields.yaml` → matches DB state

**Hash-check protection:**
- Render succeeds when hash matches (or file newly created)
- Render blocked when hash mismatches (external edit): file unchanged, `schema-file-render-blocked` log entry
- Persistent refusal: second schema change on same file also blocked
- Resolution: delete file → next render succeeds, new hash stored
- `delete-schema` with hash mismatch: file not deleted, `schema-file-delete-blocked` logged

**Startup hash-check scenarios (four cases):**
- All files match stored hashes: no action, no log entries
- File missing (deleted externally): re-rendered from DB, hash stored
- File externally edited (hash mismatch): NOT overwritten, `schema-file-render-blocked` logged
- Crash recovery (schema in DB, no `schema_file_hashes` entry): rendered as new, hash stored

**Reserved prefix:**
- `create-schema` with name starting `_` → error

### Pipeline entry-point equivalence tests

One test per conceptual operation that has both tool and watcher entry points. These protect Principle 1 (one pipeline) from regression. Each test performs the same logical operation via both entry points and asserts identical DB state.

**Create equivalence:**
- Create a node via `create-node` tool with type `task` and specific fields
- Create an identical node by writing the equivalent markdown file and letting the watcher process it
- Assert: both nodes have identical DB state (same fields, same defaults populated, same coerced values, same orphan classification)

**Update equivalence:**
- Create a node via tool. Update a field via `update-node`. Record DB state.
- Create an identical node via tool. Write the updated frontmatter to the file. Let watcher process.
- Assert: identical DB state after both paths

**Add-type equivalence:**
- Create a typeless node via tool. Add type `meeting` via `add-type-to-node`. Record DB state (including populated defaults).
- Create an identical typeless node via tool. Edit the file to add `meeting` to the types array. Let watcher process.
- Assert: identical DB state — same defaults populated, same field ordering in rendered file

**Remove-type equivalence:**
- Create a multi-type node via tool. Remove one type via `remove-type-from-node`. Record DB state.
- Create an identical multi-type node via tool. Edit the file to remove the type. Let watcher process.
- Assert: identical DB state — same fields orphaned, same rendered output

**Body change equivalence:**
- Create a node via tool. Update body via `update-node` with `set_body`. Record DB state.
- Create an identical node via tool. Edit the file to change the body. Let watcher process.
- Assert: identical body in DB, identical rendered file

### End-to-end integration test

Extends the Phase 2 end-to-end test:

1. Index fixture vault
2. Create global fields and schemas (Phase 2 path)
3. `create-node` with types → verify file on disk, fields populated, conformance correct
4. `update-node` with `set_fields` → verify file re-rendered, coerced values in place
5. Simulate human edit (write file directly) → verify watcher processes, re-renders, edits log entries
6. `add-type-to-node` → verify defaults populated, file re-rendered
7. `remove-type-from-node` → verify fields orphaned, re-rendered in orphan section
8. `update-schema` add claim → verify propagation populates defaults on affected nodes
9. `update-schema` remove claim → verify fields orphaned, re-rendered
10. `rename-global-field` → verify field name updated in files
11. `rename-node` → verify file renamed, wiki-link references updated in other nodes
12. `delete-node` → verify file removed, dangling references
13. `batch-mutate` → verify atomic multi-op
14. Verify schema YAML files in `.schemas/` reflect all changes
15. **Restart the engine** (close DB, reopen, run startup sequence) → verify startup hash checks pass, schema files not re-rendered (hashes match), DB state intact
16. Verify `_fields.yaml` reflects all global field changes

---

## Section 12: Non-Goals

Explicit non-goals to prevent scope creep. Phase 3 is the minimum shippable product — the write path, the renderer, the sync loop. These are things Phase 3 explicitly does not do.

- **No schema YAML write-back.** Schema YAML files are one-way (DB → disk). The watcher skips `.schemas/`. Human edits to schema YAML are detected and protected (Section 10 hash-check refusal) but not absorbed. Absorbing schema YAML edits requires a second parser, reconciliation path, and propagation trigger — deferred to a future phase.

- **No `add-relationship` / `remove-relationship` tools.** Relationships are derived state in the Phase 3 architecture, produced by the pipeline from reference-typed field values and body wiki-links. Standalone relationship tools are structurally incoherent with the pipeline. Relationships are managed via `update-node`. See implementation notes (note 17).

- **No alias support on `rename-global-field` or `rename-node`.** Renames are immediate. The old name returns errors (for fields) or becomes a dangling reference (for nodes). Aliasing is Phase 5 reconciliation.

- **No warnings in validation issues.** All issues remain `severity: 'error'` in Phase 3. The `severity` field exists for future use. Coercions that succeed are not issues — they appear in `coerced_state` with `changed: true` and in the edits log.

- **No `reconcile-fields` tool.** Field reconciliation (consolidating near-duplicate fields) is Phase 5.

- **No `infer-schemas` orchestrator.** The discovery primitives exist (Phase 2); the workflow tool that composes them into a full schema proposal is Phase 5.

- **No semantic search.** The `embeddings` table exists but is unpopulated. `semantic-search` is Phase 4.

- **No content extraction tools.** `summarize-node`, `read-embedded`, `extract-tasks`, `create-meeting-notes` are Phase 6.

- **No workflow tools.** `daily-summary`, `project-status` are Phase 7.

- **No `edits-log` query tool.** The edits log is write-only from the engine's perspective in Phase 3. Users who need to inspect the log can query the `edits_log` table directly via SQLite (`sqlite3 .vault-engine/vault.db "SELECT * FROM edits_log ORDER BY timestamp DESC LIMIT 20"`). The MCP query tool is Phase 7.

- **No `traverse-graph` tool.** Relationship data is queryable — `get-node` returns outgoing and incoming relationships, and `query-nodes` can filter by relationship. Multi-hop traversal (follow N edges, return the subgraph) is not a Phase 3 tool. The data model supports it; the tool surface doesn't expose it yet.

- **No computed fields.** The charter defers computed field definitions (e.g., `task_count`, `completion_pct`) to post-Phase 3.

- **No automatic `value_raw_text` backfill.** The `value_raw_text` column (Section 2) is populated for newly-indexed fields only. Existing nodes indexed before Phase 3 have `value_raw_text = NULL`. User-visible consequence: orphan fields containing wiki-link references (e.g., `project: [[Vault Engine]]`) on nodes that were indexed before Phase 3 will lose their brackets on the first re-render — the value becomes `project: Vault Engine`. This is a one-time data loss for pre-Phase-3 orphan reference fields. A backfill migration could be built later but is not Phase 3 scope.

- **No multi-node rename.** `rename-node` renames one node. Bulk rename (e.g., renaming all nodes of a type to match a new filename template) is not a Phase 3 tool.

- **No `value_date` column cleanup.** The column is effectively unused (YAML 1.2 parses dates as strings) but exists harmlessly. Dropping it would be a schema migration for no functional benefit.

---

## Section 13: Open Questions Deferred to Later Phases

Questions surfaced during Phase 3 spec work that are explicitly punted. These are not non-goals (Phase 3 doesn't rule them out) — they're decisions that don't need to be made yet. Each includes a concrete trigger for when the question should be revisited.

- **Schema YAML absorption timing.** When should the watcher start reading schema YAML edits? Phase 5 (alongside reconciliation) is the natural home, but it could come earlier. **Trigger:** revisit if users report that one-way schema rendering is a daily friction point, or when Phase 5 scoping begins — whichever comes first.

- **Wiki-link alias preservation on claimed reference fields.** The parser strips aliases; the renderer re-wraps without them. Orphan fields preserve aliases via `value_raw_text` — this asymmetry means a field that's an orphan today preserves `[[Alice|nickname]]`, but if a schema later claims it as a reference field, re-rendering strips the alias to `[[Alice]]`. Not needed for Phase 3's minimum shippable product, but a quality-of-life improvement. **Trigger:** revisit when users report alias loss as a problem, or during Phase 5 reconciliation work which touches the same field-representation layer.

- **`resolved_target_node_id` column on relationships.** The resolver uses query-time five-tier resolution (Model A). `rename-node` does O(distinct_targets) resolver calls. **Trigger:** revisit if `rename-node` latency exceeds 2 seconds on the production vault (7k+ nodes), or when Phase 4 semantic search work touches the relationship model.

- **Filename template syntax.** Phase 3 implements minimal `{variable}` substitution. Richer template syntax (conditionals, date formatting, path manipulation) may be needed. **Trigger:** revisit when a real schema needs a template that `{variable}` can't express.

- **Watcher debounce tuning.** The 500ms debounce and 5s max-wait are Phase 1 defaults. They may need adjustment for Obsidian's auto-save behavior. Tunable via config, but the right defaults should be determined empirically. **Trigger:** revisit after Phase 3 has been in daily use for a week — watch for duplicate processing or delayed processing in the edits log.

- **Edits log retention policy.** Phase 3 grows the log indefinitely. **Trigger:** revisit when the `edits_log` table exceeds 100k rows or 50MB, whichever comes first. Measure after one month of daily use.

- **Metadata-only graph edges.** The charter's `add-relationship`/`remove-relationship` tools imply edges that don't correspond to field values or body links. If a use case emerges, this requires a `source` column on `relationships` distinguishing derived vs manual, with the pipeline preserving manual edges during re-derivation. **Trigger:** revisit if a workflow requires edges between nodes that have no field or body link connecting them.

- **Phase 3 first-startup schema file bootstrap.** Phase 3's schema rendering creates `.schemas/*.yaml` from DB state. On first startup of a new vault, the DB has no schemas and `.schemas/` is empty or nonexistent — no problem. But if a user has existing `.schemas/*.yaml` files from the old system (the production vault does — 27 files), Phase 3 ignores them (the watcher skips `.schemas/`). The old-format files sit alongside any new-format files the engine creates. **Trigger:** resolve before cutover. Options: (a) delete old `.schemas/` files as part of cutover, (b) build a one-time migration that reads old-format files and creates DB schemas from them (Phase 5 migration territory), (c) leave them and let the user clean up manually.

- **Embedding regeneration on rename.** When a node is renamed, its embedding (Phase 4) should be regenerated because the title is part of the embedded content. Phase 3 doesn't populate embeddings, so this is moot today. **Trigger:** revisit when Phase 4 embedding population is implemented — `rename-node` should trigger re-embedding.

---

## Section 14: Build Sequence

Implementation order, stating dependencies explicitly. Steps are numbered. Steps at the same level can be built in parallel.

**1. DB migration**

Add the Phase 3 columns and tables to `src/db/schema.ts`:
- `node_fields.value_raw_text TEXT` column
- `schema_file_hashes` table

Fresh-install path: fold into `createSchema()`. Upgrade path: conditional `ALTER TABLE` and `CREATE TABLE IF NOT EXISTS` in `src/db/migrate.ts`, same pattern as Phase 2.

Verify: `edits_log.event_type` has no CHECK constraint — it's a plain `TEXT NOT NULL` column. New event types (Section 4) don't require DB migration changes. If a constraint exists, remove it in this step.

Everything else depends on this.

**2. Validation engine extension (merge-conflict recovery)**

Modify `src/validation/merge.ts` and `src/validation/validate.ts` to handle conflicted fields with provided values — fold recovery into the main merge loop per the O1 resolution (Section 1, Principle 4). The merge result gains a `conflicted_fields` map alongside `effective_fields` / `partial_fields`. The validation engine's main loop iterates both.

Unit tests first: extend `tests/validation/merge.test.ts` and `tests/validation/validate.test.ts` with merge-conflict recovery cases (provided value validated against global field def, unprovided value omitted, Case 4 dual error codes).

No DB dependency. Unit tests for the validation extension pass independently. End-to-end correctness (conflicted values written to DB and rendered) requires steps 4 and 5 — validated by integration tests later.

**3. Renderer (pure module) — can parallel with step 2**

New module: `src/renderer/`. Pure function, no DB. Implements `renderNode(input: RenderInput): string` per Section 2.

- `src/renderer/render.ts` — the main render function
- `src/renderer/types.ts` — `RenderInput`, `FieldOrderEntry` interfaces

Unit tests: `tests/renderer/render.test.ts`. Test against hand-built `RenderInput` fixture objects. Round-trip tests against the parser: render → parse → assert structural equivalence.

The renderer can be built and tested in complete isolation. After step 4 (indexer changes) lands, extend the renderer test suite with fixtures that exercise `value_raw_text` / `orphanRawValues` — the implementations are parallel, but step 3's test suite grows after step 4.

**4. Indexer changes (`value_raw_text`)**

Modify `src/indexer/indexer.ts`:
- Store `value_raw_text` when the original string contains `[[...]]` patterns (unconditional, per implementation notes note 5)
- Extend the `insertField` prepared statement to include the new column

Depends on step 1 (DB migration). Small change — a few lines in the indexer's field-insertion loop.

Test: extend `tests/indexer/indexer.test.ts` to verify `value_raw_text` is populated for wiki-link-containing fields and null otherwise.

**5. Write pipeline**

New module: `src/pipeline/`. The composition layer (Section 5). Decomposed into substeps, each independently testable:

**5a. Pipeline skeleton + Stage 1**
- `src/pipeline/types.ts` — `ProposedMutation`, `PipelineResult` interfaces
- `src/pipeline/errors.ts` — `hasBlockingErrors` predicate, `VALIDATION_FAILED` error code
- `src/pipeline/execute.ts` — `executeMutation()` function signature, Stage 1 implementation (load claims-by-type, global fields from DB)
- Test: Stage 1 loads correct schema context for given types

**5b. Stage 2 + Stage 3 branching**
- Validation call (`validateProposedState`) integrated into the pipeline
- Tool-path: check `hasBlockingErrors`, return errors or proceed
- Watcher-path: partition accepted/rejected, retained-DB-value lookup, edits log entry accumulation
- `src/pipeline/edits-log.ts` — deviation logging functions (Section 4 event types)
- Test: tool path rejects on blocking errors, watcher path retains DB values for rejected fields

**5c. Stage 4 + Stage 5 (compute + render)**
- Compute `RenderInput` from final state: field ordering, reference sets, orphan raw values
- Call `renderNode()`, compute hash, no-op rule (hash match → rollback)
- Test: correct `RenderInput` assembly, no-op detection

**5d. Stage 6 (write + commit)**
- Uses the shared **file writer utility** (see below) for atomic temp-file-and-rename
- DB commit: upsert nodes, delete+reinsert types/fields/relationships, write edits log entries, update FTS
- `src/pipeline/relationships.ts` — derive relationships from final field state + body wiki-links
- Test: file on disk matches rendered content, DB state consistent, edits log entries correct

**5e. Multi-node transaction support**
- Lock acquisition for multiple file paths
- Backup-and-restore on rollback (for `batch-mutate` and propagation)
- Test: multi-file atomic commit, rollback reverts all files

**Shared utilities extracted during step 5:**

- **`src/pipeline/file-writer.ts`** — atomic temp-file-and-rename write, backup creation for rollback, write-lock integration. Used by step 5d (pipeline Stage 6) and later by step 6c (propagation re-renders). Factored out from the start, not refactored later.

- **`src/pipeline/populate-defaults.ts`** — given a node's type set, current fields, and DB access (claims + global fields), run the merge algorithm and populate missing fields with resolved defaults. Used by step 6b (`add-type-to-node`) and step 7 (watcher diff's type-addition handling). One function, one rule for default resolution (notes 21, 23).

Depends on:
- Step 1 (DB migration)
- Step 2 (validation engine extension)
- Step 3 (renderer)
- Step 4 (indexer changes — for `value_raw_text` reads/writes)

Integration tests: `tests/pipeline/`. Test both tool and watcher paths against in-memory SQLite + temp directory.

**6a. Mutation tools — depends on step 5**

New tool handlers in `src/mcp/tools/`:
- `create-node.ts`
- `update-node.ts`
- `delete-node.ts`
- `rename-node.ts`
- `batch-mutate.ts`

Plus shared utilities:
- `src/mcp/tools/resolve-identity.ts` — `resolveNodeIdentity()` shared by all mutation tools
- `src/mcp/tools/path-derivation.ts` — filename template evaluation for `create-node`

Tests: `tests/phase3/tools.test.ts`.

**6b. Type assignment tools — depends on step 5 (uses `populate-defaults` utility), can parallel with 6a**

New tool handlers:
- `src/mcp/tools/add-type-to-node.ts`
- `src/mcp/tools/remove-type-from-node.ts`

Both use `populate-defaults.ts` from step 5 for default resolution via merge algorithm.

Tests: `tests/phase3/type-tools.test.ts`.

**6c. Schema change propagation — depends on step 5 (uses `file-writer` and `populate-defaults` utilities)**

New module:
- `src/schema/propagate.ts` — propagation logic (Section 9): load affected nodes, run merge for defaults via `populate-defaults`, re-render via renderer, write files via `file-writer`, backup-and-restore on rollback

Modifies existing tool handlers:
- `src/mcp/tools/update-schema.ts` — call propagation after schema update
- `src/mcp/tools/rename-global-field.ts` — call propagation after rename
- `src/mcp/tools/update-global-field.ts` — call propagation after type change

Tests: `tests/phase3/propagation.test.ts`.

**6d. Schema/global field rendering — depends on step 3 (renderer), can parallel with 6a–6c**

New module: `src/schema/render.ts` — renders schema YAML and `_fields.yaml` per Section 10.

Modifies all schema/global-field MCP tool handlers to trigger schema file rendering after DB changes.

Adds:
- `schema_file_hashes` table reads/writes
- Hash-check refusal logic
- Startup re-render flow

Tests: `tests/phase3/schema-render.test.ts`.

**7. Watcher write-back — depends on step 5 (uses `populate-defaults` utility)**

Modify `src/sync/watcher.ts`: replace `indexFile()` call with parse → diff → `executeMutation()` flow per Section 8.

New functions in `src/sync/watcher.ts` or `src/sync/diff.ts`:
- `extractRawFieldTexts()` — second YAML parse for raw wiki-link text
- Type-addition default population via `populate-defaults` utility
- Parse-error handling (preserve DB state for existing nodes)

Modify `src/sync/reconciler.ts`: same upgrade — use the write pipeline for changed files.

Tests: extend `tests/sync/watcher.test.ts`, new `tests/phase3/watcher-writeback.test.ts`.

**8. Cross-cutting and end-to-end tests — depends on all of 6a–6d and 7**

- Pipeline entry-point equivalence tests (5 tests, Section 11)
- Propagation-then-validate consistency test
- Round-trip determinism full-system test
- End-to-end integration test (Section 11, steps 1–16 including restart)

### Dependency graph

```
1. DB migration
    ↓
    ├─── 2. Validation extension
    │         ↓
    ├─── 3. Renderer (parallel with 2)
    │         ↓
    ├─── 4. Indexer changes
    │         ↓
    └───────→ 5a–5e. Write pipeline (needs 2 + 3 + 4)
              │       extracts: file-writer, populate-defaults
              │
              ├── 6a. Mutation tools ──────────────────┐
              ├── 6b. Type assignment (uses pop-defaults)┤
              ├── 6c. Propagation (uses file-writer      │
              │       + pop-defaults) ───────────────────┤
              ├── 6d. Schema rendering (needs 3) ────────┤
              └── 7.  Watcher write-back ────────────────┘
                      (uses pop-defaults)                 ↓
                                                    8. Cross-cutting &
                                                       end-to-end tests
```

Steps 2 and 3 can run in parallel. Steps 6a–6d and 7 can all run in parallel once step 5 is complete.

### Dependencies

No new npm dependencies required for Phase 3. All functionality uses existing packages (`better-sqlite3`, `yaml`, `chokidar`, `nanoid`, `unified`/`remark`) and standard library (`node:fs`, `node:path`, `node:crypto`).

### Estimated scope

- **New files:** ~16 (renderer module, pipeline module + substeps + shared utilities, propagation, schema rendering, mutation tool handlers, type assignment handlers, resolve-identity, path-derivation, diff/raw-text extraction)
- **Modified files:** ~10 (DB schema/migration, validation engine, indexer, watcher, reconciler, existing schema/global-field tool handlers)
- **New test files:** ~8
- **Modified test files:** ~4

---

## Summary

Phase 3 adds 7 new MCP tools (`create-node`, `update-node`, `delete-node`, `rename-node`, `batch-mutate`, `add-type-to-node`, `remove-type-from-node`), extends 3 existing tool responses (propagation results), introduces the deterministic renderer, the write pipeline, the watcher write-back loop, schema change propagation, and schema/global field YAML rendering. The indexer gains `value_raw_text` for round-trip fidelity. The validation engine gains merge-conflict recovery. The edits log gains 8 new event types for deviation tracking.

The architecture is one pipeline with two entry points. The renderer is deterministic. The write lock depends on the hash check. Data is never silently deleted. Every deviation is logged.

At the end of Phase 3: the engine is a fully functional bidirectional sync system. The canonical sync loop works end to end. This is the minimum shippable product.
