import { describe, it, expect } from "vitest";
import { topLevelError, cellWarningsFor } from "../../../../src/mcp/ui/query-nodes/errors.js";
import type { Envelope, Issue } from "../../../../src/mcp/ui/query-nodes/types.js";

const okEnv: Envelope<{ x: number }> = { ok: true, data: { x: 1 }, warnings: [] };
const failEnv: Envelope<unknown> = {
  ok: false,
  error: { code: "VALIDATION_FAILED", message: "Validation failed with 1 error(s)" },
  warnings: [],
};

describe("topLevelError", () => {
  it("returns null for ok envelopes", () => {
    expect(topLevelError(okEnv)).toBeNull();
  });

  it("returns code · message for fail envelopes", () => {
    expect(topLevelError(failEnv)).toBe("VALIDATION_FAILED · Validation failed with 1 error(s)");
  });
});

describe("cellWarningsFor", () => {
  const w1: Issue = { code: "FIELD_OPERATOR_MISMATCH", message: "wrong op", severity: "warning", field: "status" };
  const w2: Issue = { code: "RESULT_TRUNCATED", message: "many rows", severity: "warning" };
  const w3: Issue = { code: "REQUIRED_MISSING", message: "missing", severity: "error", field: "due" };

  it("returns issues whose .field matches the requested field name", () => {
    expect(cellWarningsFor([w1, w2, w3], "status")).toEqual([w1]);
    expect(cellWarningsFor([w1, w2, w3], "due")).toEqual([w3]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(cellWarningsFor([w1, w2, w3], "priority")).toEqual([]);
  });

  it("excludes issues with no .field", () => {
    expect(cellWarningsFor([w2], "status")).toEqual([]);
  });
});
