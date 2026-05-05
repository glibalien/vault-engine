/**
 * Table orchestrator. Computes header columns from the cached schema +
 * visibility rules, and body rows from the query envelope's data.nodes.
 *
 * Column visibility (M1 default; user can override via "⚙ Columns"):
 *   - title (synthetic): always shown
 *   - text / enum / date / number / bool / link (single ref): shown
 *   - textarea / tags / list-of-reference: hidden
 *   - body: never shown
 */
import type { NodeRow, Schema, SchemaField, UiState, WidgetValue } from "../types.js";
import { widgetForField, claimedFields } from "../schema.js";
import { renderCell, el } from "./cell-read.js";

const HIDDEN_BY_DEFAULT_WIDGETS: ReadonlySet<WidgetValue> = new Set(["textarea", "tags"]);

export function defaultVisibleColumns(schema: Schema): Set<string> {
  const visible = new Set<string>(["__title__"]);
  for (const f of claimedFields(schema)) {
    const w = widgetForField(f);
    if (HIDDEN_BY_DEFAULT_WIDGETS.has(w)) continue;
    if (f.type === "list" && f.list_item_type === "reference") continue;
    visible.add(f.name);
  }
  return visible;
}

function effectiveVisible(state: UiState, schema: Schema): Set<string> {
  return state.visibleColumns ?? defaultVisibleColumns(schema);
}

export function renderTable(state: UiState, schema: Schema): HTMLElement {
  const visible = effectiveVisible(state, schema);
  const fieldsToRender: SchemaField[] = claimedFields(schema).filter(f => visible.has(f.name));

  const headerCells: Node[] = [el("th", { className: "th th-title" }, "title")];
  for (const f of fieldsToRender) {
    headerCells.push(el("th", { className: "th" }, f.label ?? f.name));
  }

  const headerRow = el("tr", null, ...headerCells);

  const rows = state.envelope?.ok ? state.envelope.data.nodes : [];
  const bodyRows: Node[] = rows.length === 0
    ? [el("tr", null, el("td", { className: "td-empty", colspan: String(headerCells.length) }, "No results."))]
    : rows.map(row => renderBodyRow(row, fieldsToRender));

  return el("table", { className: "results-table" },
    el("thead", null, headerRow),
    el("tbody", null, ...bodyRows),
  );
}

function renderBodyRow(row: NodeRow, fields: SchemaField[]): HTMLElement {
  const titleCell = el("td", { className: "td td-title", "data-id": row.id, "data-field": "__title__" },
    el("strong", null, row.title ?? "(untitled)"),
  );
  const fieldCells = fields.map(f => {
    const widget = widgetForField(f);
    const cell = renderCell(widget, row.fields?.[f.name]);
    return el("td", { className: "td", "data-id": row.id, "data-field": f.name }, cell);
  });
  return el("tr", { className: "tr-row", "data-id": row.id }, titleCell, ...fieldCells);
}

export function renderColumnsPicker(schema: Schema, state: UiState): HTMLElement {
  const visible = effectiveVisible(state, schema);
  const items = claimedFields(schema).map(f => {
    const attrs: Record<string, string> = {
      type: "checkbox",
      "data-cols-toggle": f.name,
    };
    if (visible.has(f.name)) attrs.checked = "checked";
    const checkbox = el("input", attrs);
    return el("label", { className: "cols-picker-row" }, checkbox, " ", f.label ?? f.name);
  });
  return el("div", { className: "cols-picker" }, ...items);
}
