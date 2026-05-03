// tests/mcp/query-nodes-ui.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerQueryNodesUi } from "../../src/mcp/ui/query-nodes/register.js";
import { registerQueryNodes } from "../../src/mcp/tools/query-nodes.js";
import { createTestDb } from "../helpers/db.js";

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

describe("query-nodes tool: UI metadata", () => {
  it("advertises _meta.ui.resourceUri pointing at the UI resource", () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const fakeServer = {
      tool: () => {
        // Should not be called after the migration; if it is, capturedConfig stays undefined.
      },
      registerTool: (_name: string, config: Record<string, unknown>, _handler: unknown) => {
        capturedConfig = config;
      },
    };
    const db = createTestDb();
    registerQueryNodes(fakeServer as unknown as McpServer, db);
    expect(capturedConfig).toBeDefined();
    const meta = capturedConfig!._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe("ui://vault-engine/query-nodes");
  });
});
