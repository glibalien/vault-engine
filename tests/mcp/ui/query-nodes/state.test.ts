import { describe, it, expect } from "vitest";
import { createState, resolveTypeLock } from "../../../../src/mcp/ui/query-nodes/state.js";
import type { NodeRow } from "../../../../src/mcp/ui/query-nodes/types.js";

function row(types: string[]): NodeRow {
  return {
    id: `id-${types.join("-")}`,
    file_path: "x.md",
    title: "x",
    types,
    version: 1,
    field_count: 0,
  };
}

describe("createState", () => {
  it("returns a fresh state with empty caches and the provided args", () => {
    const args = { types: ["task"] };
    const s = createState(args);
    expect(s.initialArgs).toEqual(args);
    expect(s.currentArgs).toEqual(args);
    expect(s.initialArgs).not.toBe(args);  // deep clone
    expect(s.lockedType).toBeNull();
    expect(s.schemaCache.size).toBe(0);
    expect(s.envelope).toBeNull();
    expect(s.visibleColumns).toBeNull();
    expect(s.inflight.size).toBe(0);
  });
});

describe("resolveTypeLock", () => {
  it("locks to args.types when exactly one is given", () => {
    expect(resolveTypeLock({ types: ["task"] })).toEqual({ kind: "locked", type: "task" });
  });

  it("locks to result-row consensus when args.types is empty and all rows share a type", () => {
    const rows = [row(["task"]), row(["task"]), row(["task"])];
    expect(resolveTypeLock({}, rows)).toEqual({ kind: "locked", type: "task" });
  });

  it("locks to result-row consensus when args.types is empty and rows share types[0]", () => {
    const rows = [row(["task", "archived"]), row(["task"])];
    expect(resolveTypeLock({}, rows)).toEqual({ kind: "locked", type: "task" });
  });

  it("returns unlocked + candidate list when rows span multiple types", () => {
    const rows = [row(["task"]), row(["project"]), row(["task"])];
    expect(resolveTypeLock({}, rows)).toEqual({
      kind: "unlocked",
      candidates: ["project", "task"],
    });
  });

  it("returns unlocked when args.types has multiple entries", () => {
    const rows = [row(["task"]), row(["project"])];
    expect(resolveTypeLock({ types: ["task", "project"] }, rows)).toEqual({
      kind: "unlocked",
      candidates: ["project", "task"],
    });
  });

  it("returns unlocked with no candidates when no rows are available", () => {
    expect(resolveTypeLock({})).toEqual({ kind: "unlocked", candidates: [] });
  });

  it("returns unlocked with no candidates for an empty result set", () => {
    expect(resolveTypeLock({}, [])).toEqual({ kind: "unlocked", candidates: [] });
  });
});
