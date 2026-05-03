# MCP Apps Pilot — query-nodes UI

**Status:** Design
**Date:** 2026-05-02
**Scope:** Personal pilot. One tool. Read-only.

## Goal

Pilot MCP Apps support in vault-engine by attaching an interactive UI to the existing `query-nodes` tool. The tool keeps returning the same JSON envelope (model still gets data); the `_meta.ui.resourceUri` field on the tool description points the host at a `ui://` resource that renders the result inline in MCP-Apps-aware clients (Claude). Other clients ignore the metadata and see plain JSON.

The pilot exists to learn the MCP Apps mechanics — bundle serving, postMessage RPC, bidirectional tool calls, sandbox constraints — on a small, reversible surface before deciding whether to extend the pattern to other tools.

## Pilot success gate (capability checklist)

The pilot is "done" — and we can decide separately whether to extend to other tools — when all five are demonstrable:

1. Claude renders the UI when `query-nodes` is called.
2. Refilter from the UI works (UI-initiated `query-nodes` call updates the table without re-prompting the model).
3. Drill-down works (clicking a row triggers a UI-initiated `get-node` and shows the body inline).
4. Graceful degradation: in Codex, MCP inspector, and any non-MCP-Apps client, the same `query-nodes` call returns the same JSON envelope it does today, with no behavioral change.
5. Production deploy works: `npm run build` produces a `dist/` that systemd can run, and the `ui://` resource is served correctly under HTTP transport behind the Cloudflare tunnel.

These map 1:1 to the manual verification steps in the testing section below.

## Scope

**In scope.** Exactly one tool — `query-nodes`. Single self-contained HTML file as the bundle. Iframe can re-call three read-only tools through the postMessage bridge: `query-nodes` (refilter / sort / paginate), `get-node` (drill-down body fetch), `describe-schema` (field-type hints for rendering). Server-side resource registration via the existing `@modelcontextprotocol/sdk`; iframe-side postMessage handling via the official `@modelcontextprotocol/ext-apps` SDK. Build wiring to copy the HTML bundle to `dist/`.

**Out of scope.**

- No second tool wired up. `vault-stats`, `list-undo-history`, etc. keep returning JSON only. We extend after the pilot succeeds, on a separate spec.
- No mutations from the UI. No "set field," "add type," "delete node" buttons. Iframe is read-only.
- No filter-state persistence across messages. A new turn rebuilds from the host-pushed args.
- No instrumentation or metrics. Capability checklist is gut-validated, not log-validated.
- No per-tool permission negotiation (`_meta.ui.permissions` left empty). Bundle works inside the host's default sandbox.
- No CSP-allowlisted external origins. Bundle is fully self-contained, including the `ext-apps` SDK (bundled inline at build time).
- No inspector or non-Claude visual testing. Item 4 of the checklist verifies *behavioral* parity in Codex (JSON envelope unchanged), not visual rendering in any other host. If VS Code Copilot or Goose render the bundle weirdly, we deal with that on extension.
- No automated tests of the bundle's JS. Vanilla JS in one HTML file, exercised manually via the checklist. Automated tests cover server-side wiring only.

## Architecture

**New code lives in a single new directory:** `src/mcp/ui/query-nodes/` — the HTML bundle file plus a small TS module that registers the resource. Existing `src/mcp/tools/query-nodes.ts` gets one localized change: the call to `server.tool(...)` learns to attach `_meta.ui.resourceUri`.

**Wiring at server creation:**

1. `createServer(db, ctx)` calls `registerAllTools(...)` (unchanged) and additionally calls a new `registerQueryNodesUi(server)` which registers the `ui://vault-engine/query-nodes` resource.
2. The resource handler reads the bundled HTML once at server startup (file path resolved relative to `import.meta.url`, sibling to `dist/mcp/ui/query-nodes/index.html`), caches it, and serves it on every resource fetch with the right `_meta.ui` envelope (CSP and permissions left empty for the pilot — defaults are fine since the bundle is self-contained).
3. `query-nodes` registration adds `_meta: { ui: { resourceUri: 'ui://vault-engine/query-nodes' } }` on the tool description.

**Critical invariant.** The bundled HTML must be self-contained — no external `<script src=...>` to a CDN. Network access from inside the iframe is restricted by the host's CSP, and we want the bundle to work when the engine is reached over the Cloudflare tunnel without depending on third-party origins. The `@modelcontextprotocol/ext-apps` ESM module is inlined into the HTML at build time, not loaded at runtime from a remote URL.

## Lifecycle

**In an MCP-Apps-capable client (Claude):**

1. Model decides to call `query-nodes` (with filter X).
2. Host sees `_meta.ui.resourceUri` on the tool, preloads the `ui://` resource.
3. Server returns the tool result (same JSON envelope as today).
4. Host renders sandboxed iframe with the bundled HTML.
5. Host pushes the tool result to the iframe via postMessage.
6. Iframe (using the `App` class from `@modelcontextprotocol/ext-apps`) renders the result.
7. User clicks a row to expand → iframe calls `tools/call(get-node, {id})` over postMessage → host forwards to server → server returns body → iframe inlines it.
8. User edits a filter input → iframe calls `tools/call(query-nodes, {new filter})` over postMessage → host forwards → server returns new result → iframe re-renders the table.

**In a non-capable client (Codex, MCP inspector):** Steps 4–8 don't happen; the client ignores `_meta.ui` and shows the JSON envelope from step 3. Zero behavioral change vs today.

## Components

**Files added:**

```
src/mcp/ui/
  query-nodes/
    index.html      # the self-contained UI bundle (HTML + <style> + <script>)
    register.ts     # resource registration + bundle loader
```

**Files changed:**

```
src/mcp/server.ts             # call registerQueryNodesUi(server) after registerAllTools
src/mcp/tools/query-nodes.ts  # attach _meta.ui.resourceUri to the tool description
package.json                  # add @modelcontextprotocol/ext-apps devDep + postbuild copy step
.gitignore                    # add .superpowers/ for brainstorm sessions (housekeeping, not strictly required)
```

**`src/mcp/ui/query-nodes/register.ts` (server side):**

- Exports `registerQueryNodesUi(server: McpServer)`.
- On import/init: reads `index.html` once via `readFileSync(new URL('./index.html', import.meta.url))`, caches as a string.
- Registers resource `ui://vault-engine/query-nodes` with mimeType `text/html`, contents = the cached bundle, plus the `_meta.ui` envelope (`csp` and `permissions` empty).
- Throws at startup if the bundle file is missing — fail-fast, never silently serve a 404.

**`src/mcp/tools/query-nodes.ts` change:**

- One localized addition: pass `_meta: { ui: { resourceUri: 'ui://vault-engine/query-nodes' } }` in the tool registration call. The function body, params shape, and return envelope are unchanged. The model's contract is identical.

## UI bundle internals

`src/mcp/ui/query-nodes/index.html` contains three logical regions in one file, with vanilla JS + a small bridge module:

1. **Filter strip** (top, one line, collapsed by default). Shows current filter as a compact summary: `types: [task] · status: open · sort: mtime↓ · 42 results`. Clicking expands an inline form with inputs for `types` (multi-select), `title_contains` (text), `fields` (one row per field with name + operator + value), `sort_by` + `sort_order`, `limit`. "Apply" triggers a `query-nodes` re-call via the bridge; "Reset" reverts to the originally-pushed filter args.

2. **Results list** (middle, grows). One row per node: `[▸] {title} — {types joined} — {relative mtime}`. When the result row carries field values (caller passed `include_fields`) or hybrid-search metadata (`score`, `match_sources`, `snippet`), a thin sub-line under the title shows them. Click `▸` to expand inline (Layout B from the brainstorm).

3. **Expanded row body.** First expansion fires `get-node({id, body: true})` via the bridge, caches the body keyed by node id, renders it as a `<pre>` block with a small action footer (`copy id`, `open in vault` — emits the wikilink as text the user can click-copy; no `window.open` from the iframe). Subsequent re-expansions hit the cache.

**Bridge.** Thin wrapper around the `App` class from `@modelcontextprotocol/ext-apps`. Three call sites: `app.callTool('query-nodes', ...)`, `app.callTool('get-node', ...)`, `app.callTool('describe-schema', ...)`. The host enforces the read-only perimeter; the bundle does not re-enforce it.

**State shape inside the bundle (one plain JS object):**

```
{
  initialArgs: <args from the original tool call, frozen>,
  currentArgs: <args mutated by the filter form>,
  result: <last query-nodes result envelope>,
  expandedIds: Set<string>,
  bodyCache: Map<string, string>,
  schemaCache: Map<string, DescribeSchemaResult>,  // lazy, used for enum hints / date formatting
  inflight: Set<string>                            // dedupe in-flight tool calls
}
```

`describe-schema` is loaded lazily — only when the user expands the filter form (where enum hints actually pay off). Failing to load it never blocks the table from rendering.

## Error handling & graceful degradation

**Non-MCP-Apps clients.** They never request the `ui://` resource and never see the iframe path. The `_meta.ui.resourceUri` field on the tool description is unknown metadata they ignore. The `query-nodes` JSON envelope is byte-identical to today. Enforced by the design (we changed nothing about the tool's return value); checklist item 4 verifies it on Codex before declaring done.

**Bundle missing or unreadable at server startup.** `register.ts` throws synchronously during `createServer(...)`. Server fails to start with a clear message — never a half-broken state where the tool advertises a `resourceUri` the server can't serve. Matches existing repo posture (loud failures over silent ones).

**`ui://` resource fetch failure on host side.** Out of our control. Best we can do is log on our side; host will typically fall back to plain JSON rendering of the tool result.

**UI-initiated tool call fails.** Three failure shapes the iframe handles:

1. **Envelope error** (`ok: false, error: { code, message }`) — render an inline error banner inside the relevant region (filter form: under "Apply"; drill-down: inside the expanded row). Don't toast; don't clobber the existing table.
2. **PostMessage transport rejects** (host blocks the call, capability denied, channel closed) — same banner, with the host's error text. Don't retry automatically.
3. **`describe-schema` failure** — silent degradation. Schema cache is best-effort decoration. `console.warn` inside the iframe; the table still renders.

**Stale state after the host pushes a new tool result.** Host can push a *new* tool result at any time (model calls `query-nodes` again with different args). The iframe replaces `state.result` and `state.currentArgs`, clears `state.expandedIds` and `state.bodyCache`, but **keeps `state.schemaCache`** (schemas don't change between calls of the same tool). User loses scroll position — acceptable for the pilot.

**Concurrent in-flight tool calls.** `state.inflight` dedupes by call signature (e.g. `get-node:abc123`). A second click on a row whose body is still loading is a no-op visually; the eventual response renders once.

**Sandbox / iframe restrictions.** No clipboard write, no link navigation, no file downloads, no `localStorage`. The "copy id" button uses host-delegated clipboard if `ext-apps` exposes it and falls back to selecting the text for manual copy. "Open in vault" emits a wikilink string only.

**`query-nodes` tool warnings.** Existing warnings (`CROSS_NODE_FILTER_UNRESOLVED`, `FIELD_OPERATOR_MISMATCH`, `RESULT_TRUNCATED`) flow through the JSON envelope and get rendered in the UI as a small `warnings` strip below the filter line. Wire shape is unchanged.

## Build & deploy

**Build pipeline.** `tsc` doesn't copy non-`.ts` files, so the HTML bundle needs an explicit copy step. Add a `postbuild` script in `package.json` that copies `src/mcp/ui/**/*.html` to the matching `dist/mcp/ui/**/*.html`. Implementation choice (Node's `fs.cpSync` via a small inline script vs `cpy-cli` devDep) is left to the implementation plan. `tsconfig.json` is unchanged. The `import.meta.url`-relative read in `register.ts` works under both `tsx watch` (dev) and the built `dist/` (prod), as long as the HTML sits next to the compiled `register.js`.

**`@modelcontextprotocol/ext-apps` placement.** Server-side `register.ts` does *not* import `ext-apps` — it just serves a `text/html` resource. The dep is used only inside the bundle (loaded by the iframe). The bundle inlines `ext-apps` at build time as a devDep, preserving the "one HTML file, fully self-contained" invariant. The exact bundling step (esbuild one-off, manual concat of the dist ESM, etc.) is an implementation-plan question.

**Deploy.** Existing systemd unit (`vault-engine-new.service.example`) runs `node dist/index.js --transport http`. With the postbuild copy in place, `dist/mcp/ui/query-nodes/index.html` ends up alongside `dist/mcp/ui/query-nodes/register.js`. Cloudflare tunnel transports `ui://` resource fetches as part of the normal MCP HTTP traffic — no new ports, no new tunnel routes.

## Testing strategy

**Automated (vitest, `npm test`):**

1. `register.ts` unit test: `registerQueryNodesUi(server)` registers a resource at the expected URI with `mimeType: 'text/html'` and a body that's non-empty and contains a known sentinel string from the bundle (e.g. an HTML comment `<!-- vault-engine query-nodes ui -->`).
2. `query-nodes.ts` unit test: the tool description includes `_meta.ui.resourceUri === 'ui://vault-engine/query-nodes'`. Existing `query-nodes` tests untouched — return-value contract is identical.
3. Bundle-missing test: `register.ts` throws at init when the HTML file is absent.

**Manual (capability checklist gate, executed once before declaring pilot done):**

1. Spin up local engine, connect Claude (web or desktop) to the LAN URL or Cloudflare tunnel, ask "show me open tasks." Confirm the iframe renders.
2. In the rendered UI, change a filter, click Apply. Confirm new results load without re-prompting Claude.
3. Click a row to expand, confirm body loads. Click again to collapse. Click a different row, confirm both bodies render independently.
4. Same `query-nodes` call from Codex CLI — confirm JSON envelope is identical to a baseline captured before the pilot. Diff with `jq -S`.
5. Deploy to archalien via systemd, run a real query through the production tunnel from Claude. Confirm the iframe loads and bidirectional calls work end-to-end.

The five manual checks map 1:1 to the five capability-checklist items.

**No performance testing for the pilot.** The bundle is small, served once per chat turn; the bridge is a thin postMessage layer. If the production iframe feels janky on real usage we add measurements then.

## Implementation-plan questions (deferred)

These were called out during brainstorming as "decide in the implementation plan, not the spec":

- Tool used for the postbuild HTML copy step (`fs.cpSync` script vs `cpy-cli` devDep).
- Bundling step that inlines `@modelcontextprotocol/ext-apps` into `index.html` (esbuild one-shot, manual concat from the dist ESM, or other).
- Exact pinned versions of `@modelcontextprotocol/ext-apps` and any peer-dep alignment with the existing `@modelcontextprotocol/sdk ^1.29.0`.
- Whether the copy step also needs to run during `npm run dev` (`tsx watch` doesn't compile to disk, so `register.ts` reads HTML directly from `src/`; should be a no-op, but verify).

## Reversibility

If after the trial the UI is unused or unwanted, removal is one commit:

- Remove `_meta.ui.resourceUri` from `query-nodes.ts`.
- Remove the `registerQueryNodesUi` call from `server.ts`.
- Delete `src/mcp/ui/query-nodes/`.
- Drop the `ext-apps` devDep and the `postbuild` script.

The `query-nodes` tool returns to its current behavior in every client.
