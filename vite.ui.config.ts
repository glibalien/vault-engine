// vite.ui.config.ts
//
// Dedicated Vite config used only by `npm run build:ui` to produce the
// self-contained HTML bundle for the query-nodes MCP App UI. The MCP server
// itself does NOT use Vite; this config exists only to bundle the iframe.
//
// Pattern lifted from the ext-apps `basic-server-vanillajs` example.
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const isDev = process.env.NODE_ENV === "development";

export default defineConfig({
  // Treat the UI source dir as Vite's project root so module resolution
  // and the input filename stay simple (just "index.html").
  root: "src/mcp/ui/query-nodes",
  plugins: [viteSingleFile()],
  build: {
    sourcemap: isDev ? "inline" : undefined,
    cssMinify: !isDev,
    minify: !isDev,
    rollupOptions: { input: "index.html" },
    // Relative to `root`. Lands at <repo>/dist/mcp/ui/query-nodes/index.html.
    outDir: "../../../../dist/mcp/ui/query-nodes",
    emptyOutDir: false,
  },
});
