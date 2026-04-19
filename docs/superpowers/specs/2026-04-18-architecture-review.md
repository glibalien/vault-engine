# Architecture Review — 2026-04-18

**Date:** 2026-04-18
**Status:** Findings report
**Origin:** Parallel codebase audit, dispatched before committing to an undo system, to surface accumulated tech debt and standardization opportunities

## Summary

`executeMutation` is genuinely the single pipeline for the bulk of the write path — `create-node`, `update-node` (single-node), `add-type-to-node`, `remove-type-from-node`, `batch-mutate` (per-op), watcher, and normalizer all converge through it with a clean `source: 'tool' | 'watcher' | 'normalizer'` gating. But three places sidestep the pipeline — `delete-node`, schema propagation (`src/schema/propagate.ts`), and `fullIndex`'s bulk-delete loop — and those divergences are the source of the high-severity correctness bugs in §1 and the structural blockers for a clean undo system in §6.

Query builder adoption is good (no structural-filter duplication outside it). Validation layering is clean (`validate` → `merge` → `coerce` is unidirectional with clear responsibilities). Path safety coverage via `safeVaultPath` is comprehensive. The largest standardization win is the MCP response envelope: seven-plus idiosyncratic shapes for errors, warnings, and success responses.

## Scope / Method

Four parallel exploration passes over `/home/barry/projects/vault-engine/src/`, each with a specific mandate:

1. Write-path convergence + charter drift
2. Query path sharing + validation/schema layering
3. Indexer / embedder / search / extraction seams + path safety coverage
4. MCP tool surface consistency + error-handling patterns

Findings below are verified against the source — citations are `file:line` and have been spot-checked on the four highest-impact items.

---

## §1. High-severity correctness bugs (verified)

### 1a. `fullIndex` leaks embedding rows

`src/indexer/indexer.ts:279-295` — the bulk-delete loop runs `deleteFts` + `insertEditLog` + `deleteNode` but never calls `embeddingIndexer.removeNode()`. Compare with `deleteNodeByPath` at line 397 which does clean up. Stale `embedding_vec` rows (a vec0 virtual table with no FK cascade per CLAUDE.md) accumulate on every bulk re-index.

### 1b. Reconciler doesn't clean embedding rows

`src/sync/reconciler.ts:41` calls `deleteNodeByPath(node.file_path, db)` — the third argument (`embeddingIndexer?`) is omitted. `startReconciler` at line 17-24 doesn't even accept the indexer, so there's no path to fix this without a signature change. Sweep-detected deletions leak `embedding_vec` rows.

### 1c. `update-node` silently drops `add_types` / `remove_types` when `set_types` is present

`src/mcp/tools/update-node.ts:197-204` — if all three are provided, only `set_types` is honored and `add_types` / `remove_types` are ignored with no warning. Matches the existing "silent no-op params" feedback memory.

### 1d. Reconciler silent-catch

`src/sync/reconciler.ts:76-78` — `catch { stats.errors++; }` swallows all per-file errors without logging. The error count surfaces in the summary `edits_log` entry but the actual errors are unrecoverable from the record.

---

## §2. Pipeline divergence (charter drift)

### 2a. `delete-node` bypasses `executeMutation`

`src/mcp/tools/delete-node.ts:92-120` runs a raw DB transaction (delete FTS entry, log, delete node cascade) then calls `refreshOnDelete` + `removeNode` + `unlinkSync` directly. No standardized `edits_log` entry in the pipeline's shape, no warning surface. Delete is the only mutation kind that doesn't flow through the pipeline.

### 2b. Schema propagation bypasses `executeMutation` — biggest divergence

`src/schema/propagate.ts:206-237` (and `rerenderNodesWithField` at line 294+) do their own `renderNode → atomicWriteFile → db.prepare().run()` sequence in a bare loop. No orphan tracking from the pipeline, no validation, no `edits_log` entries in the expected shape, no structured warnings. These are the mutations that happen on `update-schema` (with claims), `update-global-field` (with type change), and `rename-global-field`.

### 2c. Orphan raw-text preservation never re-coerces

`src/pipeline/execute.ts:202-210` and the mirrored logic in `src/schema/propagate.ts:191-194` preserve `orphanRawValues` as-is when a field is orphaned via type removal. If the original value failed coercion, the invalid raw text persists. Re-adopting the type reintroduces a validation error that looks like user data.

### 2d. `rename-node` reference rewrites not atomic at the semantic level

`src/mcp/tools/rename-node.ts:254-287` calls `executeMutation` + `executeRename` inside a DB transaction, but the two-phase operation (mutate node → rename file + update referencing nodes) spans multiple `executeMutation` invocations. A concurrent watcher or normalizer could theoretically observe a half-done state. Not a confirmed bug — but the atomicity contract is weaker than a single-call pipeline invocation.

---

## §3. Standardization opportunities

### 3a. MCP response envelope

Current shapes across tools:

| Tool | Success envelope | Error envelope | Warning envelope |
|---|---|---|---|
| `create-node` | `{node_id, file_path, title, types, coerced_state, issues[], orphan_fields}` | `{error, code, …details}` | inline `issues[]` array |
| `update-node` single | same as create | same | same |
| `update-node` query | `{matched, would_update, notice?}` | same | `notice` string (conditional) |
| `delete-node` | `{deleted, dangling_references, warning: text \| null}` | `{error, code}` | `warning` string |
| `batch-mutate` | `{applied, results[]}` | nested per-op in `results[]` | nested in results |
| `query-nodes` | `{nodes, matched, notice?}` | implicit SQL errors | `notice` string |
| `validate-node` | `{valid, issues, effective_fields, orphan_fields}` | full validation object | inline `issues[]` |
| `add-type-to-node` | `{node_id, added_fields, issues}` | `{error, code}` | inline `issues[]` |
| `remove-type-from-node` | `{preview, would_orphan_fields}` | `{error, code}` | `warning` (preview-mode only) |

A unified `{ok, data, warnings: Issue[], error?: {code, message, details}}` across all tools collapses this.

### 3b. Unified deletion function

Delete cleanup is scattered across six sites:

| Site | File | Calls `removeNode`? | Writes `edits_log` entry? |
|---|---|---|---|
| `deleteNodeByPath` | `src/indexer/indexer.ts:374` | ✓ | ✓ |
| `delete-node` tool | `src/mcp/tools/delete-node.ts:92` | ✓ | raw transaction |
| `batch-mutate` delete | `src/mcp/tools/batch-mutate.ts` | deferred (needs verification) | ✓ |
| Watcher unlink | `src/sync/watcher.ts:49` | via `deleteNodeByPath` | ✓ |
| Reconciler delete | `src/sync/reconciler.ts:41` | ✗ — indexer not passed | via `deleteNodeByPath` |
| `fullIndex` bulk delete | `src/indexer/indexer.ts:279-295` | ✗ | ✓ |

A single `deleteNode(nodeId, { reason })` function owning DB cascade + vec cleanup + file unlink + `edits_log` entry, called from every site, eliminates findings 1a, 1b, and 2a together.

### 3c. Uniform dry-run

`create-node` and `update-node` support `dry_run`. `delete-node`, `batch-mutate`, `add-type-to-node`, `remove-type-from-node` don't. `update-node` query mode inverts the default to `true` (arguably a footgun — caller provides non-dry params but gets preview).

### 3d. Default-population consolidation

Two parallel paths: `src/pipeline/execute.ts:103-117` (inline, for tool/watcher writes) and `src/pipeline/populate-defaults.ts:39-60` (for add-type-to-node and schema propagation). Both derive from `resolveDefaultValue` + `mergeFieldClaims`. Consolidating into one `populateDefaults` callable removes the redundancy.

### 3e. Override-resolution reuse

`src/validation/merge.ts:74-104` resolves per-type required / default-value overrides. `src/pipeline/execute.ts:106-116` re-derives the same resolution when building `defaultedFields` for the `edits_log`. A richer merge result passed through removes the re-work.

---

## §4. Minor debt

- `findFileInVault` duplicated at `src/extraction/assembler.ts:14` and `src/mcp/tools/read-embedded.ts:11` — identical implementations.
- Silent file-unlink catches at `src/mcp/tools/batch-mutate.ts:223` and `src/mcp/tools/delete-node.ts:117`. Probably intentional for idempotence, but caller can't distinguish "already gone" from "permission denied."
- `read-embedded.ts:15,68` — `catch { return null }` patterns lose error context.
- `batch-mutate` has no query-mode equivalent to `update-node`'s — asymmetry rather than duplication.
- Identifier param naming drift: node tools use `node_id | file_path | title` union; schema / field tools use `name`; `read-embedded` uses `file_path | filename`.

---

## §5. What's working well

- `executeMutation` genuinely single-path for the major flows; `source: 'tool' | 'watcher' | 'normalizer'` gating is clean and well-enforced at the validation gate (`skipDefaults`) and error-tolerance boundary (`REQUIRED_MISSING` tolerated only for normalizer).
- `src/mcp/query-builder.ts` well-adopted — no structural-filter duplication anywhere else. Inline SQL that exists is either trivial lookups (indexer, normalizer) or observational discovery (`list-field-values`, `infer-field-type`) that wouldn't benefit from builder abstraction.
- `safeVaultPath` coverage is comprehensive — every filesystem entry point traces back to it or to DB-sourced state that was already guarded.
- `resolveEmbedRef` unified between assembler and search indexer via `src/extraction/resolve.ts`.
- Validation stack (`validate` → `merge` → `coerce`) has clear unidirectional responsibilities.
- Extraction cache shared cleanly via `ServerContext` dependency injection.
- Subprocess-isolated embedder clean seam — indexer / watcher / search consumers unaware.

---

## §6. Implications for undo

The review confirms that deferring undo to review first was the right call.

- **Edits-log gaps.** The `delete-node` bypass (2a) and schema propagation bypass (2b) don't produce `edits_log` entries in the pipeline's shape. Undo built on the log would silently miss these operations.
- **Fragmented deletion (3b).** Six delete sites with inconsistent cleanup means "undo a delete" needs a single canonical restore path. The unified `deleteNode` function is a prerequisite.
- **Orphan raw-text (2c).** Creates undo ambiguity: what is the "previous state" of a field that existed but was invalid?

These three items are the real blocker. If undo is going to work uniformly, route every write through `executeMutation` (or a deletion sibling that shares the log contract), standardize the `edits_log` event-type vocabulary, then build undo on top.

---

## Suggested sequencing

1. **Close the bugs** (§1, four items). Each a tight, localized fix with a regression test. Plan: `docs/superpowers/plans/2026-04-18-architecture-review-bug-fixes.md`.
2. **Unified deletion function + route `delete-node` through the pipeline** (§2a + §3b). Eliminates 1a / 1b / 2a together. Medium effort.
3. **Schema propagation through the pipeline** (§2b). Largest structural change. Biggest undo blocker.
4. **MCP response envelope standardization** (§3a). Orthogonal to the pipeline work, can parallelize.
5. **Then undo.**

Minor debt (§4) and orphan re-coercion (§2c) are opportunistic — fold in when adjacent.
