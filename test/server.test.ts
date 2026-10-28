import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Archive } from '../src/archive/archive.ts';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/http/server.ts';
import { Session } from '../src/session.ts';
import type { Wuzapi } from '../src/wuzapi/client.ts';
import { ALICE, ME, liveText } from './fixtures.ts';

const KEY = 'h'.repeat(40);
const config = loadConfig({
  WUZAPI_ADMIN_TOKEN: 'a'.repeat(20),
  WUZAPI_USER_TOKEN: 'u'.repeat(20),
  WUZAPI_GLOBAL_HMAC_KEY: KEY,
  DATA_DIR: '/tmp/unused',
});

// A WuzAPI stand-in: records what would have been sent.
const sent: unknown[] = [];
const fakeWuzapi = {
  async listUsers() {
    return [{ id: '1', token: config.WUZAPI_USER_TOKEN, events: 'Message,HistorySync,PairSuccess,LoggedOut' }];
  },
  async status() {
    return { connected: true, loggedIn: true, jid: '15550000001:4@s.whatsapp.net', name: 'owner', events: '' };
  },
  async connect() {},
  async qr() {
    return null;
  },
  async contacts() {
    return {};
  },
  async groups() {
    return [];
  },
  async conversations() {
    return { chats: [], has_more: false };
  },
  async sendText(to: string, body: string, reply?: unknown) {
    sent.push({ to, body, reply });
    return { Id: 'SENT-1', Timestamp: 0 };
  },
} as unknown as Wuzapi;

const archive = new Archive(':memory:');
const session = new Session(config, fakeWuzapi, archive);
const app = buildApp({ config, archive, wuzapi: fakeWuzapi, session });
let base = '';
let server: ReturnType<typeof app.listen>;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
});

const sign = (body: string) => createHmac('sha256', KEY).update(body).digest('hex');
const postWebhook = (body: string, signature: string) =>
  fetch(`${base}/webhook/wuzapi`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hmac-signature': signature }, body });

test('webhook with a wrong signature is refused', async () => {
  const body = JSON.stringify({ type: 'Message', event: liveText({ id: 'X', text: 'nope' }) });
  const res = await postWebhook(body, sign(body + 'tampered'));
  assert.equal(res.status, 401);
  assert.equal(archive.getMessage('X'), null);
});

test('signed webhook is archived', async () => {
  for (const [id, text] of [['W1', 'Dinner on Friday at the trattoria?'], ['W2', 'Yes, eight o’clock']] as const) {
    const body = JSON.stringify({ type: 'Message', event: liveText({ id, text, fromMe: id === 'W2' }), userID: 'u', instanceName: 'owner' });
    const res = await postWebhook(body, sign(body));
    assert.equal(res.status, 200);
  }
  assert.equal(archive.stats().messages, 2);
});

test('a foreign Host header is refused', async () => {
  // fetch() always sends the real Host, so this goes through node:http to send a forged one.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/healthz`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('status endpoint reports the link and the archive', async () => {
  const res = await fetch(`${base}/api/status`);
  const s = (await res.json()) as { whatsapp: { loggedIn: boolean; phone: string }; archive: { messages: number } };
  assert.equal(s.whatsapp.loggedIn, true);
  assert.equal(s.whatsapp.phone, '15550000001');
  assert.equal(s.archive.messages, 2);
  assert.equal(archive.accountJid(), ME);
});

test('MCP tools over HTTP: list, search, reply', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['list_chats', 'search_messages', 'send_message', 'download_media', 'transcribe_voice']) assert.ok(tools.includes(name), name);

  const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
  assert.match(textOf(await client.callTool({ name: 'list_chats', arguments: {} })), /15550000002@s\.whatsapp\.net/);
  assert.match(textOf(await client.callTool({ name: 'search_messages', arguments: { query: 'trattoria' } })), /Dinner on Friday/);

  const reply = await client.callTool({ name: 'send_message', arguments: { to: '+1 555 000 0002', text: 'See you there', reply_to: 'W2' } });
  assert.match(textOf(reply), /SENT-1/);
  assert.deepEqual(sent.at(-1), { to: ALICE, body: 'See you there', reply: { messageId: 'W2', participant: ME, quotedText: 'Yes, eight o’clock' } });

  const off = await client.callTool({ name: 'transcribe_voice', arguments: { message_id: 'W1' } });
  assert.equal(off.isError, true);
  await client.close();
});
