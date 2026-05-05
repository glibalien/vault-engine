# Vault Engine

Database-authoritative knowledge graph engine for markdown vaults, exposed via MCP. SQLite is the source of truth; markdown files are a rendered view of that state.

---

## What makes it different

- **Asymmetric sync.** The watcher reads files and updates the DB. The pipeline reads the DB and writes files. Nothing else writes files. This kills the merge-collision bugs that plague two-way sync.
- **One mutation pipeline.** Tool calls, watcher events, schema propagation, and the periodic normalizer all flow through the same parse → validate → coerce → render → write transaction. No parallel code paths.
- **Subprocess-isolated embedder.** The ONNX runtime (~1.5 GB resident) runs in a forked child, IPC for requests, self-exits after 5 min idle, transparent ~2–3 s respawn. `MAX_TOKENS=2048` is deliberately below Nomic's 8K window — ONNX's memory arena sizes to the largest tensor it's seen and never shrinks, so 8K embeds bloated RSS by ~6 GB. 2048 caps the arena at ~1.5 GB and tends to improve retrieval anyway (mean-pooled long vectors blur topical specificity).
- **Reversible mutations.** Every tool write captures a pre-state snapshot via `UndoContext` — covers nodes, schemas, and global fields. `list-undo-history` + `undo-operations`. 24 h retention.
- **Bulk mutate is `update-node` with a query.** Same predicate language as `query-nodes`, applied across the match set. Dry-run on by default; per-node failures are reported instead of aborting the run.
- **Defaults aren't retroactive.** They populate at node creation, type addition, and newly-added schema claims — never via the normalizer. One intentional default-population path means data moves around without surprise backfills.

---

## Architecture

The DB owns the truth; markdown is a projection. Every write is one transaction: load schema context → validate + coerce → resolve per-type overrides → render → hash-diff (no-op if unchanged) → atomic write + node upsert + FTS update + embedding enqueue.

Sources differ in how strict the gate is:

- **Tool writes** block on validation errors with a structured payload, and reject unknown types with the list of available schemas.
- **Watcher events** absorb recoverable errors and keep prior DB values for rejected fields. Stays permissive on unknown types so editor-authored frontmatter doesn't bounce.
- **Normalizer** tolerates `REQUIRED_MISSING` because it only re-renders existing state.

The watcher (chokidar, 2.5 s debounce, 5 s max-wait) is DB-only — it never writes files. Hash guard skips files the pipeline just wrote. YAML parser tolerates duplicate keys (Obsidian's property editor emits them) and retries on parse failures (Obsidian truncates growing files mid-write).

The normalizer is a cron-scheduled sweep that fixes drift (schema changes, field-order changes, added defaults). Skips recently modified files via a quiescence window. Runnable one-shot with `--normalize --dry-run`.

---

## Search

Hybrid lexical + semantic via reciprocal rank fusion (K=60).

- **FTS5** (contentless) over titles and bodies.
- **Vectors** — 256-dim q8-quantized Nomic embeddings stored in `sqlite-vec`.
- **Structured filters** — `types`, `without_types`, `fields`, `without_fields`, `title_eq`, `title_contains` — share the query builder with `query-nodes`. Boostless filtering, not hacked-in ranking weights.

Long docs chunk semantically (headings → paragraphs → sentences → hard split) with 128-token overlap. One `embedding_meta` + `embedding_vec` row per `(node_id, source_type, extraction_ref, chunk_index)`. Non-markdown `![[embed]]` refs get their own `source_type='extraction'` rows; stale rows reconcile on every node enqueue.

`meta.search_version` versions the pipeline. Bumping the constant clears all vectors and re-enqueues every node at startup.

---

## Content extraction

Cached by content hash. Multiple extractors per file type with fallback chains.

- **Always available** — Markdown, Word/Excel/PowerPoint (`officeparser`, `xlsx`), text PDFs (`unpdf`).
- **API-gated** — Audio (Deepgram Nova-3), images (`VISION_PROVIDER=gemini|claude`), scanned PDFs (vision fallback when `avgCharsPerPage < 50`).

Missing keys produce a warning and disable the affected extractor; everything else still works.

---

## Schema system

Fields are defined once in a global pool (`global_fields`) — type, optional enum/default, and `overrides_allowed` permissions. Types claim fields via `schema_field_claims`; multiple types can claim the same global field.

A schema can override `required`, `default_value`, or `enum_values` on a claimed field, gated per-property by `overrides_allowed`. Override semantics:

- **Enums** replace (not extend).
- **Multi-type nodes** — enum: valid-for-any-type. Required/default: cancellation-on-conflict (disagreements fall back to global).
- **`default_value_override: null`** means "no default on this type", distinct from absence (stored via a `default_value_overridden` flag).

Removing a type or claim doesn't delete data — orphan fields persist on the node and render after claimed fields. Re-adopting an orphan re-validates it through the normal path.

Date fields accept ISO 8601 plus `chrono-node` natural-language fallback (`"6 March 2020 | 6:35 am"` → `2020-03-06T06:35`). Fuzzy parses are tagged `STRING_TO_DATE_FUZZY` so callers can surface the interpretation.

---

## MCP surface

29 tools, all sharing the mutation pipeline, query builder, path safety, and undo capture. Every tool returns `{ ok, data | error, warnings }`.

- **Nodes** — create / get / update / delete / rename / query / validate / batch-mutate
- **Types** — add / remove / list
- **Schemas** — create / update / delete / describe / list
- **Global fields** — create / update / delete / rename / describe / list
- **Discovery** — `list-field-values`, `infer-field-type`
- **Content** — `read-embedded`
- **Undo** — `list-undo-history`, `undo-operations`
- **System** — `vault-stats`, `query-sync-log`

Mutation tools (`create-node`, `update-node`, `delete-node`, `add-type-to-node`, `remove-type-from-node`, `batch-mutate`, `update-schema`) all accept `dry_run`. Defaults to `true` for `update-node` query mode; `false` elsewhere.

---

## Setup

Requires Node.js >= 20 and a markdown vault directory.

```bash
git clone <repo-url> vault-engine
cd vault-engine
npm install
npm run build
```

### Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_PATH` | Yes | Absolute path to the vault directory |
| `DB_PATH` | No | SQLite path (default `<VAULT_PATH>/.vault-engine/vault-new.db`) |
| `OAUTH_OWNER_PASSWORD` | HTTP only | Password for the OAuth token endpoint |
| `OAUTH_ISSUER_URL` | HTTP only | OAuth issuer URL for token validation |
| `VISION_PROVIDER` | No | `gemini` (default) or `claude` |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | No | Enables vision extraction (images + scanned PDFs) |
| `DEEPGRAM_API_KEY` | No | Enables Deepgram Nova-3 audio transcription |
| `NORMALIZE_CRON` | No | Cron expression for the periodic normalizer |
| `NORMALIZE_QUIESCENCE_MINUTES` | No | Skip files modified within this window (default 60) |
| `VAULT_EXCLUDE_DIRS` | No | Comma-separated folder prefixes to exclude entirely |

### Run

```bash
npm run dev                                    # auto-reload (tsx watch)
npm start                                      # stdio transport
npm run start:http                             # HTTP transport
node dist/index.js --transport both --port 3334
node dist/index.js --normalize [--dry-run]     # one-shot normalizer sweep
node dist/index.js --reindex-search            # clear + rebuild the search index
```

---

## Deployment

### Systemd

```ini
[Unit]
Description=Vault Engine
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/vault-engine
EnvironmentFile=/path/to/vault-engine/.env
ExecStart=/usr/bin/node /path/to/vault-engine/dist/index.js /path/to/vault/.vault-engine/vault-new.db --transport http --port 3334
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Cloudflare tunnel

```yaml
ingress:
  - hostname: vault.example.com
    service: http://localhost:3334
```

The HTTP transport binds to `127.0.0.1` and enforces OAuth Bearer auth (rate-limited 5 attempts / 60 s). Stdio transport trusts the local process. Expect ~1.5 GB RSS while the embedder is loaded; it idles out after 5 minutes.

---

## Known limitations

- Wiki-link alias preservation is orphan-only. Claimed reference fields render from typed target values.
- Query-mode bulk mutation is best-effort, not all-or-nothing.
- The watcher accepts editor-authored unknown types; tool writes require a schema first.
- The normalizer skips recently modified files, so canonical rendering may lag active edits.

---

## Testing

```bash
npm test              # vitest run
npm run test:watch    # watch mode
npm run test:perf     # performance benchmarks
```

---

## License

MIT
