import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'vault-engine',
    version: '0.1.0',
  });

  server.tool(
    'vault-stats',
    'Returns vault statistics. Phase 0 stub — returns placeholder data.',
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'ok', phase: 0, message: 'Phase 0 stub' }),
      }],
    }),
  );

  return server;
}
