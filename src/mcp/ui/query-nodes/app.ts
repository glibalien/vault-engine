/**
 * Iframe-side entry for the query-nodes MCP App UI (v1, M1).
 *
 * Mount sequence:
 *   1. App.connect → wait for ontoolinput (host pushes args).
 *   2. Ignore ontoolresult; bundle calls query-nodes itself (always-fresh).
 *   3. Resolve type lock from args; if locked, fetch describe-schema + query-nodes.
 *      Else fetch query-nodes first, derive lock from rows, fetch schema.
 *   4. Render header / filter-strip / chip-strip / table.
 *
 * Event delegation routes through a single document.body click listener.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import type { UiState, QueryArgs } from "./types.js";
import { createState, resolveTypeLock, type TypeLock } from "./state.js";
import { makeClient, type Client } from "./client.js";
import { topLevelError } from "./errors.js";

import { renderHeader } from "./render/header.js";
import { renderFilterStrip, readFilterStrip } from "./render/filter-strip.js";
import { renderChipStrip } from "./render/chip-strip.js";
import { renderTable, renderColumnsPicker, defaultVisibleColumns } from "./render/table.js";
import { refresh } from "./flows/refresh.js";

type HostContext = Parameters<NonNullable<App["onhostcontextchanged"]>>[0];

const app = new App({ name: "vault-engine query-nodes UI", version: "1.0.0" });
const client: Client = makeClient(app.callServerTool.bind(app));

let state: UiState | null = null;
let currentLock: TypeLock = { kind: "unlocked", candidates: [] };

function setBanner(text: string | null): void {
  const host = document.getElementById("banner-host");
  if (!host) return;
  host.replaceChildren();
  if (text) {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = text;
    host.appendChild(banner);
  }
}

function setWarnings(warnings: { code: string; message: string }[]): void {
  const host = document.getElementById("warnings-host");
  if (!host) return;
  host.replaceChildren();
  if (!warnings.length) return;
  const lines = warnings.map(w => `${w.code}: ${w.message}`).join("\n");
  const div = document.createElement("div");
  div.className = "warnings";
  div.textContent = lines;
  host.appendChild(div);
}

async function ensureSchema(typeName: string): Promise<void> {
  if (!state) return;
  if (state.schemaCache.has(typeName)) return;
  const env = await client.describeSchema(typeName);
  if (!env.ok) {
    setBanner(`describe-schema failed for "${typeName}": ${env.error.code} · ${env.error.message}`);
    return;
  }
  state.schemaCache.set(typeName, env.data);
}

async function recomputeLockAndRender(): Promise<void> {
  if (!state) return;

  const rows = state.envelope?.ok ? state.envelope.data.nodes : undefined;
  currentLock = resolveTypeLock(state.currentArgs, rows);
  if (currentLock.kind === "locked") {
    state.lockedType = currentLock.type;
    await ensureSchema(currentLock.type);
  } else {
    state.lockedType = null;
  }

  render();
}

function render(): void {
  if (!state) return;

  const lockedSchema = state.lockedType ? state.schemaCache.get(state.lockedType) ?? null : null;

  const headerHost = document.getElementById("header-host")!;
  const filterStripHost = document.getElementById("filter-strip-host")!;
  const chipStripHost = document.getElementById("chip-strip-host")!;
  const tableHost = document.getElementById("table-host")!;

  headerHost.replaceChildren(renderHeader(state, lockedSchema));
  filterStripHost.replaceChildren(renderFilterStrip(state.currentArgs));
  chipStripHost.replaceChildren(renderChipStrip(state, currentLock));

  if (state.envelope && !state.envelope.ok) {
    setBanner(topLevelError(state.envelope));
    tableHost.replaceChildren();
    setWarnings(state.envelope.warnings);
    return;
  }
  setBanner(null);
  setWarnings(state.envelope?.warnings ?? []);

  if (lockedSchema) {
    tableHost.replaceChildren(renderTable(state, lockedSchema));
  } else {
    tableHost.replaceChildren();  // chip strip's "pick a type" banner is sufficient
  }
}

async function applyFilterStrip(): Promise<void> {
  if (!state) return;
  const next: QueryArgs = { ...readFilterStrip() };
  if (Array.isArray(state.currentArgs.types)) next.types = state.currentArgs.types;
  state.currentArgs = next;
  await refresh(state, client);
  await recomputeLockAndRender();
}

async function resetFilterStrip(): Promise<void> {
  if (!state) return;
  state.currentArgs = structuredClone(state.initialArgs);
  await refresh(state, client);
  await recomputeLockAndRender();
}

async function pickType(typeName: string): Promise<void> {
  if (!state) return;
  state.currentArgs = { ...state.currentArgs, types: [typeName] };
  await refresh(state, client);
  await recomputeLockAndRender();
}

function toggleColumnsPicker(): void {
  if (!state || !state.lockedType) return;
  const schema = state.schemaCache.get(state.lockedType);
  if (!schema) return;
  const host = document.getElementById("cols-picker-host")!;
  if (host.classList.contains("open")) {
    host.classList.remove("open");
    host.replaceChildren();
    return;
  }
  host.replaceChildren(renderColumnsPicker(schema, state));
  host.classList.add("open");
}

function onColumnsToggle(field: string): void {
  if (!state || !state.lockedType) return;
  const schema = state.schemaCache.get(state.lockedType);
  if (!schema) return;
  // Materialize defaults on first toggle so the user's diff is well-defined.
  const visible = state.visibleColumns ?? defaultVisibleColumns(schema);
  if (visible.has(field)) visible.delete(field);
  else visible.add(field);
  state.visibleColumns = visible;
  render();
  // Re-render the open picker to reflect the toggle.
  const host = document.getElementById("cols-picker-host")!;
  if (host.classList.contains("open")) {
    host.replaceChildren(renderColumnsPicker(schema, state));
  }
}

async function mount(args: QueryArgs): Promise<void> {
  state = createState(args);

  // Pre-fetch path: if args.types uniquely names a type, fetch schema first
  // so the first render has the column model. Otherwise fetch query-nodes
  // first and derive lock from rows.
  const preLock = resolveTypeLock(state.currentArgs);
  if (preLock.kind === "locked") {
    await ensureSchema(preLock.type);
    await refresh(state, client);
  } else {
    await refresh(state, client);
    const postLock = resolveTypeLock(
      state.currentArgs,
      state.envelope?.ok ? state.envelope.data.nodes : undefined,
    );
    if (postLock.kind === "locked") {
      await ensureSchema(postLock.type);
    }
  }
  await recomputeLockAndRender();
}

app.onhostcontextchanged = (ctx: HostContext) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};

app.ontoolinput = (params) => {
  const args = (params.arguments ?? {}) as QueryArgs;
  void mount(args);
};

// Always-fresh: ignore the host's pre-pushed result. We call query-nodes ourselves.
app.ontoolresult = () => { /* intentionally ignored */ };

app.ontoolcancelled = (params) => {
  console.info("[query-nodes-ui] Tool call cancelled:", params.reason);
};

document.body.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (!target) return;

  if (target.id === "btn-refresh") { void refreshAndRender(); return; }
  if (target.id === "btn-columns") { toggleColumnsPicker(); return; }
  if (target.id === "ff-apply") { void applyFilterStrip(); return; }
  if (target.id === "ff-reset") { void resetFilterStrip(); return; }

  const colsToggle = target.getAttribute("data-cols-toggle");
  if (colsToggle) { onColumnsToggle(colsToggle); return; }

  const chipKind = target.getAttribute("data-chip");
  if (chipKind === "type-pick") {
    const t = target.getAttribute("data-type");
    if (t) void pickType(t);
    return;
  }
});

async function refreshAndRender(): Promise<void> {
  if (!state) return;
  await refresh(state, client);
  await recomputeLockAndRender();
}

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged?.(ctx);
});
