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
