import type Database from 'better-sqlite3';

export function createAuthSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id                TEXT PRIMARY KEY,
      client_id_issued_at      INTEGER NOT NULL,
      client_secret            TEXT,
      client_secret_expires_at INTEGER,
      metadata                 TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code            TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      code_challenge  TEXT NOT NULL,
      scopes          TEXT NOT NULL DEFAULT '',
      resource        TEXT,
      state           TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token       TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      client_id   TEXT NOT NULL,
      scopes      TEXT NOT NULL DEFAULT '',
      resource    TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_codes(client_id);
  `);
}
