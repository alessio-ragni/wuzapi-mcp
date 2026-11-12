import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { Archive } from '../src/archive/archive.ts';
import { fromHistorySync, revisionFromEvent } from '../src/ingest/normalize.ts';
import { handleEvent } from '../src/ingest/webhook.ts';
import { messageLine } from '../src/tools/format.ts';
import { ALICE, BOB, ME, historyWithRevisions, liveEdit, liveImage, liveRevoke, liveText } from './fixtures.ts';

const noHooks = { onPaired: () => {}, onLoggedOut: () => {} };

test('edits and deletes are recognised in live events', () => {
  assert.deepEqual(revisionFromEvent(liveRevoke({ target: 'M1' })), { kind: 'delete', chatJid: ALICE, targetId: 'M1', timestamp: 1767358800 });
  const edit = revisionFromEvent(liveEdit({ target: 'M1', text: 'fixed typo' }));
  assert.equal(edit?.kind, 'edit');
  assert.equal(edit?.text, 'fixed typo');
  assert.equal(revisionFromEvent(liveText({ id: 'M2', text: 'plain' })), null);
});

test('an edit replaces the text and is marked; search follows it', () => {
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  handleEvent(a, { type: 'Message', event: liveText({ id: 'E1', text: 'See you at the bakery' }) }, noHooks);
  assert.equal(handleEvent(a, { type: 'Message', event: liveEdit({ target: 'E1', text: 'See you at the station' }) }, noHooks), 'message: edit applied');
  const m = a.getMessage('E1', ALICE)!;
  assert.equal(m.text, 'See you at the station');
  assert.ok(m.editedAt);
  assert.match(messageLine(a, m), /station \(edited\)/);
  assert.equal(a.listMessages({ query: 'bakery', limit: 5, offset: 0 }).length, 0);
  assert.equal(a.listMessages({ query: 'station', limit: 5, offset: 0 }).length, 1);
});

test('a delete for everyone removes the content, keeps a mark and tells the media store', () => {
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  const forgotten: string[] = [];
  const hooks = { ...noHooks, onDeleted: (chat: string, id: string) => forgotten.push(`${chat} ${id}`) };
  handleEvent(a, { type: 'Message', event: liveText({ id: 'D1', text: 'my secret plan' }) }, hooks);
  handleEvent(a, { type: 'Message', event: liveImage }, hooks);
  assert.equal(handleEvent(a, { type: 'Message', event: liveRevoke({ target: 'D1' }) }, hooks), 'message: delete applied');
  handleEvent(a, { type: 'Message', event: liveRevoke({ target: 'MSG-IMG', chat: liveImage.Info.Chat, sender: BOB }) }, hooks);
  const m = a.getMessage('D1', ALICE)!;
  assert.equal(m.text, null);
  assert.ok(m.deletedAt);
  assert.equal(a.getMessage('MSG-IMG')!.media, null);
  assert.match(messageLine(a, m), /\[deleted\] This message was deleted\./);
  assert.equal(a.listMessages({ query: 'secret', limit: 5, offset: 0 }).length, 0);
  assert.deepEqual(forgotten, [`${ALICE} D1`, `${liveImage.Info.Chat} MSG-IMG`]);
  // An edit cannot bring a deleted message back.
  handleEvent(a, { type: 'Message', event: liveEdit({ target: 'D1', text: 'resurrected' }) }, hooks);
  assert.equal(a.getMessage('D1', ALICE)!.text, null);
});

test('history: a deleted stub becomes a mark, an edit applies after its message is stored', () => {
  const batch = fromHistorySync(historyWithRevisions);
  assert.equal(batch.deleted.length, 1);
  assert.equal(batch.revisions.length, 1);
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  handleEvent(a, { type: 'HistorySync', event: { Data: historyWithRevisions } }, noHooks);
  assert.equal(a.getMessage('HR-1', BOB)!.text, 'Meet at nine instead');
  const gone = a.getMessage('HR-GONE', BOB)!;
  assert.ok(gone.deletedAt);
  assert.equal(gone.text, null);
  assert.equal(a.getMessage('HR-EDIT'), null);
});

test('an archive made before edits and deletes were tracked is upgraded in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wuzapi-mcp-migrate-'));
  try {
    const path = join(dir, 'archive.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE messages (rowid INTEGER PRIMARY KEY, chat_jid TEXT NOT NULL, id TEXT NOT NULL, sender_jid TEXT NOT NULL,
      sender_name TEXT, from_me INTEGER NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL, text TEXT, quoted_id TEXT, media TEXT,
      UNIQUE (chat_jid, id));
      INSERT INTO messages (chat_jid, id, sender_jid, from_me, timestamp, type, text) VALUES ('${ALICE}', 'OLD-1', '${ALICE}', 0, 1, 'text', 'kept');`);
    old.close();
    const a = new Archive(path);
    assert.equal(a.getMessage('OLD-1')!.text, 'kept');
    assert.equal(a.getMessage('OLD-1')!.deletedAt, null);
    const columns = (a.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes('edited_at') && columns.includes('deleted_at'));
    a.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
