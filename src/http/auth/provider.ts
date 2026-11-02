import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Owner } from './owner.ts';
import { loginPage } from './page.ts';
import { newSecret, type AuthStore } from './store.ts';

/**
 * The OAuth 2.1 authorization server for one owner. Assistants register themselves (dynamic
 * client registration), the owner approves them once with the passphrase, and from then on they
 * carry a bearer token that is refreshed and rotated. The SDK handles the protocol; this class
 * keeps the records and decides who gets in.
 */

const CODE_SECONDS = 10 * 60;
const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 90 * 86400;

/** Where the consent form posts; served by the app, not by the SDK router. */
export const APPROVE_PATH = '/oauth/approve';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Only https redirects, or loopback http for native clients such as Claude Code. */
function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

export class OwnerAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly store: AuthStore;
  private readonly owner: Owner;
  /** The MCP endpoint: what every token is for, whether or not the client said so. */
  private readonly resource: URL;

  constructor(store: AuthStore, owner: Owner, resource: URL) {
    this.store = store;
    this.owner = owner;
    this.resource = resource;
    this.clientsStore = {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: (client) => {
        const bad = client.redirect_uris.filter((u) => !acceptableRedirect(u));
        if (bad.length) throw new InvalidClientMetadataError(`redirect_uris must be https, or http on localhost: ${bad.join(', ')}`);
        const full = client as OAuthClientInformationFull;
        store.saveClient(full);
        return full;
      },
    };
  }

  /** Shows the consent page. The approval itself comes back as a POST to APPROVE_PATH. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      loginPage({
        action: APPROVE_PATH,
        hidden: {
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          state: params.state,
          code_challenge: params.codeChallenge,
          scope: params.scopes?.join(' ') || undefined,
          resource: params.resource?.href,
        },
        client: { name: client.client_name || client.client_id, redirectHost: new URL(params.redirectUri).host },
        signedIn: this.owner.isSignedIn(res.req),
      }),
    );
  }

  /** The owner said yes: a single-use code the client swaps for tokens within ten minutes. */
  issueCode(client: OAuthClientInformationFull, params: AuthorizationParams): string {
    const code = newSecret();
    this.store.saveCode(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href ?? this.resource.href,
      scopes: params.scopes ?? [],
      expires: Math.floor(Date.now() / 1000) + CODE_SECONDS,
    });
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = this.store.getCode(code);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Unknown or expired authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const record = this.store.takeCode(code);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Unknown or expired authorization code');
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    if (resource && record.resource && resource.href !== record.resource) throw new InvalidGrantError('resource does not match the authorization request');
    return this.issueTokens(client.client_id, record.scopes, record.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const record = this.store.getToken(refreshToken);
    if (!record || record.kind !== 'refresh' || record.clientId !== client.client_id) throw new InvalidGrantError('Unknown or expired refresh token');
    if (resource && record.resource && resource.href !== record.resource) throw new InvalidGrantError('resource does not match the token');
    const granted = scopes?.length ? scopes.filter((s) => record.scopes.includes(s)) : record.scopes;
    // Rotation: the old pair dies the moment the new one is born.
    this.store.deletePair(record.pair);
    return this.issueTokens(client.client_id, granted, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getToken(token);
    if (!record || record.kind !== 'access') throw new InvalidTokenError('Unknown or expired token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expires,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record = this.store.getToken(request.token);
    if (record && record.clientId === client.client_id) this.store.deletePair(record.pair);
  }

  private issueTokens(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
    const pair = newSecret();
    const access = newSecret();
    const refresh = newSecret();
    const t = Math.floor(Date.now() / 1000);
    this.store.saveToken(access, { kind: 'access', pair, clientId, resource, scopes, expires: t + ACCESS_SECONDS });
    this.store.saveToken(refresh, { kind: 'refresh', pair, clientId, resource, scopes, expires: t + REFRESH_SECONDS });
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: ACCESS_SECONDS,
      refresh_token: refresh,
      scope: scopes.length ? scopes.join(' ') : undefined,
      issuer: undefined,
    };
  }
}
