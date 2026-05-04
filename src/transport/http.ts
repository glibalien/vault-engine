import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { VaultOAuthProvider } from '../auth/provider.js';

export type ServerFactory = () => McpServer;

export interface AuthConfig {
  db: Database.Database;
  ownerPassword: string;
  issuerUrl: URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMcpRequestLabel(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;

  const method = body.method;
  if (typeof method !== 'string') return undefined;

  if (method !== 'tools/call') return `MCP ${method}`;

  const params = body.params;
  if (!isRecord(params) || typeof params.name !== 'string') {
    return 'MCP tools/call';
  }

  return `MCP tools/call:${params.name}`;
}

export function describeMcpRequestBody(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    const labels = body
      .map(item => getMcpRequestLabel(item))
      .filter((label): label is string => label !== undefined);

    if (labels.length === 0) return undefined;

    const visibleLabels = labels.slice(0, 5);
    const suffix = labels.length > visibleLabels.length ? ` +${labels.length - visibleLabels.length}` : '';
    return `MCP batch[${visibleLabels.join(', ')}${suffix}]`;
  }

  return getMcpRequestLabel(body);
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const mcpRequest = req.path === '/mcp' ? describeMcpRequestBody(req.body) : undefined;
    const detail = mcpRequest ? ` ${mcpRequest}` : '';
    process.stderr.write(`[vault-engine] ${req.method} ${req.path}${detail} ${res.statusCode} ${duration}ms\n`);
  });
  next();
}

/**
 * CORS middleware for browser-based MCP clients.
 *
 * The MCP 2025-06-18 spec permits clients to run in the browser. Without these
 * headers:
 *   - OPTIONS preflight gets 401'd by bearerAuth and never sees Allow-* headers.
 *   - Even when the actual POST succeeds, the WWW-Authenticate header on a 401
 *     response is not accessible to client JS (it's not a "simple response
 *     header" and CORS hides non-exposed headers), so the client can't read
 *     the resource_metadata URL and can't start OAuth discovery.
 *
 * Exposing WWW-Authenticate, Mcp-Session-Id, and MCP-Protocol-Version lets the
 * client see what it needs; short-circuiting OPTIONS ensures preflight succeeds
 * before any auth middleware runs.
 */
function corsHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function createHttpApp(serverFactory: ServerFactory, authConfig?: AuthConfig): Express {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();
  app.set('trust proxy', 1);

  // CORS must run before auth so OPTIONS preflight isn't 401'd, and before the
  // body parsers so they don't try to parse an empty preflight body.
  app.use(corsHeaders);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(requestLogger);

  // Set up OAuth if auth config provided
  let bearerAuth: RequestHandler = (_req, _res, next) => { next(); };

  if (authConfig) {
    const provider = new VaultOAuthProvider(authConfig.db, authConfig.ownerPassword);

    // Resource server URL = full MCP endpoint path. Per RFC 9728 §3.1/3.2 and
    // MCP 2025-06-18 §3.1.2:
    //   (a) protected-resource metadata lives at
    //       /.well-known/oauth-protected-resource<path>, and
    //   (b) `resource` field in the metadata equals the URL the client
    //       requested.
    // The 2025-11-25 claude.ai client (dumped headers confirm clientInfo name
    // "Anthropic/ClaudeAI", protocolVersion 2025-11-25) requires this and
    // silently gives up on the OAuth flow without it.
    const resourceServerUrl = new URL('/mcp', authConfig.issuerUrl);
    const legacyResourceServerUrl = new URL('/', authConfig.issuerUrl);
    const protectedResourceMetadata = {
      resource: legacyResourceServerUrl.href,
      authorization_servers: [authConfig.issuerUrl.href],
    };

    app.use(mcpAuthRouter({
      provider,
      issuerUrl: authConfig.issuerUrl,
      resourceServerUrl,
      authorizationOptions: {
        rateLimit: { windowMs: 60_000, max: 5 },
      },
    }));

    // Compatibility endpoint for clients that still probe the pre-RFC-9728 root
    // metadata URL instead of using the path-specific URL from WWW-Authenticate.
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
      res.json(protectedResourceMetadata);
    });

    bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', authConfig.issuerUrl).toString(),
    });
  }

  // Conditional auth middleware for /mcp: skip HEAD and sessionless GET (protocol discovery)
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'HEAD') return next();
    if (req.method === 'GET' && !req.headers['mcp-session-id']) return next();
    bearerAuth(req, res, next);
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session ID — create new McpServer + transport for this session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    try {
      const server = serverFactory();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      await transport.close().catch(() => {});
      process.stderr.write(`[vault-engine] HTTP error: ${err instanceof Error ? err.message : err}\n`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.head('/mcp', (_req: Request, res: Response) => {
    res.set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);
    res.status(200).end();
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);
      res.status(200).end();
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header required' });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    sessions.delete(sessionId);
    await transport.handleRequest(req, res);
    await transport.close().catch(() => {});
  });

  return app;
}

export async function startHttpTransport(
  serverFactory: ServerFactory,
  port: number,
  authConfig?: AuthConfig,
): Promise<{ app: Express; httpServer: Server }> {
  const app = createHttpApp(serverFactory, authConfig);

  return new Promise((resolve) => {
    const httpServer = createNodeHttpServer(app);
    httpServer.listen(port, '127.0.0.1', () => {
      process.stderr.write(`[vault-engine] HTTP listening on http://localhost:${port}/mcp\n`);
      resolve({ app, httpServer });
    });
  });
}
