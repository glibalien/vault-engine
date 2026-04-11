# Phase 3 Implementation Notes

Living document. Judgment calls, ambiguity resolutions, and design choices made during the Phase 3 spec discussion. Grows during spec work, not retroactively.

---

## 1. O1 Resolution: Merge-conflicted field values in the write path

**Charter said:** Three options (A: block, B: write with warning, C: block only when conflict affects value). Recommended Option B with watcher/tool asymmetry and a `'conflicted'` source value.

**Decided:** Option B, but refined:

- **No watcher/tool asymmetry for merge conflicts.** Both paths behave identically: write provided values, omit unprovided conflicted values, report the conflict. The asymmetry between tools and watcher exists for hard validation errors (TYPE_MISMATCH, COERCION_FAILED) but is inherent to the two input sources, not merge-conflict-specific.

- **No `'conflicted'` source value.** Source describes provenance (provided, defaulted, orphan), not schema consistency. A provided value for a conflicted field has source `'provided'`. The conflict is surfaced in `issues` as `MERGE_CONFLICT`.

- **Recovery folded into the merge loop.** Instead of a separate Step 3b in the validation engine, the merge module itself emits conflicted fields in its result alongside effective/partial fields. The validation engine's main loop iterates both in one pass. Provided values for conflicted fields are validated against the global field definition inline.

- **Case 4 (required agrees, default conflicts, no value provided) surfaces both `REQUIRED_MISSING` and `MERGE_CONFLICT`.** The engine knows the field is required (types agree) and knows the default is conflicted (can't auto-fill). Both issues reported.

- **Edits log entries include `node_types`** (the node's full type list at write time) for context on why the conflict existed.

**Why not the charter's recommendation exactly:** The `'conflicted'` source value conflates provenance and schema consistency — two orthogonal concerns. The `block_on_conflict` parameter pushes policy into the engine that belongs in the agent. The watcher/tool asymmetry for merge conflicts specifically is unnecessary when both paths naturally do the same thing.

## 2. Schema YAML is one-way (DB → disk) in Phase 3

**Charter said:** "Humans can edit schemas directly by editing their YAML files" (Principle 7). Phase 3 spec section on schema rendering.

**Decided:** Schema YAML rendering is one-way in Phase 3. The watcher skips `.schemas/` files. Human edits to schema YAML persist on disk until the next MCP-tool-initiated schema change re-renders and overwrites them.

**Why:**
- Absorbing schema YAML edits requires a second parser, a second reconciliation path, and a second propagation trigger — disproportionate complexity for Phase 3.
- Schema changes cascade vault-wide. Triggering propagation from a file save in an auto-saving editor is higher risk than via MCP tools where the agent can preview impact.
- The charter's "can" is aspirational end-state, not a Phase 3 requirement. Phase 3 is minimum shippable product.
- Hash-check protection: the renderer writes schema YAML with a content hash. If a human edits the file, the hash no longer matches what the engine would render. The next schema change via MCP tools detects the mismatch and overwrites — no silent data loss because the engine never reads from these files. The stale file is just a stale rendering.
- If the engine crashes between a DB schema update and re-render, schema YAML on disk is stale. Same risk as node markdown; same mitigation: reconciler or startup re-render from DB state.

**Documented in:** Section 10 (Schema/Global Field Rendering) and Section 12 (Non-Goals) of the Phase 3 spec.

## 3. Section 5/8 pipeline ownership split

**Ambiguity:** Both the Write Pipeline (Section 5) and Watcher Write-Back (Section 8) need to describe what happens when a mutation flows through the system. Risk of duplicating the pipeline description.

**Decided:** Section 5 owns the full pipeline from "proposed mutation exists" through "DB committed + file rendered + disk written." Section 8 owns watcher-specific concerns: debouncing, diff computation, how a parsed file state becomes a proposed mutation. Once the proposed mutation exists, Section 8 references Section 5. The pipeline is defined once.

**Why:** Single mutation pipeline is a charter principle. Defining it twice in the spec would invite divergence, which would invite two code paths.

## 4. YAML version discovery: dates are not lossy

**Assumed:** The `yaml` package parses date-like strings (`2026-04-11`) as `Date` objects, requiring the renderer to handle date-only vs datetime format preservation (the "lossy step" concern).

**Discovered:** The `yaml` package defaults to YAML 1.2 behavior. Under YAML 1.2, date-like strings are parsed as **strings**, not Date objects. The parser does not pass a `version` option, so it uses the default. Empirically verified:
- `parse('d: 2026-04-11')` → `{ d: '2026-04-11' }` (string)
- `parse('d: 2026-04-11', { version: '1.1' })` → `{ d: Date('2026-04-11T00:00:00.000Z') }` (Date)
- `stringify({ d: '2026-04-11' })` → `d: 2026-04-11\n` (unquoted, round-trips as string)

**Consequence:** The `value_date` column in `node_fields` is effectively dead — the parser never produces `Date` objects under default settings, so `classifyValue` never populates it. All date-like values go into `value_text` as strings and round-trip perfectly without special handling.

**Decision:** The renderer treats date-like strings as plain strings. No quoting, no format preservation, no special date logic. The original "Decision 1" (fix at indexer to preserve date format) is moot — there's no information loss to fix. The `value_date` column is legacy scaffolding; the spec does not require the renderer to read from it, but the reconstruction priority order keeps it for safety (if any future code path produces a `Date` object).

**Decision on value_date column cleanup:** Not in Phase 3 scope. The column exists, is empty, causes no harm. Removing it would be a schema migration for no functional benefit.

**Verification methodology:** Verified empirically that `yaml@2.8.3` (the project's pinned version) parses date-like strings as strings under default settings (YAML 1.2). Test: `parse(stringify({date: '2026-04-11'}))` returns `{date: '2026-04-11'}` (string, not Date). If the `yaml` package version changes, re-run this test to confirm YAML 1.2 remains the default. If it doesn't, the renderer will need date-quoting rules.

## 5. Orphan field wiki-link bracket loss

**Problem:** The parser strips `[[...]]` brackets from ALL field values (frontmatter.ts line 67), storing the canonical target in `value_text`. For claimed reference fields, the renderer re-wraps based on the global field definition. For orphan fields (no global field definition), the renderer can't know the value was a wiki-link, so brackets are lost.

**Example:** User writes `project: [[Vault Engine]]`. Field is orphan. Parser stores `"Vault Engine"`. Renderer outputs `project: Vault Engine`. The brackets are gone.

**Decision:** Add `value_raw_text` column to `node_fields` for format-preserving round-trip of orphan fields. The indexer stores the original pre-stripping string value in `value_raw_text` when the value contains wiki-links. The renderer uses `value_raw_text` for orphan fields (where no global field definition guides re-wrapping) and the typed columns for claimed fields (where the global field definition determines serialization format).

**Critical: `value_raw_text` population is unconditional.** The indexer populates `value_raw_text` for ANY field whose value contains `[[...]]` patterns, regardless of whether the field is currently claimed by a schema or is an orphan. Claim status is a query-time derived fact (Phase 2 Principle 2) — the indexer does not consult `global_fields` or `schemas`. A field that is claimed today may be an orphan tomorrow (schema deleted, field removed from claims). If `value_raw_text` were only populated for current orphans, a schema change would retroactively lose bracket information for fields that become orphans later. Unconditional population costs a few extra bytes per wiki-link-containing field and eliminates this entire failure mode.

**Why this over renderer-side workaround:** The renderer is downstream of where information loss happens. Trying to detect "should this string be wrapped in brackets?" at render time requires heuristics (does the string look like a node title? does a relationship exist for this field?). Heuristics have failure modes. Storing the raw text is O(1) per field, adds a few bytes per row, and eliminates the entire problem class.

**Implementation cost:** One `ALTER TABLE` for existing DBs, one additional column write in the indexer's field-insertion loop, one conditional read in the renderer. Modest cost for a real bug fix.

**When `value_raw_text` is populated:** Only when the original string value contained `[[...]]` patterns that the parser would strip. For values without wiki-links, `value_raw_text` is null and `value_text` is authoritative.

## 6. Operational Principles: what's a principle vs what's a design decision

**Judgment call:** Several candidates were considered for principles and excluded:

- "Schema YAML is one-way in Phase 3" — scoping decision, not governing principle. Goes in Section 10 + Section 12.
- "Transaction boundaries are atomic per-node for mutations" — design decision for Section 5/6, not a principle.
- Phase 2's Principle 2 (derived facts are query-time) — still in force, but Phase 3 introduces schema change propagation which materializes field values on nodes. This is NOT a violation: propagation writes new field values (data), not derived classification facts (orphan/claimed status is still query-time). The tension is resolved in Section 9, not in the principles section.

**Judgment call:** Canonicalization re-render was promoted from a corollary of Principle 5 to its own Principle 6. It's load-bearing for the watcher loop's safety and deserves standalone status rather than being buried as a corollary.

**Judgment call:** The merge-conflict exception was moved out of Principle 2 (tools reject / watcher absorbs) into Principle 4 (merge conflicts don't block). Principle 2 now states the asymmetry cleanly without carve-outs; Principle 4 is the full statement of merge-conflict handling including why it's consistent with Principle 2 rather than an exception to it.

## 7. Body content round-trip verified empirically

**Verified:** `splitFrontmatter` strips exactly one `\n` after the closing `---` (the delimiter newline). The renderer format `---\n{yaml}---\n{body}` round-trips the body perfectly: `splitFrontmatter(rendered).body === originalBody`. Tested cases: standard body, no blank line after `---`, empty body, blank line before content. All round-trip correctly. The renderer does not need special leading-newline handling — the parser and renderer agree on the contract that the delimiter newline belongs to the `---` line, not to the body.

## 8. Write lock: hash-first vs lock-first, and atomic file writes

**Design choice:** The write lock is a narrow race-condition guard, not the durable protection against re-index loops. The hash check (on-disk hash vs `nodes.content_hash`) is the durable mechanism. This means the lock's job is precisely: hold while both the file write and the DB commit happen, so the watcher never sees a window where the file is new but the hash is old.

**Considered:** File-based lock files (flock, .lock files). Rejected — adds filesystem coordination complexity for a single-process system. The in-memory Set is sufficient because there's one process writing files and one watcher reading them, both in the same Node.js process.

**Design choice:** Atomic file writes via write-to-temp-then-rename. The engine writes rendered content to a temp file in the same directory (e.g., `.vault-engine/tmp/{hash}.md`), then renames to the target path. `rename(2)` is atomic on POSIX filesystems within the same mount. This eliminates the partial-write failure mode — the file is either fully written (rename succeeded) or not updated at all (rename failed or crash before rename). Without this, a crash mid-write leaves a truncated file on disk that the watcher would index as corrupt.

**Design choice: file-write-before-DB-commit ordering.** The write pipeline writes the file first, then commits the DB transaction. If the process crashes between file write and DB commit: the file on disk is canonical (fully rendered from valid DB state), but the DB still has the old state. On restart, the reconciler re-indexes the file, finds the hash doesn't match, and re-indexes — which stores the same data the failed transaction would have committed. Self-healing. The reverse order (DB commit first, then file write) would leave the DB updated but the file stale — also self-healing via reconciler, but with a window where the DB and file disagree in the more dangerous direction (DB ahead of file means the user sees stale content in their editor).

**Why file-first is better:** Both orderings self-heal via reconciler. But file-first means the user always sees correct content in their editor, even if the engine crashes. DB-first means the user might see stale content until the reconciler runs. Since the user's editor is the primary interface for reading, file-first is the safer failure mode.

## 9. Edits log: coercion entry structure

**Considered:** `coercion: string` (e.g., `"string → number"`). Simple, human-readable, not machine-queryable.

**Decided:** `coercions: Array<{step: string, code: string}>`. A single field value can go through multiple coercion steps (e.g., string → number, then single value → list wrapping). Each step gets a human-readable `step` description and a machine-queryable `code`. Codes are stable identifiers agents and scripts can filter on; step descriptions are for human log readers.

**Why:** The edits log needs to serve both human readers (who want to understand what happened) and programmatic consumers (a future `edits-log` MCP tool, or agents querying the log to understand patterns). A free-text string serves only humans. Structured codes serve both.

## 10. Edits log: explicit null overrides default

**Problem:** When a user provides explicit `null` for a field that has a default value, the validation engine treats null as deletion intent (Phase 2 spec Section 5). The default is NOT applied. If the field is required, `REQUIRED_MISSING` is raised. This is a deliberate user action, not a validation failure — but the result (field absent despite having a default) could be confusing in the log.

**Considered three options:**
- (a) Log as `field-defaulted` with a `"suppressed_by_null": true` flag — misleading, the default wasn't applied
- (b) Don't log it — the user explicitly chose null, no deviation from intent
- (c) Log as `value-rejected` with reason code `EXPLICIT_NULL_OVERRIDE` — the value (null) was "rejected" in the sense that it prevented the default from applying, and if the field is required, the null itself is rejected

**Decided:** Option (c). Fold into `value-rejected` with reason code `EXPLICIT_NULL_OVERRIDE`. This covers the case cleanly: the user's intent (null) is recorded, the consequence (no default applied, field absent or REQUIRED_MISSING raised) is recorded, and it's queryable via the standard `value-rejected` event type. Only logged on the watcher path — tool-path gets the error in the response.

## 11. Edits log: merge-conflict granularity

**Decision:** One `merge-conflict` entry per (field, property) pair. A field conflicting on both `required` and `default_value` produces two entries. This matches the merge algorithm's output (conflicts are per-property) and makes log entries atomic — each entry describes one conflict with one resolution.

## 11b. Edits log: parse-error event type (added during Section 8 work)

**Discovered during Section 8:** When the watcher encounters a parse error on an existing node, it leaves DB state untouched (note 24). A `parse-error` edits log entry is needed to record this:

```typescript
{
  event_type: 'parse-error',
  node_id: string,      // existing node ID (null for new files)
  details: {
    source: 'watcher',
    file_path: string,
    error: string,       // the parse error message
    db_state: 'preserved' | 'created-minimal',  // existing node vs new file
  }
}
```

This is an addition to the Section 4 event types, discovered after Section 4 was locked. The event type follows the same pattern as existing Phase 1 operational events.

## 12. Edits log: default_source enum

**Considered:** Adding `'merge_resolved'` to the `default_source` enum in `field-defaulted` entries, for cases where multiple claims agree on a default value and the merge resolves it.

**Decided:** Drop it. When claims agree on a default, the merge produces a resolved effective field with a single `resolved_default_value`. The default came from claims — `'claim'` is accurate. Adding `'merge_resolved'` as a separate source doesn't add actionable information; it just exposes an implementation detail of the merge algorithm. Two sources are sufficient: `'global'` (default from the global field definition) and `'claim'` (default from a schema claim, possibly resolved across agreeing claims).

## 13. Write pipeline: lock and transaction span all stages

**Problem:** The initial draft had the DB transaction and write lock acquired only in Stage 6 (Write). Between Stage 1 (Load schema context) and Stage 6, another operation could change the schema context (e.g., a concurrent `update-schema` call), making the validation result stale. The rendered output would be consistent with the state at Stage 1 but not with the state at Stage 6.

**Decided:** The DB transaction is opened at the start of Stage 1 and committed within the write lock in Stage 6. This ensures the schema context read in Stage 1 is the same schema context that exists when the transaction commits. SQLite's WAL mode allows concurrent readers during the write transaction, so this doesn't block query tools.

The write lock is acquired at the start of Stage 5 (Render), not Stage 1. The lock guards file writes, not DB reads. Holding the lock during Stages 1-4 would serialize all mutations even when they affect different files, which is unnecessarily restrictive. The lock needs to span: render → file write → DB commit → release.

**Why not lock from Stage 1:** The transaction provides read consistency. The lock provides write serialization. They serve different purposes and don't need to share a lifecycle. The transaction is long-lived (Stages 1-6); the lock is shorter (Stages 5-6).

## 14. Write pipeline: relationships are derived, not carried

**Considered:** Including wiki-links/relationships in `ProposedMutation`, passed through from the parser or constructed by tools.

**Decided:** Relationships are derived in Stage 6 from the final state, not carried in `ProposedMutation`. Two sources:
- **Frontmatter reference fields:** The pipeline knows which fields are references (from `globalFields` loaded in Stage 1) and derives relationships from the final field values after coercion. `value → relationship(source_id=node_id, target=value, rel_type=field_name)`.
- **Body wiki-links:** Re-extracted from `proposed.body` via `extractBodyWikiLinks()` in Stage 6.

**Why:** Relationships must reflect the final validated state, not the proposed state. If a reference field value is coerced or rejected, the relationship should reflect the coerced/retained value, not the original. Deriving in Stage 6 guarantees this. Carrying relationships through the pipeline would require updating them after Stage 3 (error handling), which is more complex and error-prone.

For orphan fields with `value_raw_text` containing wiki-links: relationships are derived from the raw text, matching the parser's existing behavior (it extracts wiki-links from all string values regardless of field type).

## 15. Write pipeline: no-op write rule

**Decision:** When the rendered hash matches the on-disk file's hash, the entire write is a no-op: no file write, no DB changes, no edits log entries. The DB transaction is rolled back (not committed with zero changes). This is stated as a complete rule because the "optimization" framing in the draft was ambiguous about whether DB changes still happen when the file doesn't change.

**Rationale:** If the rendered output is byte-identical to what's on disk, nothing has changed — by definition, the DB state already matches the rendered state (Principle 3: determinism means same DB state → same bytes). Committing DB changes for a no-op write would update `indexed_at` unnecessarily and could produce spurious edits log entries.

## 16. Write pipeline: value_raw_text provenance

**Problem:** The draft said `value_raw_text` is "preserved from the existing row" for retained DB values, but didn't specify the full provenance rule.

**Decided:** Three cases, one for each value source:

1. **Parser-originated (watcher path):** The parser produces `raw_field_texts` — a map of field names to their pre-wiki-link-stripping text. The indexer (updated in Phase 3) stores these in `value_raw_text`. The pipeline carries `proposed.raw_field_texts` and writes them for accepted values.

2. **Tool-originated:** Tools provide structured field values, not raw text. `value_raw_text` is null for tool-originated values. Reference field rendering uses the global field definition (re-wrapping via `referenceFields` set), not raw text. This is correct because tools should produce canonical values.

3. **Retained from DB (watcher rejection):** When the watcher path retains a previous DB value for a rejected field, the existing `value_raw_text` from the DB row is preserved alongside the existing typed-column values. The entire row's state is carried forward.

This is the complete rule. No other source of `value_raw_text` exists.

## 17. Dropping add-relationship / remove-relationship from Phase 3

**Charter says:** `add-relationship` and `remove-relationship` are listed under Mutation tools.

**Decided:** Drop from Phase 3. Relationships in the Phase 3 architecture are derived state — they're produced by the write pipeline in Stage 6 from reference-typed field values and body wiki-links. A standalone `add-relationship` tool would create a DB row that the next re-render of the source node would either duplicate or overwrite, because the relationship has no anchor in the node's actual state (no field value, no body link).

The correct way to manage relationships is through the data that produces them: `update-node` with reference-typed fields or body edits. This is not a limitation — it's the architecture working correctly.

**Charter edit needed:** Move `add-relationship` / `remove-relationship` to out-of-scope or to a later phase. If a future use case emerges for metadata-only graph edges (edges that don't correspond to any field value or body content), that would require a design extension to the relationship model — probably a `source` column distinguishing derived vs manual relationships, with the pipeline preserving manual relationships during re-derivation. That's post-Phase 3 work.

## 18. rename-node reference update algorithm

**Considered:**
- (a) Full five-tier resolution in reverse: for each relationship in the DB, check if its target would resolve to the node being renamed. Catches all reference styles (exact title, basename, case-insensitive, NFC-normalized).
- (b) Exact string match on old title only. Simpler, misses case-insensitive and basename references.

**Decided:** Option (a), full resolution, naive O(R) scan. The resolver is the source of truth for "what does this target mean?" — the rename should use the same resolution logic to find all references that pointed to the old identity.

**Implementation:** Query all distinct `target` values from `relationships`. For each unique target, run `resolveTarget(db, target)`. If it resolves to the node being renamed, that target string (and all relationships using it) needs updating. The update replaces the target string with the new title. This is O(distinct_targets) resolver calls, not O(total_relationships). For a 7k-node vault, distinct targets is bounded by total relationships (~20k) — fast enough.

**Not using Model B (resolved_target_node_id column):** The resolver comments note this as a future optimization. Phase 3 uses Model A (query-time resolution). Adding an indexed column to avoid the scan would be a schema change that benefits only rename-node. Deferred until performance demands it.

**Alias and display text limitation:** When the renderer re-renders referencing nodes, body wiki-links are reproduced from the stored body text. If the body contains `[[Old Title]]`, the body text itself is updated (string replacement of `[[Old Title]]` with `[[New Title]]`). If the body contains `[[Old Title|display text]]`, the alias is preserved: `[[New Title|display text]]`. Frontmatter reference fields contain only the canonical target (aliases stripped at parse time), so they're updated cleanly via the pipeline.

## 19. batch-mutate in-flight reference resolution

**Decision:** Later operations in a batch can reference nodes created by earlier operations by title. This works because all operations execute within a single SQLite transaction, and SQLite's transaction isolation means reads within the transaction see writes from earlier in the same transaction. The resolver's `SELECT FROM nodes WHERE title = ?` finds the node inserted by an earlier op.

No special handling needed — this is a natural consequence of single-transaction execution.

## 20. Filename template missing variables

**Considered:** Leaving literal `{var}` in the path when a template variable is unresolved.

**Decided:** Fail with `INVALID_PARAMS` error, reason code `MISSING_TEMPLATE_VARIABLE`, naming the unresolved variable. Silent failures in path derivation would create files with literal `{var}` in their names — confusing and hard to clean up. Failing loudly tells the agent exactly what field value to provide.

## 21. add-type-to-node default resolution uses the merge algorithm

**Problem:** When `add-type-to-node` populates defaults for newly-claimed fields, should it look up defaults directly from the claim/global field, or run the full merge algorithm across all types?

**Decided:** Run the full merge algorithm. The node has multiple types after the addition. The effective default for a field depends on the entire type set — if two types both claim a field with different defaults and `per_type_overrides_allowed`, the merge detects the conflict. Looking up defaults directly from the new type's claim would ignore conflicts with existing types and produce values that the pipeline would then flag as conflicted during validation — inconsistent.

The correct sequence: append the type, run the merge on the full new type set, use the merge's `resolved_default_value` for each field. If the merge produces conflicts, the conflicted fields get no default (Principle 4), and the conflicts appear in the response.

## 22. remove-type-from-node confirmation gate for typeless result

**Decision:** `remove-type-from-node` requires `confirm: true` when removing the type would leave the node with zero types. Without confirmation, the tool returns a preview showing the consequence. This prevents accidental typeless-node creation from a typo or misunderstanding.

**Why a gate here but not elsewhere:** Most type removal is a deliberate structural change. But removing the *last* type is a qualitatively different operation — it converts a structured node into an unstructured one, orphaning all fields. The blast radius of a mistake is high (especially in query-mode scenarios where an agent might remove a type from many nodes), and the cost of a confirmation step is low.

## 23. Watcher populates defaults for newly-added types (same as add-type-to-node)

**Initial draft said:** "Unlike `add-type-to-node`, the watcher doesn't auto-populate defaults — the watcher sends what the user wrote."

**Revised decision:** The watcher DOES populate defaults for newly-added types, using the same merge-algorithm-driven logic as `add-type-to-node`.

**Why the reversal:** The pipeline already "invents" values — coercion transforms user input, defaults fill missing required fields. Not populating defaults for type additions via frontmatter editing creates a silent asymmetry: adding `meeting` via the MCP tool fills in `date`, `attendees`, etc. with defaults, but adding `meeting` by typing it in the frontmatter doesn't. The user has no way to discover this difference without encountering it. Same conceptual operation, different results — that's a bug class waiting to happen.

**Implementation:** The watcher's diff step detects newly-added types (types in parsed state that aren't in current DB state). For each newly-added type, the watcher runs the full merge algorithm on the new type set and populates defaults for newly-claimed fields that the node doesn't have a value for — same as `add-type-to-node` steps 4-7. The populated defaults are included in the `ProposedMutation.fields` before it enters the pipeline. `field-defaulted` edits log entries are written for each default populated.

**What this means for the diff:** The diff step becomes slightly more than "parse and send." It detects type additions and runs default population before constructing the mutation. This is watcher-specific logic that doesn't belong in the pipeline (the pipeline validates a proposed state; it doesn't detect *what changed*).

## 24. Parse errors leave existing DB state untouched

**Initial draft said:** "Store the file as a node with no types, no structured fields, the entire file content as body."

**Revised decision:** For existing nodes (node found in DB by file_path), a parse error leaves the DB state untouched. The existing structured data (types, fields, relationships) is preserved. A `parse-error` edits log entry is written. For new files (no existing node), the Phase 1 fallback applies: create a minimal node with body-only content.

**Why:** The user is mid-edit. Their YAML is temporarily broken (missing a colon, unclosed quote, etc.). Wiping the node's structured state to body-only destroys the types, fields, and relationships that were perfectly valid moments ago. When the user fixes the YAML and saves again, the watcher re-parses and processes normally — but the damage is already done if the structured state was wiped. Leaving DB state untouched during the broken-YAML window preserves the user's data.

**Consequence:** During the broken-YAML window, the DB and file disagree. The DB has the pre-edit structured state; the file has broken YAML. This is acceptable — the disagreement is temporary (user will fix the YAML) and the DB's structured state is the correct one to preserve. The reconciler will not "fix" this because the file's mtime is newer but the content can't be parsed; it logs the same parse error.

**File behavior:** The engine does NOT re-render the file during the broken-YAML window. Re-rendering would mean overwriting the user's in-progress edit with canonical state derived from the pre-edit DB, which is hostile to a user who is mid-edit. The file stays in the user's broken-YAML state until they save again with valid YAML, at which point the watcher processes normally. This is the same principle as Section 10's hash-check refusal for schema YAML — the engine doesn't destroy human edits without explicit user action.

## 25. Hash check is outside the mutex; in-pipeline check is inside

**Clarification:** The watcher's pre-pipeline hash check (watcher.ts lines 64-75) runs OUTSIDE the mutex for performance — most events are rejected here without acquiring the mutex. The pipeline's no-op rule (Section 5, Stage 5) runs INSIDE the mutex and DB transaction. The pre-pipeline check is an optimization; the in-pipeline check is the correctness guarantee. Both are needed: the outer check avoids mutex contention for unchanged files; the inner check catches the race where a file changes between the outer check and the pipeline execution.

## 26. Schema change propagation uses the merge algorithm for defaults

**Initial draft said:** "Default population for added claims uses global/claim defaults directly, not the full merge algorithm per node."

**Revised decision:** Propagation uses the merge algorithm for default resolution, same as `add-type-to-node` and the watcher path. There is one rule for default resolution: run the merge on the full type set, use `resolved_default_value`. No bypass for propagation.

**Why the reversal:** The same architectural commitment as "one validation engine called from many entry points." If propagation uses direct lookup while `add-type-to-node` uses the merge, the same field on the same node could get different defaults depending on whether the type was already on the node when the claim was added (propagation path) or the type was added after the claim existed (tool path). This is the same class of silent asymmetry that was rejected for watcher default population (note 23).

**Performance concern:** Propagation across N nodes means N merge computations. But the merge is cheap (in-memory map operations over a small number of types/claims), and many nodes of the same type have the same type combination, so the merge result can be cached by type-set. Cache key: sorted types array. This is an optimization, not a rule change — the merge still runs conceptually for every node.

## 27. Propagation re-renders nodes directly, not through the full pipeline

**Decision:** Propagation uses a subset of the pipeline's stages: load DB state, compute effective fields via merge, compute RenderInput, render, write. It does NOT use Stage 3 (source-specific error handling) because there is no user input to accept or reject. Stage 2 (validation) is also skipped because propagation operates on committed DB data, not proposed mutations.

**Why not "validation might reject existing data":** That framing is misleading. The real reason: Stage 3's purpose is handling the gap between what a user/tool proposed and what the engine accepts. Propagation has no user input — it's the engine applying changes to its own data. The parts of the pipeline that handle user input (Stage 3's accept/reject logic, Stage 2's validation of proposed values) don't apply. The parts that compute structure and render (effective field computation, default population via merge, field ordering, rendering) do apply.

## 28. Propagation rollback includes file reversion

**Decision:** If a propagation transaction fails (any file write error, any DB constraint violation), the transaction rolls back AND any files already written during the propagation are reverted. Reverted means: the temp-file-and-rename approach (Section 3) means the old file content was never destroyed — the temp file was renamed over it. For rollback, the engine renames the old file back from its backup location.

**Implementation:** Before each file write during propagation, copy the existing file to a backup in `.vault-engine/tmp/` (or note its path if it's a new file that didn't exist before). If the transaction rolls back, iterate the backup list and restore each file. If the propagation succeeds and commits, delete the backups.

**Why not "wait for the reconciler":** The reconciler is a safety net for rare edge cases (dropped watcher events, offline changes). Using it as the primary recovery for failed propagation means: (a) files on disk are inconsistent with the DB for up to 15 minutes (default reconciler interval), (b) the user sees incorrect file content during that window, (c) if the engine restarts before the reconciler runs, the stale files persist until the next sweep. Explicit rollback is more work to implement but produces a correct state immediately.

## 29. Schema YAML hash-check: refuse-on-mismatch, not overwrite

**Initial draft said:** Detect external edit via hash mismatch, overwrite with canonical DB state, log the overwrite.

**Revised decision:** Refuse to render. The DB operation (schema change) still commits. The file stays in the user's edited state. A `schema-file-render-blocked` edits log entry is written with resolution instructions.

**Why the reversal from the draft:** "DB is authoritative" is true but doesn't justify destroying human edits silently. The file is a rendering — if the engine can't render it because the file was edited, the correct behavior is to refuse and explain, not to silently overwrite. The user may have edited the file to experiment with a format change or to leave notes. Overwriting destroys that work with no undo path (git notwithstanding — not all users commit .schemas/ to git).

**Subsequent operations after a blocked render:** The engine refuses persistently. Each schema mutation that would re-render the blocked file produces another `schema-file-render-blocked` log entry. The file stays in the user's edited state indefinitely. The DB continues to be authoritative — the stale file doesn't affect engine behavior because schema YAML is never read.

**Resolution path:** The user deletes the file (engine re-creates it on next render) or restores it to the expected content (engine's hash matches, next render proceeds). The log entry includes both options.

**Why persistent refusal over "allow with warning":** If the engine eventually overwrites after N warnings, the user learns to ignore warnings. Persistent refusal is the only behavior that guarantees the user's edit is never destroyed without their explicit action (deleting or reverting the file).

## 30. Schema file hashes persisted to DB, not in-memory

**Decision:** A `schema_file_hashes` table stores the last-rendered hash for each schema YAML file.

```sql
CREATE TABLE IF NOT EXISTS schema_file_hashes (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  rendered_at INTEGER NOT NULL
);
```

**Why not in-memory:** An in-memory map is rebuilt from scratch on startup by re-rendering all files. If the user edited a schema file while the engine was stopped, startup re-render would overwrite the edit before the hash check could detect it. Persisting hashes means startup can hash-check first, render only if the file is missing or the on-disk hash matches the stored hash, and refuse if mismatched.

**Startup flow:**
1. For each row in `schema_file_hashes`: hash the on-disk file, compare to stored hash.
   - Match: file is canonical, no action needed.
   - Mismatch: external edit detected. Log `schema-file-render-blocked`. Do NOT re-render.
   - File missing: re-render, update stored hash.
2. For schemas in DB with no `schema_file_hashes` entry: render, insert hash.

## 31. Hash-check refusal extends to delete-schema

**Decision:** `delete-schema` checks the schema file's hash before deleting it. If the on-disk hash doesn't match the stored hash (external edit), the file is NOT deleted. A `schema-file-delete-blocked` log entry is written. The schema DB row is still deleted (the DB operation is authoritative). The file remains on disk as an orphaned artifact. The log entry explains: "The schema was deleted from the database but the file `.schemas/task.yaml` was externally edited and was not deleted. Delete it manually if no longer needed."

## 32. Underscore prefix reserved for engine-managed schema files

**Decision:** `create-schema` rejects schema names starting with `_`. Error message: "Schema names starting with '_' are reserved for engine-managed files." This prevents user-created schemas from colliding with `_fields.yaml` or any future engine-managed files in `.schemas/`.

## 33. Build sequence: step 5 decomposition

**Decision:** The write pipeline (step 5) is the largest single step. Decomposed into 5 substeps (5a–5e), each independently testable:
- 5a: Pipeline skeleton — ProposedMutation type, executeMutation function signature, Stage 1 (load schema context)
- 5b: Stage 2+3 branching — validation call, hasBlockingErrors predicate, tool-path rejection, watcher-path accept/reject/retain logic
- 5c: Stage 4+5 — compute RenderInput, call renderer, hash comparison, no-op rule
- 5d: Stage 6 — file write (via shared utility), DB commit, edits log write
- 5e: Multi-node transaction support — lock acquisition for multiple files, backup-and-restore on rollback

This prevents "step 5 is opaque for a week" and allows incremental testing.

## 34. Shared utility extraction

**Two shared utilities factored out before their first consumer:**

1. **File writer utility** (`src/pipeline/file-writer.ts`): atomic temp-file-and-rename write, backup for rollback, write-lock integration. Used by step 5d (pipeline Stage 6) and step 6c (propagation re-renders). Propagation needs to write files without going through the full pipeline (Section 9), so the file-writing concern must be extractable.

2. **Default population utility** (`src/pipeline/populate-defaults.ts`): given a node's type set, current fields, and DB access (claims + global fields), run the merge algorithm and populate missing fields with resolved defaults. Used by step 6b (add-type-to-node) and step 7 (watcher diff's type-addition handling). Both call the same function — the architectural commitment from notes 21 and 23 that there is one rule for default resolution.

Both utilities are built as part of step 5 but extracted into their own files from the start, not refactored out later.
