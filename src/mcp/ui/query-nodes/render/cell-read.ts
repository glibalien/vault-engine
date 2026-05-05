/**
 * Per-widget read-only cell renderer.
 *
 * Each function takes a value (possibly null/undefined) and returns an
 * HTMLElement. Edit-mode editors land in cell-edit.ts (M3); the dispatch
 * key here is identical so the M3 swap is mechanical.
 */
import type { WidgetValue } from "../types.js";

type Child = string | Node | null | undefined | Child[];

export function el<K extends keyof HTMLElementTagNameMap>(
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

function emptyCell(): HTMLElement {
  return el("span", { className: "cell-empty" }, "—");
}

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function renderText(value: unknown): HTMLElement {
  const s = asString(value);
  return s ? el("span", { className: "cell-text" }, s) : emptyCell();
}

function renderTextarea(value: unknown): HTMLElement {
  const s = asString(value);
  if (!s) return emptyCell();
  const truncated = s.length > 120 ? s.slice(0, 117) + "…" : s;
  return el("span", { className: "cell-textarea", title: s }, truncated);
}

function renderEnum(value: unknown): HTMLElement {
  const s = asString(value);
  return s ? el("span", { className: "cell-enum" }, s) : emptyCell();
}

function renderDate(value: unknown): HTMLElement {
  const s = asString(value);
  return s ? el("span", { className: "cell-date" }, s) : emptyCell();
}

function renderNumber(value: unknown): HTMLElement {
  if (value == null || value === "") return emptyCell();
  return el("span", { className: "cell-number" }, asString(value));
}

function renderBool(value: unknown): HTMLElement {
  if (value == null) return emptyCell();
  return el("span", { className: "cell-bool" }, value ? "✓" : "✗");
}

function renderLink(value: unknown): HTMLElement {
  if (value == null || value === "") return emptyCell();
  if (Array.isArray(value)) {
    if (value.length === 0) return emptyCell();
    const wrap = el("span", { className: "cell-link-multi" });
    value.forEach((v, i) => {
      if (i > 0) wrap.appendChild(document.createTextNode(", "));
      wrap.appendChild(el("span", { className: "cell-link-chip" }, asString(v)));
    });
    return wrap;
  }
  return el("span", { className: "cell-link" }, asString(value));
}

function renderTags(value: unknown): HTMLElement {
  if (!Array.isArray(value) || value.length === 0) return emptyCell();
  const wrap = el("span", { className: "cell-tags" });
  value.forEach((v, i) => {
    if (i > 0) wrap.appendChild(document.createTextNode(" "));
    wrap.appendChild(el("span", { className: "cell-tag-chip" }, asString(v)));
  });
  return wrap;
}

const renderers: Record<WidgetValue, (value: unknown) => HTMLElement> = {
  text: renderText,
  textarea: renderTextarea,
  enum: renderEnum,
  date: renderDate,
  number: renderNumber,
  bool: renderBool,
  link: renderLink,
  tags: renderTags,
};

export function renderCell(widget: WidgetValue, value: unknown): HTMLElement {
  return renderers[widget](value);
}
