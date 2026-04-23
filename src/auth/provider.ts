import type Database from 'better-sqlite3';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { SqliteClientsStore } from './store.js';

export const ACCESS_TOKEN_TTL = 3600;       // 1 hour
export const REFRESH_TOKEN_TTL = 2592000;   // 30 days
const AUTH_CODE_TTL = 600;                  // 10 minutes

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifyPassword(input: string, expected: string): boolean {
  const inputHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAuthForm(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  error?: string,
): string {
  const clientName = client.client_name ?? client.client_id;
  const scope = params.scopes?.join(' ') ?? '';
  return `<!DOCTYPE html>
<html>
<head><title>Authorize - vault-engine</title></head>
<body>
  <h1>Authorize</h1>
  <p>Client <strong>${escapeHtml(clientName)}</strong> (${escapeHtml(client.client_id)}) is requesting access.</p>
  ${error ? `<p style="color:red">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="response_type" value="code">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="S256">
    ${params.state ? `<input type="hidden" name="state" value="${escapeHtml(params.state)}">` : ''}
    ${scope ? `<input type="hidden" name="scope" value="${escapeHtml(scope)}">` : ''}
    ${params.resource ? `<input type="hidden" name="resource" value="${escapeHtml(params.resource.toString())}">` : ''}
    <label>Password: <input type="password" name="password" required autofocus></label>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}

// Row type interfaces used by later tasks
interface CodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  state: string | null;
  created_at: number;
  expires_at: number;
}

interface TokenRow {
  token: string;
  type: string;
  client_id: string;
  scopes: string;
  resource: string | null;
  created_at: number;
  expires_at: number;
  revoked: number;
}

export class VaultOAuthProvider implements OAuthServerProvider {
  private readonly store: SqliteClientsStore;

  constructor(
    private readonly db: Database.Database,
    private readonly ownerPassword: string,
  ) {
    this.store = new SqliteClientsStore(db);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.store;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const password = (res.req as { body?: Record<string, string> })?.body?.password;

    if (!password) {
      res.type('html').send(renderAuthForm(client, params));
      return;
    }

    if (!verifyPassword(password, this.ownerPassword)) {
      res.type('html').send(renderAuthForm(client, params, 'Invalid password'));
      return;
    }

    const code = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, scopes, resource, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      client.client_id,
      params.redirectUri,
      params.codeChallenge,
      params.scopes?.join(' ') ?? '',
      params.resource?.toString() ?? null,
      params.state ?? null,
      now,
      now + AUTH_CODE_TTL,
    );

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT code_challenge FROM oauth_codes WHERE code = ? AND client_id = ? AND expires_at > ?',
    ).get(authorizationCode, client.client_id, now) as { code_challenge: string } | undefined;

    if (!row) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT * FROM oauth_codes WHERE code = ? AND expires_at > ?',
    ).get(authorizationCode, now) as CodeRow | undefined;

    if (!row) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (row.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri && row.redirect_uri !== redirectUri) {
      throw new InvalidGrantError('Redirect URI mismatch');
    }

    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const scopes = row.scopes;
    const tokenResource = resource?.toString() ?? row.resource;

    const exchangeTransaction = this.db.transaction(() => {
      // Delete code (single-use)
      this.db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(authorizationCode);

      // Generate tokens
      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'access', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(accessToken), client.client_id, scopes, tokenResource, now, now + ACCESS_TOKEN_TTL);

      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'refresh', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(refreshToken), client.client_id, scopes, tokenResource, now, now + REFRESH_TOKEN_TTL);
    });
    exchangeTransaction();

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE token = ? AND type = \'refresh\' AND revoked = 0 AND expires_at > ?',
    ).get(tokenHash, now) as TokenRow | undefined;

    if (!row || row.client_id !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }

    const newAccessToken = randomBytes(32).toString('hex');
    const newRefreshToken = randomBytes(32).toString('hex');
    const tokenResource = resource?.toString() ?? row.resource;

    const refreshTransaction = this.db.transaction(() => {
      // Revoke old refresh token
      this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token = ?').run(tokenHash);

      // Generate new tokens
      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'access', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(newAccessToken), client.client_id, row.scopes, tokenResource, now, now + ACCESS_TOKEN_TTL);

      this.db.prepare(`
        INSERT INTO oauth_tokens (token, type, client_id, scopes, resource, created_at, expires_at, revoked)
        VALUES (?, 'refresh', ?, ?, ?, ?, ?, 0)
      `).run(hashToken(newRefreshToken), client.client_id, row.scopes, tokenResource, now, now + REFRESH_TOKEN_TTL);
    });
    refreshTransaction();

    return {
      access_token: newAccessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: newRefreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE token = ? AND type = \'access\' AND revoked = 0 AND expires_at > ?',
    ).get(tokenHash, now) as TokenRow | undefined;

    if (!row) {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes ? row.scopes.split(' ').filter(Boolean) : [],
      expiresAt: row.expires_at,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);

    const row = this.db.prepare(
      'SELECT * FROM oauth_tokens WHERE token = ?',
    ).get(tokenHash) as TokenRow | undefined;

    if (!row || row.client_id !== client.client_id) return;

    this.db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token = ?').run(tokenHash);

    // Cascade: revoking a refresh token also revokes all access tokens for the client
    if (row.type === 'refresh') {
      this.db.prepare(
        'UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND type = \'access\' AND revoked = 0',
      ).run(client.client_id);
    }
  }
}
