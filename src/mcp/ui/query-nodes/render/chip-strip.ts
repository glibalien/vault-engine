/**
 * Schema-driven filter chip strip.
 *
 * M1: renders only the type-lock chip (or a "pick a type" banner when
 * the lock is unresolved). Field chips arrive in M2.
 */
import type { UiState } from "../types.js";
import type { TypeLock } from "../state.js";
import { el } from "./cell-read.js";

export function renderChipStrip(_state: UiState, lock: TypeLock): HTMLElement {
  const wrap = el("div", { className: "chip-strip" });

  if (lock.kind === "locked") {
    wrap.appendChild(
      el("span", {
        className: "chip chip-type-lock",
        "data-chip": "type-lock",
        "data-type": lock.type,
      }, `type: ${lock.type} ▾`),
    );
    return wrap;
  }

  // Unlocked — render type picker as inline buttons + a banner.
  wrap.appendChild(
    el("div", { className: "chip-banner" },
      el("strong", null, "Pick a type to enable the table."),
      lock.candidates.length > 0
        ? el("span", { className: "chip-banner-hint" }, " Result spans multiple types.")
        : el("span", { className: "chip-banner-hint" }, " No results to derive a type from."),
    ),
  );
  for (const t of lock.candidates) {
    wrap.appendChild(
      el("button", {
        className: "chip chip-type-candidate",
        "data-chip": "type-pick",
        "data-type": t,
      }, t),
    );
  }
  return wrap;
}
