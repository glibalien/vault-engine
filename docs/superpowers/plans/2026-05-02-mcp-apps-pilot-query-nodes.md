# MCP Apps Pilot — query-nodes UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach an interactive vanilla-JS UI to the existing `query-nodes` MCP tool via the official `@modelcontextprotocol/ext-apps` extension, served from a self-contained HTML bundle as a `ui://` resource.

**Architecture:** Vite + `vite-plugin-singlefile` builds `src/mcp/ui/query-nodes/{index.html, app.ts}` into a single self-contained `dist/mcp/ui/query-nodes/index.html`. A new server-side `registerQueryNodesUi(server)` reads that HTML at startup and registers it as the `ui://vault-engine/query-nodes` resource. `query-nodes` is migrated from the deprecated `server.tool()` to the new `server.registerTool()` API (via `registerAppTool` wrapper) so its description can carry `_meta.ui.resourceUri`. The model still gets the same JSON envelope; MCP-Apps-aware clients also render the iframe.

**Tech Stack:**
- `@modelcontextprotocol/ext-apps@^1.7.1` (devDep — bundled into the iframe HTML at build time, never imported by server runtime)
- `vite@^6.0.0` + `vite-plugin-singlefile@^2.3.0` (devDeps — UI bundler)
- Vanilla DOM JS in the iframe, using `createElement`/`textContent` (no string-concat HTML, no framework runtime)
- Existing `@modelcontextprotocol/sdk@^1.29.0` (already a dep; ext-apps is peer-compatible)

**Spec:** `docs/superpowers/specs/2026-05-02-mcp-apps-pilot-query-nodes-design.md`

---

## File Structure

**New files:**

```
vite.ui.config.ts                          # Vite config, only used by build:ui
src/mcp/ui/query-nodes/
  index.html                               # HTML skeleton + inline CSS, references app.ts
  app.ts                                   # iframe entry: App connection + state + render
  register.ts                              # server-side: load bundle + registerAppResource wiring
tests/mcp/query-nodes-ui.test.ts           # new tests for register.ts + tool-metadata
```

**Modified files:**

```
package.json                               # add devDeps, build:ui script, chain into build
src/mcp/server.ts                          # call registerQueryNodesUi(server)
src/mcp/tools/query-nodes.ts               # migrate from server.tool() → registerAppTool() with _meta
tests/mcp/query-nodes-search.test.ts       # extend fakeServer mock to also handle registerTool
tests/mcp/tools.test.ts                    # extend getToolHandler to also handle registerTool
tests/mcp/envelope.test.ts                 # extend captureHandler to also handle registerTool
```

`scripts/` unchanged. `tsconfig.json` unchanged. `.gitignore` already has `.superpowers/`.

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install ext-apps + Vite + singlefile plugin as devDeps**

```bash
npm install --save-dev @modelcontextprotocol/ext-apps@^1.7.1 vite@^6.0.0 vite-plugin-singlefile@^2.3.0
```

Expected: `package.json` `devDependencies` gains the three packages. `package-lock.json` updates.

- [ ] **Step 2: Verify installs**

```bash
node -e "console.log(require('@modelcontextprotocol/ext-apps/package.json').version)"
```

Expected output: `1.7.1` (or higher 1.x).

```bash
node -e "console.log(require('vite/package.json').version)"
```

Expected output: starts with `6.`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): add @modelcontextprotocol/ext-apps + vite for query-nodes UI pilot

Pulls in the MCP Apps SDK plus Vite + vite-plugin-singlefile (the
documented bundler combo from the ext-apps vanilla example) as devDeps.
Used at build time only to produce the self-contained ui:// HTML bundle;
not loaded at server runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Vite config for the UI bundle

**Files:**
- Create: `vite.ui.config.ts`

- [ ] **Step 1: Write the config**

```ts
// vite.ui.config.ts
//
// Dedicated Vite config used only by `npm run build:ui` to produce the
// self-contained HTML bundle for the query-nodes MCP App UI. The MCP server
// itself does NOT use Vite; this config exists only to bundle the iframe.
//
// Pattern lifted from the ext-apps `basic-server-vanillajs` example.
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const isDev = process.env.NODE_ENV === "development";

export default defineConfig({
  // Treat the UI source dir as Vite's project root so module resolution
  // and the input filename stay simple (just "index.html").
  root: "src/mcp/ui/query-nodes",
  plugins: [viteSingleFile()],
  build: {
    sourcemap: isDev ? "inline" : undefined,
    cssMinify: !isDev,
    minify: !isDev,
    rollupOptions: { input: "index.html" },
    // Relative to `root`. Lands at <repo>/dist/mcp/ui/query-nodes/index.html.
    outDir: "../../../../dist/mcp/ui/query-nodes",
    emptyOutDir: false,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add vite.ui.config.ts
git commit -m "$(cat <<'EOF'
build(ui): add Vite config for the query-nodes UI bundle

Bundles src/mcp/ui/query-nodes/{index.html,app.ts} into a single
self-contained dist/mcp/ui/query-nodes/index.html via vite-plugin-singlefile.
Dedicated config file so vite is invoked only for this one bundle and never
touches the rest of the server build (which stays on plain tsc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire build:ui into package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

In `package.json`, change the `scripts` block so it reads:

```json
  "scripts": {
    "build": "tsc && npm run typecheck && npm run build:ui",
    "build:ui": "vite build --config vite.ui.config.ts",
    "typecheck": "tsc --project tsconfig.test.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "start:http": "node dist/index.js --transport http",
    "test:perf": "vitest run tests/perf/ --config vitest.perf.config.ts"
  },
```

The change is two lines: `build` now appends `&& npm run build:ui`, and a new `build:ui` script invokes Vite.

- [ ] **Step 2: Verify the script wires up**

The bundle source files don't exist yet (Tasks 4–5), so `build:ui` will fail. That's expected — we're verifying the script is invocable. Run:

```bash
npm run build:ui
```

Expected: Vite errors out with something like "Could not resolve entry module 'index.html'". This proves the config is loaded and the script is wired; we're not testing functionality yet.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
build: wire build:ui into npm run build

Adds build:ui (vite build --config vite.ui.config.ts) and chains it
into the main build script after tsc + typecheck. The UI bundle is
produced after server compile so dist/ is whole before
vite-plugin-singlefile writes the bundled HTML alongside it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create the HTML skeleton

**Files:**
- Create: `src/mcp/ui/query-nodes/index.html`

- [ ] **Step 1: Write the file**

```html
<!DOCTYPE html>
<!-- vault-engine query-nodes ui -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <title>vault-engine — query-nodes</title>
  <style>
    :root {
      --bg: #1a1a1a;
      --bg-elev: #2a2a2a;
      --bg-elev-2: #3a3a3a;
      --bg-active: #4a5a7a;
      --fg: #e8e8e8;
      --fg-dim: #888;
      --fg-faint: #666;
      --accent: #9cf;
      --warn: #fc6;
      --danger: #f99;
      --radius: 4px;
      --gap: 6px;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fff;
        --bg-elev: #f4f4f5;
        --bg-elev-2: #e5e7eb;
        --bg-active: #dbeafe;
        --fg: #111;
        --fg-dim: #555;
        --fg-faint: #888;
        --accent: #2563eb;
      }
    }
    body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
    .app { padding: var(--gap); display: flex; flex-direction: column; gap: var(--gap); }
    .filter-strip { background: var(--bg-elev); padding: 6px 10px; border-radius: var(--radius); font-family: monospace; cursor: pointer; }
    .filter-strip.expanded { cursor: default; }
    .filter-strip .summary { color: var(--accent); }
    .filter-form { display: none; padding: 8px 0 4px; flex-direction: column; gap: 6px; }
    .filter-strip.expanded .filter-form { display: flex; }
    .filter-form label { display: flex; gap: 6px; align-items: center; font-size: 12px; }
    .filter-form input, .filter-form select { background: var(--bg-elev-2); color: var(--fg); border: 1px solid var(--fg-faint); border-radius: var(--radius); padding: 3px 6px; font: inherit; }
    .filter-form .actions { display: flex; gap: 6px; padding-top: 4px; }
    .filter-form button { background: var(--accent); color: var(--bg); border: 0; border-radius: var(--radius); padding: 4px 10px; cursor: pointer; font: inherit; }
    .filter-form button.secondary { background: var(--bg-elev-2); color: var(--fg); }
    .warnings { background: var(--bg-elev); padding: 4px 10px; border-radius: var(--radius); border-left: 3px solid var(--warn); font-size: 12px; }
    .results { background: var(--bg-elev); padding: 6px; border-radius: var(--radius); }
    .results-meta { color: var(--fg-dim); font-size: 11px; margin-bottom: 4px; }
    .row { background: var(--bg-elev-2); padding: 4px 8px; margin-bottom: 2px; border-radius: 2px; cursor: pointer; user-select: none; }
    .row.expanded { background: var(--bg-active); border-left: 3px solid var(--accent); }
    .row .caret { display: inline-block; width: 12px; color: var(--fg-dim); }
    .row .meta { color: var(--fg-dim); font-size: 11px; margin-left: 6px; }
    .row .sub { color: var(--fg-dim); font-size: 11px; margin-left: 18px; margin-top: 2px; font-family: monospace; }
    .body { background: var(--bg); padding: 8px 12px; margin-top: 2px; border-radius: 2px; }
    .body pre { margin: 0; white-space: pre-wrap; font: 12px/1.4 monospace; }
    .body .actions { margin-top: 6px; font-size: 11px; color: var(--fg-faint); }
    .body .actions code { user-select: all; cursor: text; background: var(--bg-elev-2); padding: 1px 4px; border-radius: 2px; }
    .error { color: var(--danger); font-size: 11px; margin-top: 4px; padding: 4px 8px; background: rgba(255,153,153,0.1); border-radius: 2px; }
    .empty { color: var(--fg-faint); font-size: 12px; text-align: center; padding: 12px; }
  </style>
</head>
<body>
  <div class="app">
    <div class="filter-strip" id="filter-strip">
      <div class="summary" id="filter-summary">Loading…</div>
      <div class="filter-form" id="filter-form"></div>
    </div>
    <div id="warnings-host"></div>
    <div class="results">
      <div class="results-meta" id="results-meta"></div>
      <div id="results-list"></div>
    </div>
  </div>
  <script type="module" src="./app.ts"></script>
</body>
</html>
```

The HTML comment `<!-- vault-engine query-nodes ui -->` on line 2 is the sentinel that the bundle test will check for. `vite-plugin-singlefile` preserves HTML comments by default.

- [ ] **Step 2: Commit**

```bash
git add src/mcp/ui/query-nodes/index.html
git commit -m "$(cat <<'EOF'
feat(ui): add HTML skeleton for query-nodes MCP App bundle

Self-contained HTML with inline CSS, three regions (filter strip,
warnings, results list) following Layout B from the spec. Loads app.ts
as a module (Vite inlines it at build time). Includes a sentinel comment
the server-side test checks for after bundling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Create the iframe entry script

**Files:**
- Create: `src/mcp/ui/query-nodes/app.ts`

The iframe-side entry. Connects to the host via the `App` class from `@modelcontextprotocol/ext-apps`, holds UI state, renders the three regions via DOM construction (`createElement` + `textContent` — no HTML string concat, no `innerHTML`), and dispatches UI-initiated tool calls.

- [ ] **Step 1: Write the file**

```ts
/**
 * Iframe-side entry for the query-nodes MCP App UI.
 *
 * Receives the initial query-nodes result from the host via app.ontoolresult,
 * renders the table via DOM construction, and re-invokes query-nodes /
 * get-node in response to user interaction (refilter, drill-down, filter-form
 * expansion). All rendering uses createElement/textContent — no string-concat
 * HTML, no innerHTML, no manual escaping.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface Envelope {
  ok: boolean;
  data?: { nodes: NodeRow[]; total: number };
  error?: { code: string; message: string; details?: Record<string, unknown> };
  warnings: Array<{ code: string; message: string; severity: string }>;
}

interface NodeRow {
  id: string;
  file_path: string;
  title: string | null;
  types: string[];
  field_count: number;
  fields?: Record<string, unknown>;
  score?: number;
  match_sources?: string[];
  snippet?: string;
}

type QueryArgs = Record<string, unknown>;

const state: {
  initialArgs: QueryArgs;
  currentArgs: QueryArgs;
  envelope: Envelope | null;
  expandedIds: Set<string>;
  bodyCache: Map<string, string>;
  inflight: Set<string>;
} = {
  initialArgs: {},
  currentArgs: {},
  envelope: null,
  expandedIds: new Set(),
  bodyCache: new Map(),
  inflight: new Set(),
};

// Tiny createElement helper. Children may be strings (become text nodes),
// Nodes (appended), or arrays (flattened). Avoids HTML string concat entirely.
type Child = string | Node | null | undefined | Child[];
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  const append = (c: Child): void => {
    if (c == null) return;
    if (Array.isArray(c)) c.forEach(append);
    else if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  };
  children.forEach(append);
  return node;
}

function clearChildren(parent: Element): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
}

function unwrap(result: CallToolResult): Envelope {
  const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text;
  if (typeof text !== "string") throw new Error("Tool result missing text content");
  return JSON.parse(text) as Envelope;
}

function fileBasename(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/, "");
}

function summaryText(args: QueryArgs, total: number): string {
  const parts: string[] = [];
  if (Array.isArray(args.types) && args.types.length) parts.push(`types: [${(args.types as string[]).join(", ")}]`);
  if (args.title_contains) parts.push(`title~"${args.title_contains}"`);
  if (args.query) parts.push(`q:"${args.query}"`);
  if (args.fields && typeof args.fields === "object") {
    for (const [k, v] of Object.entries(args.fields as Record<string, Record<string, unknown>>)) {
      const op = Object.keys(v)[0];
      const val = v[op];
      parts.push(`${k} ${op} ${JSON.stringify(val)}`);
    }
  }
  parts.push(`sort: ${args.sort_by ?? "title"}${args.sort_order === "desc" ? "↓" : "↑"}`);
  parts.push(`${total} result${total === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function buildFilterForm(args: QueryArgs): HTMLElement {
  const form = el("div", { className: "filter-form-inner" });

  const inputRow = (labelText: string, input: HTMLElement) =>
    el("label", null, labelText + " ", input);

  const typesInput = el("input", { id: "ff-types", placeholder: "task, note" });
  (typesInput as HTMLInputElement).value = (args.types as string[] ?? []).join(", ");

  const titleInput = el("input", { id: "ff-title" });
  (titleInput as HTMLInputElement).value = (args.title_contains as string) ?? "";

  const queryInput = el("input", { id: "ff-query", placeholder: "hybrid search" });
  (queryInput as HTMLInputElement).value = (args.query as string) ?? "";

  const sortBy = el("select", { id: "ff-sort-by" },
    el("option", { value: "title" }, "title"),
    el("option", { value: "file_mtime" }, "file_mtime"),
    el("option", { value: "indexed_at" }, "indexed_at"),
  ) as HTMLSelectElement;
  sortBy.value = (args.sort_by as string) ?? "title";

  const sortOrder = el("select", { id: "ff-sort-order" },
    el("option", { value: "asc" }, "asc"),
    el("option", { value: "desc" }, "desc"),
  ) as HTMLSelectElement;
  sortOrder.value = (args.sort_order as string) ?? "asc";

  const limitInput = el("input", { id: "ff-limit", type: "number", min: "1", max: "200" });
  (limitInput as HTMLInputElement).value = String((args.limit as number) ?? 50);

  const apply = el("button", { id: "ff-apply" }, "Apply");
  const reset = el("button", { id: "ff-reset", className: "secondary" }, "Reset");
  const errSlot = el("div", { id: "ff-error" });

  form.appendChild(inputRow("types", typesInput));
  form.appendChild(inputRow("title contains", titleInput));
  form.appendChild(inputRow("query", queryInput));
  form.appendChild(el("label", null, "sort ", sortBy, sortOrder));
  form.appendChild(inputRow("limit", limitInput));
  form.appendChild(el("div", { className: "actions" }, apply, reset));
  form.appendChild(errSlot);
  return form;
}

function readFilterForm(): QueryArgs {
  const types = (document.getElementById("ff-types") as HTMLInputElement).value
    .split(",").map(s => s.trim()).filter(Boolean);
  const title_contains = (document.getElementById("ff-title") as HTMLInputElement).value.trim();
  const query = (document.getElementById("ff-query") as HTMLInputElement).value.trim();
  const sort_by = (document.getElementById("ff-sort-by") as HTMLSelectElement).value;
  const sort_order = (document.getElementById("ff-sort-order") as HTMLSelectElement).value;
  const limit = parseInt((document.getElementById("ff-limit") as HTMLInputElement).value, 10) || 50;
  const args: QueryArgs = { sort_by, sort_order, limit };
  if (types.length) args.types = types;
  if (title_contains) args.title_contains = title_contains;
  if (query) args.query = query;
  return args;
}

function buildRow(row: NodeRow): HTMLElement {
  const expanded = state.expandedIds.has(row.id);
  const types = row.types.join(", ") || "(no type)";
  const sub: string[] = [];
  if (row.score !== undefined) sub.push(`score=${row.score.toFixed(3)}`);
  if (row.match_sources?.length) sub.push(`via=${row.match_sources.join("+")}`);
  if (row.fields && Object.keys(row.fields).length) {
    sub.push(Object.entries(row.fields).slice(0, 3).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "));
  }

  const rowEl = el("div", {
    className: "row" + (expanded ? " expanded" : ""),
    "data-id": row.id,
  },
    el("span", { className: "caret" }, expanded ? "▾" : "▸"),
    " ",
    el("strong", null, row.title ?? "(untitled)"),
    el("span", { className: "meta" }, ` — ${types} — ${fileBasename(row.file_path)}`),
  );

  if (row.snippet) {
    rowEl.appendChild(el("div", { className: "sub" }, row.snippet));
  }
  if (sub.length) {
    rowEl.appendChild(el("div", { className: "sub" }, sub.join(" · ")));
  }

  const wrap = el("div", null, rowEl);
  if (expanded) {
    wrap.appendChild(buildRowBody(row));
  }
  return wrap;
}

function buildRowBody(row: NodeRow): HTMLElement {
  const cached = state.bodyCache.get(row.id);
  if (cached === undefined) {
    return el("div", { className: "body", "data-id": row.id },
      el("pre", null, "Loading body…"),
    );
  }
  return el("div", { className: "body", "data-id": row.id },
    el("pre", null, cached),
    el("div", { className: "actions" },
      "id: ",
      el("code", null, row.id),
      " · wikilink: ",
      el("code", null, `[[${row.title ?? row.id}]]`),
    ),
  );
}

function render(): void {
  const env = state.envelope;
  const summaryEl = document.getElementById("filter-summary")!;
  const formEl = document.getElementById("filter-form")!;
  const warningsHost = document.getElementById("warnings-host")!;
  const metaEl = document.getElementById("results-meta")!;
  const listEl = document.getElementById("results-list")!;

  if (!env) {
    summaryEl.textContent = "Loading…";
    return;
  }
  if (!env.ok) {
    summaryEl.textContent = "Error";
    metaEl.textContent = "";
    clearChildren(listEl);
    listEl.appendChild(
      el("div", { className: "error" },
        `${env.error?.code ?? "ERROR"}: ${env.error?.message ?? ""}`,
      ),
    );
    return;
  }

  const total = env.data?.total ?? 0;
  summaryEl.textContent = summaryText(state.currentArgs, total);
  clearChildren(formEl);
  formEl.appendChild(buildFilterForm(state.currentArgs));

  clearChildren(warningsHost);
  if (env.warnings.length) {
    const w = el("div", { className: "warnings" });
    env.warnings.forEach((warn, i) => {
      if (i > 0) w.appendChild(el("br"));
      w.appendChild(document.createTextNode(`${warn.code}: ${warn.message}`));
    });
    warningsHost.appendChild(w);
  }

  metaEl.textContent = `${total} result${total === 1 ? "" : "s"}`;
  clearChildren(listEl);
  const nodes = env.data?.nodes ?? [];
  if (nodes.length === 0) {
    listEl.appendChild(el("div", { className: "empty" }, "No results."));
  } else {
    nodes.forEach(n => listEl.appendChild(buildRow(n)));
  }
}

const app = new App({ name: "vault-engine query-nodes UI", version: "0.1.0" });

app.onerror = (err) => console.error("[query-nodes-ui] App error:", err);

app.onhostcontextchanged = (ctx: McpUiHostContext) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};

app.ontoolinput = (params) => {
  const args = (params.arguments ?? {}) as QueryArgs;
  state.initialArgs = JSON.parse(JSON.stringify(args));
  state.currentArgs = JSON.parse(JSON.stringify(args));
  state.expandedIds.clear();
  state.bodyCache.clear();
};

app.ontoolresult = (result) => {
  try {
    state.envelope = unwrap(result);
  } catch (e) {
    state.envelope = {
      ok: false,
      error: { code: "PARSE_ERROR", message: String(e) },
      warnings: [],
    };
  }
  render();
};

app.ontoolcancelled = (params) => {
  console.info("[query-nodes-ui] Tool call cancelled:", params.reason);
};

async function refilter(args: QueryArgs, errSlotId: string): Promise<void> {
  state.currentArgs = args;
  state.expandedIds.clear();
  state.bodyCache.clear();
  const errEl = document.getElementById(errSlotId);
  if (errEl) errEl.textContent = "";
  try {
    const result = await app.callServerTool({ name: "query-nodes", arguments: args });
    state.envelope = unwrap(result);
    render();
  } catch (e) {
    if (errEl) {
      const errBox = el("div", { className: "error" }, `Refilter failed: ${String(e)}`);
      clearChildren(errEl);
      errEl.appendChild(errBox);
    }
  }
}

document.body.addEventListener("click", async (ev) => {
  const target = ev.target as HTMLElement;
  if (!target) return;

  if (target.id === "filter-strip" || target.id === "filter-summary") {
    const strip = document.getElementById("filter-strip")!;
    if (!strip.classList.contains("expanded")) {
      strip.classList.add("expanded");
      const formEl = document.getElementById("filter-form")!;
      clearChildren(formEl);
      formEl.appendChild(buildFilterForm(state.currentArgs));
    }
    return;
  }

  if (target.id === "ff-apply") {
    await refilter(readFilterForm(), "ff-error");
    return;
  }

  if (target.id === "ff-reset") {
    await refilter(JSON.parse(JSON.stringify(state.initialArgs)), "ff-error");
    return;
  }

  const row = target.closest(".row") as HTMLElement | null;
  if (row && !target.closest(".body")) {
    const id = row.getAttribute("data-id")!;
    if (state.expandedIds.has(id)) {
      state.expandedIds.delete(id);
    } else {
      state.expandedIds.add(id);
      if (!state.bodyCache.has(id) && !state.inflight.has(`get-node:${id}`)) {
        state.inflight.add(`get-node:${id}`);
        try {
          const result = await app.callServerTool({ name: "get-node", arguments: { node_id: id } });
          const env = unwrap(result);
          if (env.ok && env.data) {
            const body = (env.data as unknown as { body?: string }).body ?? "(no body)";
            state.bodyCache.set(id, body);
          } else {
            state.bodyCache.set(id, `[error: ${env.error?.code ?? "?"}: ${env.error?.message ?? ""}]`);
          }
        } catch (e) {
          state.bodyCache.set(id, `[error fetching body: ${String(e)}]`);
        } finally {
          state.inflight.delete(`get-node:${id}`);
        }
      }
    }
    render();
  }
});

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged?.(ctx);
});
```

Notes on what's deliberately omitted:
- No `describe-schema` lazy load. The form works without it; that's a polish extension.
- No file_mtime in row meta. `query-nodes` doesn't return it today; `fileBasename()` is the fallback.
- No keyboard navigation. Pilot is mouse-only.

- [ ] **Step 2: Commit**

```bash
git add src/mcp/ui/query-nodes/app.ts
git commit -m "$(cat <<'EOF'
feat(ui): add query-nodes MCP App iframe entry script

Vanilla TS using @modelcontextprotocol/ext-apps' App class. Receives the
initial query-nodes result from the host, renders the filter strip +
warnings + results list (Layout B) via createElement/textContent, and
dispatches UI-initiated calls to query-nodes (refilter) and get-node
(drill-down) over the postMessage bridge. State held in a single mutable
object; no framework runtime, no innerHTML.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build the bundle and verify

**Files:**
- (none modified — verifies Tasks 1–5 work end-to-end)

- [ ] **Step 1: Run the bundler**

```bash
npm run build:ui
```

Expected: Vite logs something like `built in <N>ms`, no errors. Produces `dist/mcp/ui/query-nodes/index.html`.

- [ ] **Step 2: Verify the bundled file is self-contained**

```bash
ls -la dist/mcp/ui/query-nodes/index.html
```

Expected: file exists, size in the tens to hundreds of KB (it inlines ext-apps + the app.ts compilation).

```bash
grep -c "vault-engine query-nodes ui" dist/mcp/ui/query-nodes/index.html
```

Expected: `1` (the sentinel comment survived).

```bash
grep -cE 'src="(\.\/|http)' dist/mcp/ui/query-nodes/index.html || echo "0 external refs"
```

Expected: `0 external refs` (singlefile inlined the script — no external `src=` references).

- [ ] **Step 3: No commit needed (build artifact is gitignored under `dist/`)**

`dist/` is already in `.gitignore`. Nothing to add.

---

## Task 7: Failing test — registerQueryNodesUi registers a resource

**Files:**
- Create: `tests/mcp/query-nodes-ui.test.ts`

This test requires `dist/mcp/ui/query-nodes/index.html` to exist. We don't auto-build inside the test (silent test-time `npm` invocations are an anti-pattern); we fail fast with an actionable message instead.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp/query-nodes-ui.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerQueryNodesUi } from "../../src/mcp/ui/query-nodes/register.js";

const BUNDLE_PATH = path.resolve("dist/mcp/ui/query-nodes/index.html");

beforeAll(() => {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      `query-nodes UI bundle missing at ${BUNDLE_PATH}. Run \`npm run build:ui\` (or \`npm run build\`) before this test.`,
    );
  }
});

interface CapturedResource {
  name: string;
  uri: string;
  config: { mimeType?: string; [k: string]: unknown };
  body: string;
}

async function captureResource(): Promise<CapturedResource> {
  let captured: CapturedResource | undefined;
  const fakeServer = {
    registerResource: async (
      name: string,
      uri: string,
      config: Record<string, unknown>,
      cb: (uri: URL) => Promise<{ contents: Array<{ text?: string }> }>,
    ) => {
      const result = await cb(new URL(uri));
      captured = {
        name,
        uri,
        config,
        body: result.contents[0]?.text ?? "",
      };
    },
  } as unknown as McpServer;
  registerQueryNodesUi(fakeServer);
  // Registration is sync; the read callback is async. Wait a tick for it.
  await new Promise(r => setTimeout(r, 0));
  if (!captured) throw new Error("registerResource was never called");
  return captured;
}

describe("registerQueryNodesUi", () => {
  it("registers the ui:// resource at the expected URI", async () => {
    const r = await captureResource();
    expect(r.uri).toBe("ui://vault-engine/query-nodes");
  });

  it("serves the bundled HTML containing the sentinel", async () => {
    const r = await captureResource();
    expect(r.body).toContain("<!-- vault-engine query-nodes ui -->");
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it("uses the MCP App MIME type", async () => {
    const r = await captureResource();
    expect(r.config.mimeType).toBe("text/html;profile=mcp-app");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/mcp/query-nodes-ui.test.ts
```

Expected: FAIL — module `../../src/mcp/ui/query-nodes/register.js` not found (file doesn't exist yet).

---

## Task 8: Implement register.ts

**Files:**
- Create: `src/mcp/ui/query-nodes/register.ts`

- [ ] **Step 1: Write the implementation**

```ts
// src/mcp/ui/query-nodes/register.ts
//
// Server-side registration of the query-nodes MCP App UI resource.
// Reads the bundled index.html (produced by `npm run build:ui`) at startup
// and serves it via registerAppResource at ui://vault-engine/query-nodes.
//
// Tool-side metadata (_meta.ui.resourceUri) is wired in src/mcp/tools/query-nodes.ts
// so the model and the host see the link advertised on the tool itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const QUERY_NODES_UI_RESOURCE_URI = "ui://vault-engine/query-nodes";

/**
 * Resolve the directory containing the bundled HTML, working from both
 * source (tsx watch / vitest) and compiled (node dist/index.js) entry points.
 *
 * In dev (tsx), import.meta.filename ends in .ts and points at
 * src/mcp/ui/query-nodes/register.ts — we redirect to dist/ where the
 * bundled HTML lives (built by `npm run build:ui`).
 *
 * In prod, import.meta.dirname is dist/mcp/ui/query-nodes already, where
 * vite-plugin-singlefile placed the bundle.
 */
function resolveBundleDir(): string {
  if (import.meta.filename?.endsWith(".ts")) {
    // src/mcp/ui/query-nodes/register.ts → repo root → dist/mcp/ui/query-nodes/
    return path.resolve(import.meta.dirname!, "..", "..", "..", "..", "dist", "mcp", "ui", "query-nodes");
  }
  return import.meta.dirname!;
}

const BUNDLE_PATH = path.join(resolveBundleDir(), "index.html");

// Read once at module load. Throws if the bundle is missing — fail-fast
// rather than registering a resource that 404s on every fetch.
let cachedHtml: string;
try {
  cachedHtml = readFileSync(BUNDLE_PATH, "utf-8");
} catch (err) {
  throw new Error(
    `query-nodes UI bundle not found at ${BUNDLE_PATH}. Run \`npm run build:ui\` first. Underlying error: ${(err as Error).message}`,
  );
}

export function registerQueryNodesUi(server: McpServer): void {
  registerAppResource(
    server,
    "query-nodes UI",
    QUERY_NODES_UI_RESOURCE_URI,
    {
      description: "Interactive table view for query-nodes results",
    },
    async () => ({
      contents: [
        {
          uri: QUERY_NODES_UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: cachedHtml,
        },
      ],
    }),
  );
}
```

- [ ] **Step 2: Run test to verify it passes**

```bash
npm test -- tests/mcp/query-nodes-ui.test.ts
```

Expected: 3 passes. (If you see the bundle-missing error from `beforeAll`, run `npm run build:ui` first.)

- [ ] **Step 3: Commit**

```bash
git add src/mcp/ui/query-nodes/register.ts tests/mcp/query-nodes-ui.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): register query-nodes UI as ui:// resource

Reads dist/mcp/ui/query-nodes/index.html at startup (bundled via
build:ui) and registers it at ui://vault-engine/query-nodes via
registerAppResource. Fails fast if the bundle is missing — better than
silently 404ing every UI fetch. Tests cover URI, sentinel, and MIME type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire registerQueryNodesUi into createServer

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add the import and call**

Change `src/mcp/server.ts` from its current shape to:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { ExtractorRegistry } from '../extraction/registry.js';
import type { ExtractionCache } from '../extraction/cache.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import type { Embedder } from '../search/embedder.js';
import { registerAllTools } from './tools/index.js';
import { registerQueryNodesUi } from './ui/query-nodes/register.js';

export interface ServerContext {
  db: Database.Database;
  writeLock?: WriteLockManager;
  syncLogger?: SyncLogger;
  vaultPath?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
  embeddingIndexer?: EmbeddingIndexer;
  embedder?: Embedder;
}

export function createServer(db: Database.Database, ctx?: {
  writeLock?: WriteLockManager;
  syncLogger?: SyncLogger;
  vaultPath?: string;
  extractorRegistry?: ExtractorRegistry;
  extractionCache?: ExtractionCache;
  embeddingIndexer?: EmbeddingIndexer;
  embedder?: Embedder;
}): McpServer {
  const server = new McpServer({ name: 'vault-engine', version: '0.1.0' });
  registerAllTools(server, db, ctx);
  registerQueryNodesUi(server);
  return server;
}
```

The diff is two lines: the new `import` and the new `registerQueryNodesUi(server)` call.

- [ ] **Step 2: Verify no test regressions**

```bash
npm test -- tests/mcp/
```

Expected: all green. We haven't changed query-nodes yet, so nothing existing changes; `registerQueryNodesUi` is exercised by `query-nodes-ui.test.ts` in isolation and by anything that uses `createServer` end-to-end.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "$(cat <<'EOF'
feat(mcp): wire registerQueryNodesUi into createServer

Mounts the ui://vault-engine/query-nodes resource at server startup so
MCP-Apps-aware clients can preload the bundle when they see the
_meta.ui.resourceUri on the query-nodes tool description.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Extend test fake-servers to handle registerTool

**Files:**
- Modify: `tests/mcp/query-nodes-search.test.ts`
- Modify: `tests/mcp/tools.test.ts`
- Modify: `tests/mcp/envelope.test.ts`

Background: vault-engine's existing tests mock `server.tool(name, desc, schema, handler)` — the deprecated SDK 1.x form. After Task 12, query-nodes will register via `server.registerTool(name, config, handler)` — the new form. Tests will silently fail to capture the handler unless the fake server understands both methods.

Strategy: extend each fake server to mock BOTH `tool` AND `registerTool`. Existing tests keep working (legacy `tool` mock still wires up); query-nodes tests will hit the new `registerTool` mock once Task 12 lands.

- [ ] **Step 1: Update tests/mcp/query-nodes-search.test.ts captureHandler**

Replace the `captureHandler` function (currently around line 65–74) with:

```ts
function captureHandler(idx?: EmbeddingIndexer, emb?: Embedder) {
  let capturedHandler: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
      capturedHandler = h;
    },
    registerTool: (_name: string, _config: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
      capturedHandler = h;
    },
  };
  registerQueryNodes(fakeServer as unknown as McpServer, db, idx, emb);
  return capturedHandler!;
}
```

- [ ] **Step 2: Update tests/mcp/tools.test.ts getToolHandler**

Replace the `getToolHandler` function (currently around line 21–30) with:

```ts
function getToolHandler(registerFn: (server: McpServer, db: Database.Database) => void) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
    registerTool: (_name: string, _config: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db);
  return capturedHandler!;
}
```

- [ ] **Step 3: Update tests/mcp/envelope.test.ts captureHandler**

Replace the `captureHandler` function (currently around line 27–36) with:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureHandler(registerFn: (server: McpServer, ...args: any[]) => void, ...extras: unknown[]) {
  let captured: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      captured = (args) => handler(args);
    },
    registerTool: (_name: string, _config: unknown, handler: (...a: unknown[]) => unknown) => {
      captured = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, ...extras);
  return captured!;
}
```

- [ ] **Step 4: Run all MCP tests to confirm nothing broke**

```bash
npm test -- tests/mcp/
```

Expected: all green. We haven't changed query-nodes yet, so the legacy `tool` mock still fires for it; all existing assertions still pass.

- [ ] **Step 5: Commit**

```bash
git add tests/mcp/query-nodes-search.test.ts tests/mcp/tools.test.ts tests/mcp/envelope.test.ts
git commit -m "$(cat <<'EOF'
test(mcp): extend fake-server mocks to handle registerTool

Adds a registerTool branch alongside the existing tool() branch in three
test files' fake-server helpers, preparing for the query-nodes migration
to the new registration API. Legacy tool() mock is preserved so all
existing tool tests keep passing unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Failing test — query-nodes advertises _meta.ui.resourceUri

**Files:**
- Modify: `tests/mcp/query-nodes-ui.test.ts`

- [ ] **Step 1: Append the new test**

Add the following imports near the top of `tests/mcp/query-nodes-ui.test.ts` (alongside the existing imports):

```ts
import { registerQueryNodes } from "../../src/mcp/tools/query-nodes.js";
import { createTestDb } from "../helpers/db.js";
```

Then append this new `describe` block at the end of the file:

```ts
describe("query-nodes tool: UI metadata", () => {
  it("advertises _meta.ui.resourceUri pointing at the UI resource", () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const fakeServer = {
      tool: () => {
        // Should not be called after the migration; if it is, capturedConfig stays undefined.
      },
      registerTool: (_name: string, config: Record<string, unknown>, _handler: unknown) => {
        capturedConfig = config;
      },
    };
    const db = createTestDb();
    registerQueryNodes(fakeServer as unknown as McpServer, db);
    expect(capturedConfig).toBeDefined();
    const meta = capturedConfig!._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe("ui://vault-engine/query-nodes");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- tests/mcp/query-nodes-ui.test.ts -t "advertises _meta.ui.resourceUri"
```

Expected: FAIL — `capturedConfig` is `undefined` because query-nodes still calls `server.tool(...)`, not `server.registerTool(...)`.

---

## Task 12: Migrate query-nodes to registerAppTool with _meta

**Files:**
- Modify: `src/mcp/tools/query-nodes.ts`

- [ ] **Step 1: Update imports and registration**

Edit `src/mcp/tools/query-nodes.ts`. Add two imports near the top of the file (after the existing imports):

```ts
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { QUERY_NODES_UI_RESOURCE_URI } from '../ui/query-nodes/register.js';
```

Then, inside `registerQueryNodes(...)`, replace the entire `server.tool(...)` call (currently at line 243) with `registerAppTool(...)`.

Before:
```ts
  server.tool(
    'query-nodes',
    'Search and query nodes...long description (preserve verbatim)...',
    paramsShape,
    async (params) => { /* unchanged handler body */ },
  );
```

After:
```ts
  registerAppTool(
    server,
    'query-nodes',
    {
      description: 'Search and query nodes...long description (preserve verbatim)...',
      inputSchema: paramsShape,
      _meta: { ui: { resourceUri: QUERY_NODES_UI_RESOURCE_URI } },
    },
    async (params) => { /* unchanged handler body */ },
  );
```

The description string and the handler body are unchanged. Only the wrapper around them changes.

- [ ] **Step 2: Run the new metadata test to verify it passes**

```bash
npm test -- tests/mcp/query-nodes-ui.test.ts -t "advertises _meta.ui.resourceUri"
```

Expected: PASS.

- [ ] **Step 3: Run all query-nodes-related tests to confirm no regressions**

```bash
npm test -- tests/mcp/query-nodes-search.test.ts tests/mcp/tools.test.ts tests/mcp/field-operator-warnings.test.ts tests/mcp/envelope.test.ts tests/mcp/query-nodes-ui.test.ts
```

Expected: all green. The `registerTool` mock added in Task 10 captures the handler, so existing query-nodes assertions still hold.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/query-nodes.ts
git commit -m "$(cat <<'EOF'
feat(mcp): attach _meta.ui.resourceUri to query-nodes tool

Migrates query-nodes from the deprecated server.tool() API to
registerAppTool() so the tool description can carry _meta.ui.resourceUri
pointing at ui://vault-engine/query-nodes. Description, params shape,
and handler body are unchanged — model-side contract is identical, only
the registration syntax moves to the new API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Full build + test sweep

**Files:**
- (none modified — final verification)

- [ ] **Step 1: Clean build**

```bash
rm -rf dist
npm run build
```

Expected: `tsc` compiles cleanly, `typecheck` passes, `build:ui` produces `dist/mcp/ui/query-nodes/index.html`. Final exit code 0.

- [ ] **Step 2: Verify dist/ contents**

```bash
ls dist/mcp/ui/query-nodes/
```

Expected:
```
index.html
register.d.ts
register.d.ts.map
register.js
register.js.map
```

- [ ] **Step 3: Full test suite**

```bash
npm test
```

Expected: all tests pass. No new test failures introduced.

- [ ] **Step 4: Smoke-start the server and verify resource is exposed**

```bash
node dist/index.js --transport http &
SERVER_PID=$!
sleep 2
curl -s -X POST http://localhost:3334/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/list","params":{}}' | grep -c "ui://vault-engine/query-nodes"
kill $SERVER_PID
```

Expected: `1` — the resource appears in the resources list. (Adjust port if your local config differs.)

- [ ] **Step 5: Commit any package-lock churn**

```bash
git status
# if package-lock.json shows churn after the build:
git add package-lock.json
git commit -m "chore: refresh package-lock after build sweep"
```

If status is clean, skip this step.

---

## Task 14: Manual capability checklist (pilot success gate)

**Files:**
- (none — this is the spec's pilot success gate, executed by the human reviewer)

The five items below correspond 1:1 to the capability checklist in the spec. Mark them off as you verify on the actual systemd deploy. None of these involve code changes.

- [ ] **Item 1: Claude renders the UI**

Connect Claude (web or desktop) to the engine via the existing Cloudflare tunnel. In a chat, ask: "show me my open tasks." Confirm an iframe renders inline showing the result table, not just JSON.

- [ ] **Item 2: Refilter works without re-prompting**

In the rendered UI, click the filter strip to expand. Change `types` to a different value, click Apply. Confirm the table updates with new results AND the model is not re-invoked (no new model turn appears in the chat).

- [ ] **Item 3: Drill-down works**

Click a row to expand. Confirm the body text appears inline within a few hundred ms. Click again to collapse. Click a different row — confirm both bodies render independently and the cache works (re-expanding the first row is instant).

- [ ] **Item 4: Graceful degradation in non-Apps clients**

From a terminal with the Codex CLI (or `mcp-cli`), call `query-nodes` with the same args as Item 1. Capture the JSON envelope. Compare to a baseline you captured before the pilot:

```bash
diff <(jq -S . baseline.json) <(jq -S . current.json)
```

Expected: no diff. The model-facing contract is byte-identical.

- [ ] **Item 5: Production tunnel works end-to-end**

Deploy to archalien (`systemctl restart vault-engine-new`). Open Claude in a browser. Run a real `query-nodes` invocation against the production tunnel. Confirm the iframe loads, refilter works, and drill-down works — through the tunnel, not just locally.

If all five pass: the pilot is **done**. Decisions about extending to other tools (`vault-stats`, `list-undo-history`, etc.) are a separate spec.

If any fail: file a follow-up note inline in the spec under a new "## Pilot results" section, then triage.

---

## Self-review summary

- **Spec coverage:** every capability-checklist item, the architecture, the `ui://` resource registration, the postMessage bridge, the build/deploy story, the testing strategy, and the explicit out-of-scope items all map to a task above (Item 1–5 → Task 14; architecture/lifecycle → Tasks 4–5, 7–9, 12; testing → Tasks 7, 11; build/deploy → Tasks 1–3, 6, 13).
- **Type/name consistency:** `QUERY_NODES_UI_RESOURCE_URI = "ui://vault-engine/query-nodes"` is defined once in `register.ts` and re-imported by both `query-nodes.ts` and the test. The bundle sentinel `<!-- vault-engine query-nodes ui -->` appears in `index.html` and is asserted in `query-nodes-ui.test.ts`. The `App` class API names (`callServerTool`, `ontoolresult`, `onhostcontextchanged`, etc.) match the official ext-apps source verified during research.
- **Placeholder scan:** no TBD/TODO/"appropriate error handling" patterns in any task.
- **Implementation-plan questions from spec:** all four resolved — bundler is Vite + vite-plugin-singlefile (matching the official example), ext-apps version pinned to `^1.7.1`, copy step replaced by Vite output (no separate copy needed), and dev mode requires running `npm run build:ui` first (documented in `register.ts` resolveBundleDir comment, plus the test's `beforeAll` fail-fast).
- **Bundle-missing behavior:** covered by `register.ts`'s top-level try/catch around `readFileSync` (loud throw with actionable message). The test does not separately assert this — adding a dedicated test would require an injection seam that hurts the production code's clarity, which I judged not worth it for the pilot.
- **Rendering safety:** all DOM construction in `app.ts` uses `createElement` + `textContent`. No `innerHTML` assignments anywhere; user-controlled data (filter form values, query results) goes through the browser's text-node API rather than HTML parsing.
