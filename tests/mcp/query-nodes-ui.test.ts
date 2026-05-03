// tests/mcp/query-nodes-ui.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerQueryNodesUi } from "../../src/mcp/ui/query-nodes/register.js";

const BUNDLE_PATH = path.resolve("dist/mcp/ui/query-nodes/index.html");

beforeAll(() => {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      `query-nodes UI bundle missing at ${BUNDLE_PATH}. Run \`npm run build:ui\` (or \`npm run build\`) before this test.`,
    );
  }
});

interface CapturedResource {
  name: string;
  uri: string;
  config: { mimeType?: string; [k: string]: unknown };
  body: string;
}

async function captureResource(): Promise<CapturedResource> {
  let captured: CapturedResource | undefined;
  const fakeServer = {
    registerResource: async (
      name: string,
      uri: string,
      config: Record<string, unknown>,
      cb: (uri: URL) => Promise<{ contents: Array<{ text?: string }> }>,
    ) => {
      const result = await cb(new URL(uri));
      captured = {
        name,
        uri,
        config,
        body: result.contents[0]?.text ?? "",
      };
    },
  } as unknown as McpServer;
  registerQueryNodesUi(fakeServer);
  // Registration is sync; the read callback is async. Wait a tick for it.
  await new Promise(r => setTimeout(r, 0));
  if (!captured) throw new Error("registerResource was never called");
  return captured;
}

describe("registerQueryNodesUi", () => {
  it("registers the ui:// resource at the expected URI", async () => {
    const r = await captureResource();
    expect(r.uri).toBe("ui://vault-engine/query-nodes");
  });

  it("serves the bundled HTML containing the sentinel", async () => {
    const r = await captureResource();
    expect(r.body).toContain("<!-- vault-engine query-nodes ui -->");
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it("uses the MCP App MIME type", async () => {
    const r = await captureResource();
    expect(r.config.mimeType).toBe("text/html;profile=mcp-app");
  });
});
