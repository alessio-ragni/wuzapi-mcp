import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Archive, ftsQuery, type ArchivedMessage } from '../src/archive/archive.ts';
import { ALICE, BOB, GROUP, ME } from './fixtures.ts';

const msg = (over: Partial<ArchivedMessage>): ArchivedMessage => ({
  chatJid: ALICE,
  id: 'M',
  senderJid: ALICE,
  senderName: 'Alice',
  fromMe: false,
  timestamp: 1_000,
  type: 'text',
  text: 'hello',
  quotedId: null,
  media: null,
  ...over,
});

test('stores a message once, however many times it arrives', () => {
  const a = new Archive(':memory:');
  assert.equal(a.addMessage(msg({ id: '1' })), true);
  assert.equal(a.addMessage(msg({ id: '1', text: 'changed' })), false);
  assert.equal(a.stats().messages, 1);
  assert.equal(a.getMessage('1')?.text, 'hello');
});

test('full-text search ignores accents and matches word prefixes', () => {
  const a = new Archive(':memory:');
  a.addMessage(msg({ id: '1', text: 'Ci vediamo al caffè domani' }));
  a.addMessage(msg({ id: '2', text: 'Nothing to see here' }));
  assert.deepEqual(a.listMessages({ query: 'caffe', limit: 10, offset: 0 }).map((m) => m.id), ['1']);
  assert.deepEqual(a.listMessages({ query: 'domani vedia', limit: 10, offset: 0 }).map((m) => m.id), ['1']);
  assert.deepEqual(a.listMessages({ query: '"); DROP', limit: 10, offset: 0 }), []);
  assert.equal(ftsQuery('  '), '');
});

test('chats are listed most recent first, with names from contacts', () => {
  const a = new Archive(':memory:');
  a.upsertContact(ALICE, { name: 'Alice Example' });
  a.addMessage(msg({ id: '1', chatJid: ALICE, timestamp: 100 }));
  a.addMessage(msg({ id: '2', chatJid: GROUP, senderJid: BOB, timestamp: 200 }));
  a.upsertChat(GROUP, { name: 'Hiking club', isGroup: true });
  const chats = a.listChats({ limit: 10, offset: 0 });
  assert.deepEqual(chats.map((c) => c.jid), [GROUP, ALICE]);
  assert.equal(chats[0]!.isGroup, true);
  assert.equal(chats[1]!.name, 'Alice Example');
  assert.deepEqual(a.listChats({ query: 'hiking', limit: 10, offset: 0 }).map((c) => c.jid), [GROUP]);
});

test('message context returns neighbours in time order', () => {
  const a = new Archive(':memory:');
  for (let i = 1; i <= 7; i++) a.addMessage(msg({ id: `m${i}`, timestamp: i * 10, text: `n${i}` }));
  const ctx = a.messageContext('m4', ALICE, 2, 2)!;
  assert.deepEqual(ctx.map((m) => m.id), ['m2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(a.messageContext('missing', undefined, 2, 2), null);
});

test('linking a different account wipes the archive; the same account keeps it', () => {
  const a = new Archive(':memory:');
  assert.equal(a.claimAccount(ME), false);
  a.addMessage(msg({ id: '1' }));
  assert.equal(a.claimAccount(ME), false);
  assert.equal(a.stats().messages, 1);
  assert.equal(a.claimAccount(BOB), true);
  assert.equal(a.stats().messages, 0);
  assert.equal(a.accountJid(), BOB);
  assert.deepEqual(a.listMessages({ query: 'hello', limit: 5, offset: 0 }), []);
});
