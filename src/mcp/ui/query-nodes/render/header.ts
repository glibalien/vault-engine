/**
 * Top header row: title (locked-type display name), result count, refresh
 * button, ⚙ Columns toggle. Click handlers are attached at the app event
 * delegation root, not here.
 */
import type { Schema, UiState } from "../types.js";
import { el } from "./cell-read.js";

export function renderHeader(state: UiState, schema: Schema | null): HTMLElement {
  const title = schema?.display_name ?? schema?.name ?? "(no type lock)";
  const total = state.envelope?.ok ? state.envelope.data.total : 0;

  return el("div", { className: "header-bar" },
    el("div", { className: "header-title" },
      el("strong", null, title),
      el("span", { className: "header-count" }, ` ${total} result${total === 1 ? "" : "s"}`),
    ),
    el("div", { className: "header-actions" },
      el("button", { id: "btn-refresh", className: "header-button" }, "↻ Refresh"),
      el("button", { id: "btn-columns", className: "header-button header-button-secondary" }, "⚙ Columns"),
    ),
  );
}
