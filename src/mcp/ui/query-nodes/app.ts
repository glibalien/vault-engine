/**
 * Iframe-side entry for the query-nodes MCP App UI (v1 — schema-driven table).
 *
 * Bootstrapping stub. Subsequent tasks add modules in this directory:
 * types/state/client/schema/errors, render/*, flows/*.
 */
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "vault-engine query-nodes UI", version: "1.0.0" });

app.connect();
