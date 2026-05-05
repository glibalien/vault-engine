/**
 * Envelope/Issue → user-surface adapters.
 *
 * topLevelError formats a fail envelope as a banner-ready string.
 * cellWarningsFor partitions the .warnings array by Issue.field for
 * per-cell error chip rendering (relies on the Foundation #2.5 audit
 * that pinned Issue.field population at every per-field site).
 */
import type { Envelope, Issue } from "./types.js";

export function topLevelError(envelope: Envelope<unknown>): string | null {
  if (envelope.ok) return null;
  return `${envelope.error.code} · ${envelope.error.message}`;
}

export function cellWarningsFor(warnings: Issue[], fieldName: string): Issue[] {
  return warnings.filter(w => w.field === fieldName);
}
