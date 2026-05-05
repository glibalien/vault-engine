import { describe, it, expect, vi } from "vitest";
import { unwrapEnvelope, makeClient } from "../../../../src/mcp/ui/query-nodes/client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function tr(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

describe("unwrapEnvelope", () => {
  it("parses an ok envelope", () => {
    const env = unwrapEnvelope(tr({ ok: true, data: { nodes: [], total: 0 }, warnings: [] }));
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data).toEqual({ nodes: [], total: 0 });
      expect(env.warnings).toEqual([]);
    }
  });

  it("parses a fail envelope", () => {
    const env = unwrapEnvelope(tr({
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
      warnings: [],
    }));
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe("NOT_FOUND");
    }
  });

  it("throws when content[0] is not text", () => {
    expect(() => unwrapEnvelope({ content: [] } as CallToolResult)).toThrow(/missing text content/);
  });

  it("throws on invalid JSON", () => {
    expect(() => unwrapEnvelope({ content: [{ type: "text", text: "not json" }] } as CallToolResult))
      .toThrow();
  });
});

describe("makeClient", () => {
  it("dispatches each tool by name with the given args", async () => {
    const callServerTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === "query-nodes") return tr({ ok: true, data: { nodes: [], total: 0 }, warnings: [] });
      if (name === "describe-schema") return tr({ ok: true, data: { name: "task", display_name: null, fields: [] }, warnings: [] });
      throw new Error(`unexpected ${name}`);
    });

    const client = makeClient(callServerTool);

    const q = await client.queryNodes({ types: ["task"] });
    expect(q.ok).toBe(true);
    expect(callServerTool).toHaveBeenCalledWith({ name: "query-nodes", arguments: { types: ["task"] } });

    const s = await client.describeSchema("task");
    expect(s.ok).toBe(true);
    expect(callServerTool).toHaveBeenLastCalledWith({ name: "describe-schema", arguments: { name: "task" } });
  });
});
