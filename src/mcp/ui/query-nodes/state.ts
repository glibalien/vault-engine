/**
 * UI state factory and type-lock resolution rules.
 *
 * Type-lock resolution (per spec):
 *   1. args.types has exactly one value → lock to it.
 *   2. else: result rows all share types[0] → lock to it.
 *   3. else: unlocked, surface candidate list (sorted, de-duped).
 */
import type { NodeRow, QueryArgs, UiState } from "./types.js";

export function createState(args: QueryArgs): UiState {
  return {
    initialArgs: structuredClone(args),
    currentArgs: structuredClone(args),
    lockedType: null,
    schemaCache: new Map(),
    envelope: null,
    visibleColumns: null,
    inflight: new Set(),
  };
}

export type TypeLock =
  | { kind: "locked"; type: string }
  | { kind: "unlocked"; candidates: string[] };

export function resolveTypeLock(args: QueryArgs, rows?: NodeRow[]): TypeLock {
  const argTypes = Array.isArray(args.types) ? (args.types as string[]) : [];
  if (argTypes.length === 1) {
    return { kind: "locked", type: argTypes[0]! };
  }

  if (rows && rows.length > 0) {
    const firstTypes = rows.map(r => r.types[0]).filter((t): t is string => typeof t === "string");
    if (firstTypes.length > 0 && firstTypes.every(t => t === firstTypes[0])) {
      return { kind: "locked", type: firstTypes[0]! };
    }
    const candidates = Array.from(new Set(firstTypes)).sort();
    return { kind: "unlocked", candidates };
  }

  return { kind: "unlocked", candidates: [] };
}
