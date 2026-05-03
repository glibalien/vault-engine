// src/global-fields/ui-hints.ts
//
// UiHints — closed-vocabulary rendering hints stored on global fields.
// Spec: docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md

export const UI_WIDGETS = [
  'text', 'textarea', 'enum', 'date', 'number', 'bool', 'link', 'tags',
] as const;

export type UiWidget = (typeof UI_WIDGETS)[number];

export interface UiHints {
  widget?: UiWidget;
  label?: string;
  help?: string;
  order?: number;
}

const ALLOWED_KEYS = new Set<string>(['widget', 'label', 'help', 'order']);
const LABEL_MAX = 80;
const HELP_MAX = 280;

export type ValidateResult =
  | { ok: true; value: UiHints }
  | { ok: false; reason: string };

export function validateUiHints(input: unknown): ValidateResult {
  if (input === null || input === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'ui must be an object' };
  }

  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: `ui has unknown key '${key}' (allowed: ${[...ALLOWED_KEYS].join(', ')})` };
    }
  }

  const out: UiHints = {};

  if ('widget' in obj) {
    const w = obj.widget;
    if (typeof w !== 'string' || !(UI_WIDGETS as readonly string[]).includes(w)) {
      return { ok: false, reason: `ui.widget must be one of ${UI_WIDGETS.join(', ')}` };
    }
    out.widget = w as UiWidget;
  }

  if ('label' in obj) {
    const l = obj.label;
    if (typeof l !== 'string') return { ok: false, reason: 'ui.label must be a string' };
    if (l.length > LABEL_MAX) return { ok: false, reason: `ui.label must be ≤ ${LABEL_MAX} chars` };
    out.label = l;
  }

  if ('help' in obj) {
    const h = obj.help;
    if (typeof h !== 'string') return { ok: false, reason: 'ui.help must be a string' };
    if (h.length > HELP_MAX) return { ok: false, reason: `ui.help must be ≤ ${HELP_MAX} chars` };
    out.help = h;
  }

  if ('order' in obj) {
    const o = obj.order;
    if (typeof o !== 'number' || !Number.isFinite(o) || !Number.isInteger(o)) {
      return { ok: false, reason: 'ui.order must be a finite integer' };
    }
    out.order = o;
  }

  return { ok: true, value: out };
}

/**
 * Convert an authored UiHints input into the value to persist:
 *   - null / undefined / empty object → null (clear hints)
 *   - non-empty object → the object as-is
 *
 * Caller is responsible for running validateUiHints first.
 */
export function normalizeUiHints(value: UiHints | null | undefined): UiHints | null {
  if (value === null || value === undefined) return null;
  if (Object.keys(value).length === 0) return null;
  return value;
}
