import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * What the owner login and the OAuth server remember: registered clients, authorization codes,
 * tokens and browser sessions. Its own file (auth.db), so unlinking WhatsApp — which wipes the
 * archive — never signs anyone out. Codes, tokens and session ids are stored hashed.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data      TEXT NOT NULL,
  created   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  scopes         TEXT NOT NULL,
  expires        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash      TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  pair      TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource  TEXT,
  scopes    TEXT NOT NULL,
  expires   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_tokens_pair ON oauth_tokens (pair);
CREATE TABLE IF NOT EXISTS owner_sessions (
  hash    TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
`;

export interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string | null;
  scopes: string[];
  expires: number;
}

export interface TokenRecord {
  kind: 'access' | 'refresh';
  pair: string;
  clientId: string;
  resource: string | null;
  scopes: string[];
  expires: number;
}

/** A fresh secret: 32 random bytes, URL-safe. */
export const newSecret = (): string => randomBytes(32).toString('base64url');
/** How secrets are stored: never in clear. */
export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const now = () => Math.floor(Date.now() / 1000);

export class AuthStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.prune();
  }

  close(): void {
    this.db.close();
  }

  /** Drops what has expired. Clients stay: a client is not a secret, and tokens refer to it. */
  prune(): void {
    const t = now();
    this.db.prepare('DELETE FROM oauth_codes WHERE expires < ?').run(t);
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires < ?').run(t);
    this.db.prepare('DELETE FROM owner_sessions WHERE expires < ?').run(t);
  }

  // --- clients ---------------------------------------------------------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT data FROM oauth_clients WHERE client_id = ?').get(clientId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare('INSERT INTO oauth_clients (client_id, data, created) VALUES (?, ?, ?) ON CONFLICT (client_id) DO UPDATE SET data = excluded.data')
      .run(client.client_id, JSON.stringify(client), now());
  }

  // --- authorization codes -----------------------------------------------------

  saveCode(code: string, record: CodeRecord): void {
    this.db
      .prepare('INSERT INTO oauth_codes (hash, client_id, code_challenge, redirect_uri, resource, scopes, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashSecret(code), record.clientId, record.codeChallenge, record.redirectUri, record.resource, JSON.stringify(record.scopes), record.expires);
  }

  getCode(code: string): CodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE hash = ? AND expires >= ?').get(hashSecret(code), now()) as
      | { client_id: string; code_challenge: string; redirect_uri: string; resource: string | null; scopes: string; expires: number }
      | undefined;
    if (!row) return undefined;
    return { clientId: row.client_id, codeChallenge: row.code_challenge, redirectUri: row.redirect_uri, resource: row.resource, scopes: JSON.parse(row.scopes), expires: row.expires };
  }

  /** Reads a code and burns it in the same step: a code is good once. */
  takeCode(code: string): CodeRecord | undefined {
    return this.db.transaction(() => {
      const record = this.getCode(code);
      this.db.prepare('DELETE FROM oauth_codes WHERE hash = ?').run(hashSecret(code));
      return record;
    })();
  }

  // --- tokens ------------------------------------------------------------------

  saveToken(token: string, record: TokenRecord): void {
    this.db
      .prepare('INSERT INTO oauth_tokens (hash, kind, pair, client_id, resource, scopes, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashSecret(token), record.kind, record.pair, record.clientId, record.resource, JSON.stringify(record.scopes), record.expires);
  }

  getToken(token: string): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE hash = ? AND expires >= ?').get(hashSecret(token), now()) as
      | { kind: 'access' | 'refresh'; pair: string; client_id: string; resource: string | null; scopes: string; expires: number }
      | undefined;
    if (!row) return undefined;
    return { kind: row.kind, pair: row.pair, clientId: row.client_id, resource: row.resource, scopes: JSON.parse(row.scopes), expires: row.expires };
  }

  /** Revokes an access token together with its refresh token, or the other way round. */
  deletePair(pair: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE pair = ?').run(pair);
  }

  /** Every token ever issued: "sign every assistant out". */
  deleteAllTokens(): void {
    this.db.exec('DELETE FROM oauth_tokens');
  }

  // --- owner sessions (the cookie) ---------------------------------------------

  saveSession(id: string, expires: number): void {
    this.db.prepare('INSERT INTO owner_sessions (hash, expires) VALUES (?, ?)').run(hashSecret(id), expires);
  }

  hasSession(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM owner_sessions WHERE hash = ? AND expires >= ?').get(hashSecret(id), now()) !== undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM owner_sessions WHERE hash = ?').run(hashSecret(id));
  }
}
