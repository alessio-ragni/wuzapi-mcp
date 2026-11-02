import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Archive } from '../src/archive/archive.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { AuthStore } from '../src/http/auth/store.ts';
import { buildApp } from '../src/http/server.ts';
import { Session } from '../src/session.ts';
import type { Wuzapi } from '../src/wuzapi/client.ts';

// Invented data only. The server runs on 127.0.0.1, which the SDK exempts from the https rule.

const PASSPHRASE = 'correct-horse-battery-staple';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const BASE_ENV = { WUZAPI_ADMIN_TOKEN: 'a'.repeat(20), WUZAPI_USER_TOKEN: 'u'.repeat(20), WUZAPI_GLOBAL_HMAC_KEY: 'h'.repeat(40), DATA_DIR: '/tmp/unused' };

const fakeWuzapi = {
  async listUsers() {
    return [{ id: '1', token: BASE_ENV.WUZAPI_USER_TOKEN, events: 'Message,HistorySync,PairSuccess,LoggedOut' }];
  },
  async status() {
    return { connected: true, loggedIn: true, jid: '15550000001:4@s.whatsapp.net', name: 'owner', events: '' };
  },
  async connect() {},
  async setHistory() {},
  async qr() {
    return null;
  },
  async contacts() {
    return {};
  },
  async groups() {
    return [];
  },
  async lidFor() {
    return null;
  },
  async conversations() {
    return { chats: [], has_more: false };
  },
} as unknown as Wuzapi;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const form = (fields: Record<string, string | undefined>) =>
  new URLSearchParams(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>);
const postForm = (url: string, fields: Record<string, string | undefined>, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: form(fields), redirect: 'manual' });
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

let base = '';
let config: Config;
let server: ReturnType<ReturnType<typeof buildApp>['listen']>;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  config = loadConfig({ ...BASE_ENV, PUBLIC_URL: base, OWNER_PASSPHRASE: PASSPHRASE });
  const archive = new Archive(':memory:');
  const app = buildApp({ config, archive, wuzapi: fakeWuzapi, session: new Session(config, fakeWuzapi, archive), auth: new AuthStore(':memory:') });
  await new Promise<void>((resolve) => {
    server = app.listen(port, '127.0.0.1', () => resolve());
  });
});
after(() => {
  server.close();
});

// --- configuration rules -----------------------------------------------------

test('a public address needs a passphrase and https', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_URL: 'https://wa.example.com' }), /OWNER_PASSPHRASE/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_URL: 'http://wa.example.com', OWNER_PASSPHRASE: PASSPHRASE }), /https/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_URL: 'https://wa.example.com', OWNER_PASSPHRASE: 'short' }), /12 characters/);
  assert.throws(() => loadConfig({ ...BASE_ENV, PUBLIC_URL: 'https://wa.example.com', OWNER_PASSPHRASE: PASSPHRASE, PUBLIC_HOST: 'other.example.com' }), /PUBLIC_HOST/);
  const ok = loadConfig({ ...BASE_ENV, PUBLIC_URL: 'https://wa.example.com/', OWNER_PASSPHRASE: PASSPHRASE, PUBLIC_HOST: 'wa.example.com' });
  assert.equal(ok.hosted, true);
  assert.equal(ok.PUBLIC_URL, 'https://wa.example.com');
  assert.ok(ok.ALLOWED_HOSTS.includes('wa.example.com'));
  assert.equal(loadConfig(BASE_ENV).hosted, false);
});

// --- discovery -----------------------------------------------------------------

test('without a token /mcp answers 401 and points at the resource metadata', async () => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
});

test('the two discovery documents are served and agree', async () => {
  const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
  assert.equal(prm.resource, `${base}/mcp`);
  assert.equal(prm.authorization_servers[0], `${base}/`);
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.issuer, `${base}/`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.equal(as.token_endpoint, `${base}/token`);
  assert.ok((as.grant_types_supported as string[]).includes('refresh_token'));
});

// --- the whole flow ----------------------------------------------------------------

let clientId = '';
let accessToken = '';
let refreshToken = '';

test('an assistant registers itself; a redirect to a plain http site is refused', async () => {
  const bad = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'], client_name: 'Nope' }) });
  assert.equal(bad.status, 400);
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: 'Claude', token_endpoint_auth_method: 'none' }),
  });
  assert.equal(res.status, 201);
  const info = (await res.json()) as { client_id: string; client_secret?: string };
  assert.ok(info.client_id);
  assert.equal(info.client_secret, undefined);
  clientId = info.client_id;
});

test('the owner approves with the passphrase and the code becomes tokens', async () => {
  const { verifier, challenge } = pkce();
  const authorize = `${base}/authorize?${form({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${base}/mcp` })}`;
  const page = await fetch(authorize);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Claude/);
  assert.match(html, /claude\.ai/);
  assert.match(html, /name="passphrase"/);

  const request = { client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, state: 'xyz', resource: `${base}/mcp` };
  const wrong = await postForm(`${base}/oauth/approve`, { ...request, passphrase: 'not it' });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong passphrase/);
  const foreign = await postForm(`${base}/oauth/approve`, { ...request, passphrase: PASSPHRASE }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const tampered = await postForm(`${base}/oauth/approve`, { ...request, redirect_uri: 'https://evil.example/cb', passphrase: PASSPHRASE });
  assert.equal(tampered.status, 400);

  const ok = await postForm(`${base}/oauth/approve`, { ...request, passphrase: PASSPHRASE });
  assert.equal(ok.status, 302);
  const location = new URL(ok.headers.get('location')!);
  assert.equal(location.origin + location.pathname, CALLBACK);
  assert.equal(location.searchParams.get('state'), 'xyz');
  const code = location.searchParams.get('code')!;
  assert.ok(code);
  assert.match(cookieOf(ok), /^wuzapi_owner=/);

  const badVerifier = await postForm(`${base}/token`, { grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-xx', client_id: clientId, redirect_uri: CALLBACK });
  assert.equal(badVerifier.status, 400);
  assert.equal(((await badVerifier.json()) as { error: string }).error, 'invalid_grant');

  const tokens = await postForm(`${base}/token`, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK, resource: `${base}/mcp` });
  assert.equal(tokens.status, 200);
  const t = (await tokens.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
  assert.equal(t.token_type, 'bearer');
  assert.equal(t.expires_in, 3600);
  assert.ok(t.access_token && t.refresh_token);
  accessToken = t.access_token;
  refreshToken = t.refresh_token;

  const reuse = await postForm(`${base}/token`, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK });
  assert.equal(reuse.status, 400);
});

test('a signed-in owner approves a second assistant with one click, and a token without a resource still works', async () => {
  const { verifier, challenge } = pkce();
  const signIn = await postForm(`${base}/login`, { passphrase: PASSPHRASE });
  assert.equal(signIn.status, 303);
  const cookie = cookieOf(signIn);
  const page = await fetch(`${base}/authorize?${form({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' })}`, { headers: { Cookie: cookie } });
  const html = await page.text();
  assert.doesNotMatch(html, /name="passphrase"/);
  const ok = await postForm(`${base}/oauth/approve`, { client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge }, { Cookie: cookie });
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.get('location')!).searchParams.get('code')!;
  assert.ok(code);
  const tokens = await postForm(`${base}/token`, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK });
  assert.equal(tokens.status, 200);
  const t = (await tokens.json()) as { access_token: string };
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${t.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(res.status, 200);
});

test('the token opens the MCP endpoint', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'list_chats'));
  await client.close();
  const forged = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-token' }, body: '{}' });
  assert.equal(forged.status, 401);
});

test('refreshing rotates the pair; revoking kills it', async () => {
  const res = await postForm(`${base}/token`, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  assert.equal(res.status, 200);
  const fresh = (await res.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(fresh.access_token, accessToken);
  assert.notEqual(fresh.refresh_token, refreshToken);

  const old = await postForm(`${base}/token`, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  assert.equal(old.status, 400);
  assert.equal(((await old.json()) as { error: string }).error, 'invalid_grant');
  const oldAccess = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: '{}' });
  assert.equal(oldAccess.status, 401);

  const revoke = await postForm(`${base}/revoke`, { token: fresh.access_token, client_id: clientId });
  assert.equal(revoke.status, 200);
  const dead = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fresh.access_token}` }, body: '{}' });
  assert.equal(dead.status, 401);
  const deadRefresh = await postForm(`${base}/token`, { grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: clientId });
  assert.equal(deadRefresh.status, 400);
});

// --- the page --------------------------------------------------------------------

test('the page and the API are behind the login', async () => {
  const anon = await fetch(base);
  assert.equal(anon.status, 200);
  assert.match(await anon.text(), /name="passphrase"/);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  const wrong = await postForm(`${base}/login`, { passphrase: 'nope nope nope' });
  assert.equal(wrong.status, 401);
  const crossSite = await postForm(`${base}/login`, { passphrase: PASSPHRASE }, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);

  const signIn = await postForm(`${base}/login`, { passphrase: PASSPHRASE });
  assert.equal(signIn.status, 303);
  const cookie = cookieOf(signIn);
  assert.match(signIn.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.match(signIn.headers.get('set-cookie') ?? '', /SameSite=Lax/);

  const page = await fetch(base, { headers: { Cookie: cookie } });
  assert.match(await page.text(), /Add custom connector/);
  const status = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  const unlinkFromElsewhere = await fetch(`${base}/api/unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(unlinkFromElsewhere.status, 403);

  const out = await postForm(`${base}/logout`, {}, { Cookie: cookie });
  assert.equal(out.status, 303);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).status, 401);
});

test('the healthcheck stays open', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

// --- local mode is untouched -----------------------------------------------------------

test('without a passphrase nothing asks for a login', async () => {
  const local = loadConfig(BASE_ENV);
  const archive = new Archive(':memory:');
  const app = buildApp({ config: local, archive, wuzapi: fakeWuzapi, session: new Session(local, fakeWuzapi, archive) });
  const s = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    assert.ok((await client.listTools()).tools.length > 0);
    await client.close();
    assert.equal((await fetch(`${url}/.well-known/oauth-authorization-server`)).status, 404);
    assert.match(await (await fetch(url)).text(), /claude mcp add/);
    assert.equal((await fetch(`${url}/api/status`)).status, 200);
  } finally {
    s.close();
  }
});

// Last: after this the address is blocked for a quarter of an hour.
test('five wrong passphrases block the address', async () => {
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await postForm(`${base}/login`, { passphrase: `guess ${i} guess` })).status;
  assert.equal(last, 429);
  assert.equal((await postForm(`${base}/login`, { passphrase: PASSPHRASE })).status, 429);
});
