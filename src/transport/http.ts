import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { VaultOAuthProvider } from '../auth/provider.js';

export type ServerFactory = () => McpServer;

export interface AuthConfig {
  db: Database.Database;
  ownerPassword: string;
  issuerUrl: URL;
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    process.stderr.write(`[vault-engine] ${req.method} ${req.path} ${res.statusCode} ${duration}ms\n`);
  });
  next();
}

export function createHttpApp(serverFactory: ServerFactory, authConfig?: AuthConfig): Express {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();
  app.set('trust proxy', 1);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(requestLogger);

  // Set up OAuth if auth config provided
  let bearerAuth: RequestHandler = (_req, _res, next) => { next(); };

  if (authConfig) {
    const provider = new VaultOAuthProvider(authConfig.db, authConfig.ownerPassword);

    app.use(mcpAuthRouter({
      provider,
      issuerUrl: authConfig.issuerUrl,
      authorizationOptions: {
        rateLimit: { windowMs: 60_000, max: 5 },
      },
    }));

    // resourceMetadataUrl adds resource_metadata="..." to the WWW-Authenticate
    // header on 401 responses. Required by the MCP 2025-06-18 auth spec so
    // clients can discover the OAuth metadata endpoint and start the auth flow.
    bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource', authConfig.issuerUrl).toString(),
    });
  }

  // Conditional auth middleware for /mcp: skip HEAD and sessionless GET (protocol discovery)
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    // DEBUG: temporary diagnostic for claude.ai 401 issue
    const authHeader = req.headers.authorization;
    const ua = req.headers['user-agent'] ?? '';
    const sess = req.headers['mcp-session-id'] ?? '';
    process.stderr.write(`[mcp-debug] ${req.method} authz=${authHeader ? authHeader.substring(0,20) + '...' : 'MISSING'} session=${sess} ua=${typeof ua === 'string' ? ua.substring(0, 60) : ''}\n`);

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
    res.set('MCP-Protocol-Version', '2025-03-26');
    res.status(200).end();
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.set('MCP-Protocol-Version', '2025-03-26');
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
