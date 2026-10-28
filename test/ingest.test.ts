import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { Archive } from '../src/archive/archive.ts';
import { bareJid, fromHistorySync, fromMessageEvent } from '../src/ingest/normalize.ts';
import { handleEvent, verifySignature } from '../src/ingest/webhook.ts';
import { ALICE, BOB, GROUP, ME, historySync, liveImage, liveReplyFromLid, liveText, liveVoice } from './fixtures.ts';

const KEY = 'k'.repeat(40);
const noHooks = { onPaired: () => {}, onLoggedOut: () => {} };

test('signature: accepts the exact bytes WuzAPI signed, rejects anything else', () => {
  const body = Buffer.from('{"type":"Message","event":{}}');
  const sig = createHmac('sha256', KEY).update(body).digest('hex');
  assert.equal(verifySignature(body, sig, KEY), true);
  assert.equal(verifySignature(Buffer.from(body.toString() + ' '), sig, KEY), false);
  assert.equal(verifySignature(body, sig, 'x'.repeat(40)), false);
  assert.equal(verifySignature(body, undefined, KEY), false);
  assert.equal(verifySignature(body, 'zz', KEY), false);
});

test('bareJid drops the device part', () => {
  assert.equal(bareJid('15550000001:12@s.whatsapp.net'), ME);
  assert.equal(bareJid(GROUP), GROUP);
});

test('plain text message', () => {
  const m = fromMessageEvent(liveText({ id: 'MSG-1', text: 'Hi there' }))!;
  assert.equal(m.chatJid, ALICE);
  assert.equal(m.type, 'text');
  assert.equal(m.text, 'Hi there');
  assert.equal(m.timestamp, Date.parse('2026-01-02T10:00:00Z') / 1000);
  assert.equal(m.senderName, 'Alice');
});

test('a reply from a privacy LID is filed under the phone number, with its quote', () => {
  const m = fromMessageEvent(liveReplyFromLid)!;
  assert.equal(m.chatJid, ALICE);
  assert.equal(m.senderJid, ALICE);
  assert.equal(m.quotedId, 'MSG-1');
});

test('image keeps its caption and what is needed to download it', () => {
  const m = fromMessageEvent(liveImage)!;
  assert.equal(m.type, 'image');
  assert.equal(m.chatJid, GROUP);
  assert.equal(m.senderJid, BOB);
  assert.equal(m.text, 'The view from the hut');
  assert.equal(m.media?.mediaKey, 'a2V5');
  assert.equal(m.media?.fileLength, 1234);
});

test('status updates are not archived', () => {
  assert.equal(fromMessageEvent(liveText({ id: 'S1', chat: 'status@broadcast', text: 'my story' })), null);
});

test('voice notes are told apart from other audio', () => {
  assert.equal(fromMessageEvent(liveVoice)?.type, 'voice');
});

test('history sync: messages, chat names and push names; reactions skipped', () => {
  const batch = fromHistorySync(historySync);
  assert.deepEqual(batch.messages.map((m) => m.id), ['H-1', 'H-2']);
  assert.equal(batch.messages[1]!.fromMe, true);
  assert.equal(batch.messages[0]!.timestamp, 1735689600);
  assert.deepEqual(batch.chats, [{ jid: BOB, name: 'Bob Example' }]);
  assert.deepEqual(batch.pushNames, [{ jid: ALICE, name: 'Alice' }]);
});

test('webhook events land in the archive; own messages are attributed to the linked account', () => {
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  assert.equal(handleEvent(a, { type: 'Message', event: liveText({ id: 'L1', text: 'live one' }) }, noHooks), 'message stored');
  assert.equal(handleEvent(a, { type: 'Message', event: liveText({ id: 'L1', text: 'live one' }) }, noHooks), 'message already stored');
  handleEvent(a, { type: 'HistorySync', event: { Data: historySync } }, noHooks);
  assert.equal(a.stats().messages, 3);
  assert.equal(a.getMessage('H-2')?.senderJid, ME);
  assert.equal(a.getChat(BOB)?.name, 'Bob Example');
  assert.equal(a.displayName(ALICE), 'Alice');
});

test('pairing and logout reach the session hooks', () => {
  const a = new Archive(':memory:');
  const seen: string[] = [];
  const hooks = { onPaired: (jid: string) => seen.push(`paired ${jid}`), onLoggedOut: () => seen.push('out') };
  handleEvent(a, { type: 'PairSuccess', event: { ID: '15550000001:3@s.whatsapp.net' } }, hooks);
  handleEvent(a, { type: 'LoggedOut', event: { Reason: 0 } }, hooks);
  assert.deepEqual(seen, [`paired ${ME}`, 'out']);
});
