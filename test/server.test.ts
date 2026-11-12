import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Archive } from '../src/archive/archive.ts';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/http/server.ts';
import { Session } from '../src/session.ts';
import type { Wuzapi } from '../src/wuzapi/client.ts';
import { ALICE, GROUP, ME, liveImage, liveText } from './fixtures.ts';

const KEY = 'h'.repeat(40);
const config = loadConfig({
  WUZAPI_ADMIN_TOKEN: 'a'.repeat(20),
  WUZAPI_USER_TOKEN: 'u'.repeat(20),
  WUZAPI_GLOBAL_HMAC_KEY: KEY,
  DATA_DIR: mkdtempSync(join(tmpdir(), 'wuzapi-mcp-server-')),
  MEDIA_PREFETCH: 'off',
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
  async createGroup(name: string, participants: string[], membersCanAdd: boolean) {
    sent.push({ createGroup: name, participants, membersCanAdd });
    return {
      JID: '120363000000000099@g.us',
      Name: name,
      Participants: [
        { JID: '900000000000001@lid', PhoneNumber: ME, IsAdmin: true, IsSuperAdmin: true },
        { JID: '900000000000002@lid', PhoneNumber: ALICE, IsAdmin: false, IsSuperAdmin: false },
        { JID: '15550000003@s.whatsapp.net', IsAdmin: false, IsSuperAdmin: false, Error: 403 },
      ],
    };
  },
  async updateParticipants(group: string, people: string[], action: string) {
    sent.push({ group, people, action });
  },
  async sendText(to: string, body: string, reply?: unknown, mentions?: string[], mentionAll?: boolean) {
    sent.push(mentions?.length || mentionAll ? { to, body, reply, mentions, mentionAll } : { to, body, reply });
    return { Id: 'SENT-1', Timestamp: 0 };
  },
  async sendContact(to: string, name: string, vcard: string) {
    sent.push({ contact: to, name, vcard });
    return { Id: 'SENT-2', Timestamp: 0 };
  },
  async deleteMessage(chat: string, id: string, sender?: string) {
    sent.push({ delete: id, chat, sender });
    return { Id: id };
  },
  async editMessage(chat: string, id: string, body: string) {
    sent.push({ edit: id, chat, body });
    return { Id: id, Timestamp: 0 };
  },
  async archiveChat(chat: string, archive: boolean) {
    sent.push({ archiveChat: chat, archive });
  },
  async setGroupName(group: string, name: string) {
    sent.push({ setGroupName: group, name });
  },
  async setGroupAnnounce() {
    throw new Error('not an admin');
  },
  async download(kind: string) {
    sent.push({ download: kind });
    return { mimetype: 'image/jpeg', data: Buffer.from('fake jpeg bytes') };
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
  rmSync(config.DATA_DIR, { recursive: true, force: true });
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

test('create_group adds who it can, promotes admins and reports who needs an invite', async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const r = await client.callTool({
    name: 'create_group',
    arguments: { name: 'Picnic', participants: ['+1 555 000 0002', '15550000003'], admins: ['15550000002'] },
  });
  const out = (r as { content: { text: string }[] }).content[0]!.text;
  assert.deepEqual(sent.at(-2), { createGroup: 'Picnic', participants: ['15550000002', '15550000003'], membersCanAdd: true });
  assert.deepEqual(sent.at(-1), { group: '120363000000000099@g.us', people: ['15550000002'], action: 'promote' });
  assert.match(out, /Added \(1\)/);
  assert.match(out, /need an invite instead \(1\): .*15550000003/);
  assert.equal(archive.getChat('120363000000000099@g.us')?.name, 'Picnic');
  await client.close();
});

const connect = async () => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
};
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

test('every tool is listed', async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of [
    'delete_message', 'edit_message', 'pin_message', 'star_message', 'vote_poll', 'manage_chat',
    'update_group', 'leave_group', 'get_group_invite_info', 'join_group', 'group_join_requests',
    'check_whatsapp', 'get_contact_info', 'block_contact', 'list_channels', 'manage_channel',
    'send_location', 'send_contact', 'send_sticker',
  ]) {
    assert.ok(tools.includes(name), name);
  }
  await client.close();
});

test('delete and edit go to WhatsApp and to the archive', async () => {
  const client = await connect();
  const del = await client.callTool({ name: 'delete_message', arguments: { message_id: 'W2' } });
  assert.match(textOf(del), /Deleted for everyone/);
  assert.deepEqual(sent.at(-1), { delete: 'W2', chat: ALICE, sender: undefined });
  assert.ok(archive.getMessage('W2')!.deletedAt);

  const notMine = await client.callTool({ name: 'edit_message', arguments: { message_id: 'W1', text: 'changed' } });
  assert.equal(notMine.isError, true);
  const refused = await client.callTool({ name: 'delete_message', arguments: { message_id: 'W1' } });
  assert.equal(refused.isError, true, 'someone else’s message in a direct chat');
  await client.close();
});

test('mentions are added to the text and passed along; contact cards carry the number', async () => {
  const client = await connect();
  await client.callTool({ name: 'send_message', arguments: { to: GROUP, text: 'Who brings the cake?', mentions: ['15550000002'] } });
  assert.deepEqual(sent.at(-1), { to: GROUP, body: 'Who brings the cake? @15550000002', reply: undefined, mentions: [ALICE], mentionAll: false });
  const notGroup = await client.callTool({ name: 'send_message', arguments: { to: ALICE, text: 'hi', mention_all: true } });
  assert.equal(notGroup.isError, true);

  await client.callTool({ name: 'send_contact', arguments: { to: ALICE, name: 'Carol Example', phone: '+1 555 000 0004' } });
  const card = sent.at(-1) as { vcard: string };
  assert.match(card.vcard, /FN:Carol Example/);
  assert.match(card.vcard, /waid=15550000004:\+15550000004/);
  await client.close();
});

test('manage_chat archives; update_group reports each change, including the failed ones', async () => {
  const client = await connect();
  assert.match(textOf(await client.callTool({ name: 'manage_chat', arguments: { chat_jid: GROUP, action: 'archive' } })), /archived/);
  assert.deepEqual(sent.at(-1), { archiveChat: GROUP, archive: true });

  const r = await client.callTool({ name: 'update_group', arguments: { group_jid: GROUP, name: 'Cake committee', only_admins_send: true } });
  assert.notEqual(r.isError, true);
  assert.match(textOf(r), /✓ name → "Cake committee"/);
  assert.match(textOf(r), /✗ only admins can send messages: not an admin/);
  assert.equal(archive.getChat(GROUP)?.name, 'Cake committee');
  await client.close();
});

test('download_media returns the photo itself and a link that downloads it', async () => {
  const body = JSON.stringify({ type: 'Message', event: liveImage });
  assert.equal((await postWebhook(body, sign(body))).status, 200);
  const client = await connect();
  const r = (await client.callTool({ name: 'download_media', arguments: { message_id: 'MSG-IMG' } })) as {
    content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  };
  const image = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'fake jpeg bytes');
  assert.equal(image.mimeType, 'image/jpeg');
  const link = textOf(r).match(/(http:\/\/\S+\/media\/\S+)/)![1]!;
  await client.close();

  const res = await fetch(link.replace(config.PUBLIC_URL, base));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'fake jpeg bytes');
  assert.equal(sent.filter((s) => (s as { download?: string }).download).length, 1, 'downloaded from WhatsApp once');

  const bad = await fetch(`${base}/media/${link.split('/media/')[1]!.slice(0, -2)}xx`);
  assert.equal(bad.status, 404);
});
