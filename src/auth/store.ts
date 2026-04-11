import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';

interface ClientRow {
  client_id: string;
  client_id_issued_at: number;
  client_secret: string | null;
  client_secret_expires_at: number | null;
  metadata: string;
}

export class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Database.Database) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare(
      'SELECT * FROM oauth_clients WHERE client_id = ?',
    ).get(clientId) as ClientRow | undefined;

    if (!row) return undefined;

    const metadata = JSON.parse(row.metadata);

    return {
      ...metadata,
      client_id: row.client_id,
      client_id_issued_at: row.client_id_issued_at,
      ...(row.client_secret != null ? { client_secret: row.client_secret } : {}),
      ...(row.client_secret_expires_at != null ? { client_secret_expires_at: row.client_secret_expires_at } : {}),
    };
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const clientId = randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);

    const { client_secret, client_secret_expires_at, ...metadata } = client;

    this.db.prepare(`
      INSERT INTO oauth_clients (client_id, client_id_issued_at, client_secret, client_secret_expires_at, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      clientId,
      issuedAt,
      client_secret ?? null,
      client_secret_expires_at ?? null,
      JSON.stringify(metadata),
    );

    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(client_secret != null ? { client_secret } : {}),
      ...(client_secret_expires_at != null ? { client_secret_expires_at } : {}),
    };
  }
}
