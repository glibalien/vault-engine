// src/mcp/ui/query-nodes/register.ts
//
// Server-side registration of the query-nodes MCP App UI resource.
// Reads the bundled index.html (produced by `npm run build:ui`) at startup
// and serves it via registerAppResource at ui://vault-engine/query-nodes.
//
// Tool-side metadata (_meta.ui.resourceUri) is wired in src/mcp/tools/query-nodes.ts
// so the model and the host see the link advertised on the tool itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const QUERY_NODES_UI_RESOURCE_URI = "ui://vault-engine/query-nodes";

/**
 * Resolve the directory containing the bundled HTML, working from both
 * source (tsx watch / vitest) and compiled (node dist/index.js) entry points.
 *
 * In dev (tsx), import.meta.filename ends in .ts and points at
 * src/mcp/ui/query-nodes/register.ts — we redirect to dist/ where the
 * bundled HTML lives (built by `npm run build:ui`).
 *
 * In prod, import.meta.dirname is dist/mcp/ui/query-nodes already, where
 * vite-plugin-singlefile placed the bundle.
 */
function resolveBundleDir(): string {
  if (import.meta.filename?.endsWith(".ts")) {
    // src/mcp/ui/query-nodes/register.ts → repo root → dist/mcp/ui/query-nodes/
    return path.resolve(import.meta.dirname!, "..", "..", "..", "..", "dist", "mcp", "ui", "query-nodes");
  }
  return import.meta.dirname!;
}

const BUNDLE_PATH = path.join(resolveBundleDir(), "index.html");

// Read once at module load. Throws if the bundle is missing — fail-fast
// rather than registering a resource that 404s on every fetch.
let cachedHtml: string;
try {
  cachedHtml = readFileSync(BUNDLE_PATH, "utf-8");
} catch (err) {
  throw new Error(
    `query-nodes UI bundle not found at ${BUNDLE_PATH}. Run \`npm run build:ui\` first. Underlying error: ${(err as Error).message}`,
  );
}

export function registerQueryNodesUi(server: McpServer): void {
  registerAppResource(
    server,
    "query-nodes UI",
    QUERY_NODES_UI_RESOURCE_URI,
    {
      description: "Interactive table view for query-nodes results",
    },
    async () => ({
      contents: [
        {
          uri: QUERY_NODES_UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: cachedHtml,
        },
      ],
    }),
  );
}
