/**
 * Slimmed generic filter strip — query-shape primitives only.
 * The pilot's `types` input is gone (it's the type-lock chip in M2).
 *
 * Inputs: title_contains, query, sort_by, sort_order, limit.
 * Click "Apply" to refilter. The flow is wired in app.ts.
 */
import type { QueryArgs } from "../types.js";
import { el } from "./cell-read.js";

export function renderFilterStrip(args: QueryArgs): HTMLElement {
  const titleInput = el("input", { id: "ff-title", placeholder: "title contains…" });
  (titleInput as HTMLInputElement).value = (args.title_contains as string) ?? "";

  const queryInput = el("input", { id: "ff-query", placeholder: "hybrid search…" });
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

  return el("div", { className: "filter-strip" },
    el("label", null, "title ", titleInput),
    el("label", null, "query ", queryInput),
    el("label", null, "sort ", sortBy, sortOrder),
    el("label", null, "limit ", limitInput),
    el("button", { id: "ff-apply", className: "header-button" }, "Apply"),
    el("button", { id: "ff-reset", className: "header-button header-button-secondary" }, "Reset"),
  );
}

export function readFilterStrip(): QueryArgs {
  const title_contains = (document.getElementById("ff-title") as HTMLInputElement | null)?.value.trim() ?? "";
  const query = (document.getElementById("ff-query") as HTMLInputElement | null)?.value.trim() ?? "";
  const sort_by = (document.getElementById("ff-sort-by") as HTMLSelectElement | null)?.value ?? "title";
  const sort_order = (document.getElementById("ff-sort-order") as HTMLSelectElement | null)?.value ?? "asc";
  const limit = parseInt((document.getElementById("ff-limit") as HTMLInputElement | null)?.value ?? "50", 10) || 50;
  const args: QueryArgs = { sort_by, sort_order, limit };
  if (title_contains) args.title_contains = title_contains;
  if (query) args.query = query;
  return args;
}
