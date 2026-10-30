import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Archive } from '../src/archive/archive.ts';
import { handleEvent } from '../src/ingest/webhook.ts';
import { ALICE, ALICE_LID, BOB, GROUP, ME } from './fixtures.ts';

// Invented data only.
const noHooks = { onPaired: () => {}, onLoggedOut: () => {} };
const hash = (option: string) => createHash('sha256').update(option).digest('base64');

const pollMessage = {
  Info: { Chat: GROUP, Sender: ME, IsFromMe: true, IsGroup: true, ID: 'POLL-1', Timestamp: '2026-01-05T09:00:00Z' },
  Message: { pollCreationMessageV3: { name: 'Picnic on Sunday?', options: [{ optionName: 'Yes 🎉' }, { optionName: 'No' }] } },
};

const vote = (sender: string, options: string[], at: string, senderAlt?: string) => ({
  type: 'Message',
  event: {
    Info: { Chat: GROUP, Sender: sender, SenderAlt: senderAlt, IsFromMe: false, IsGroup: true, ID: `V-${sender}-${at}`, Timestamp: at },
    Message: { pollUpdateMessage: { pollCreationMessageKey: { ID: 'POLL-1' } } },
  },
  pollVote: { pollCreationMsgID: 'POLL-1', selectedOptions: [], selectedHashesB64: options.map(hash) },
});

function archiveWithPoll(): Archive {
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  handleEvent(a, { type: 'Message', event: pollMessage }, noHooks);
  return a;
}

test('live votes are counted per option; a changed vote replaces the old one', () => {
  const a = archiveWithPoll();
  assert.equal(handleEvent(a, vote(ALICE, ['No'], '2026-01-05T09:10:00Z'), noHooks), 'message: poll vote stored');
  handleEvent(a, vote(BOB, ['Yes 🎉'], '2026-01-05T09:11:00Z'), noHooks);
  handleEvent(a, vote(ALICE, ['Yes 🎉'], '2026-01-05T09:12:00Z'), noHooks);
  const r = a.pollResults('POLL-1')!;
  assert.equal(r.poll.question, 'Picnic on Sunday?');
  assert.deepEqual(r.options, [
    { option: 'Yes 🎉', voters: [BOB, ALICE] },
    { option: 'No', voters: [] },
  ]);
  assert.equal(a.stats().messages, 1, 'votes are not messages');
});

test('an older vote arriving late does not undo a newer one; a withdrawn vote drops out', () => {
  const a = archiveWithPoll();
  handleEvent(a, vote(ALICE, ['Yes 🎉'], '2026-01-05T09:12:00Z'), noHooks);
  assert.equal(handleEvent(a, vote(ALICE, ['No'], '2026-01-05T09:10:00Z'), noHooks), 'message: older poll vote');
  assert.deepEqual(a.pollResults('POLL-1')!.options[0]!.voters, [ALICE]);
  handleEvent(a, vote(ALICE, [], '2026-01-05T09:20:00Z'), noHooks);
  assert.deepEqual(a.pollResults('POLL-1')!.options.flatMap((o) => o.voters), []);
});

test('a voter known only by privacy LID is filed under the number', () => {
  const a = archiveWithPoll();
  handleEvent(a, vote(ALICE_LID, ['No'], '2026-01-05T09:10:00Z', ALICE), noHooks);
  const b = archiveWithPoll();
  handleEvent(b, vote(ALICE_LID, ['No'], '2026-01-05T09:10:00Z'), noHooks);
  b.recordLid(ALICE, ALICE_LID);
  assert.deepEqual(a.pollResults('POLL-1')!.options[1]!.voters, [ALICE]);
  assert.deepEqual(b.pollResults('POLL-1')!.options[1]!.voters, [ALICE]);
});

test('votes attached to a poll in a history sync are read', () => {
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  const historySync = {
    conversations: [
      {
        ID: GROUP,
        messages: [
          {
            message: {
              key: { remoteJID: GROUP, fromMe: true, ID: 'POLL-H' },
              message: { pollCreationMessage: { name: 'Pizza or sushi?', options: [{ optionName: 'Pizza' }, { optionName: 'Sushi' }] } },
              messageTimestamp: 1767600000,
              pollUpdates: [
                { pollUpdateMessageKey: { remoteJID: GROUP, fromMe: false, ID: 'U1', participant: BOB }, vote: { selectedOptions: [hash('Sushi')] }, senderTimestampMS: 1767600100000 },
                { pollUpdateMessageKey: { remoteJID: GROUP, fromMe: true, ID: 'U2' }, vote: { selectedOptions: [hash('Pizza')] }, senderTimestampMS: 1767600200000 },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.match(handleEvent(a, { type: 'HistorySync', event: { Data: historySync } }, noHooks), /2 poll votes/);
  const r = a.pollResults('POLL-H')!;
  assert.deepEqual(r.options, [
    { option: 'Pizza', voters: [ME] },
    { option: 'Sushi', voters: [BOB] },
  ]);
  assert.equal(r.since, 1767600100);
  assert.equal(a.latestPoll(GROUP)?.id, 'POLL-H');
});

test('polls archived before the polls table are read back from their text; wipe clears votes', () => {
  const a = new Archive(':memory:');
  a.claimAccount(ME);
  a.addMessage({ chatJid: GROUP, id: 'OLD', senderJid: ME, senderName: null, fromMe: true, timestamp: 1, type: 'poll', text: 'Coming? — Yes / No', quotedId: null, media: null });
  a.recordVote({ pollId: 'OLD', voterJid: BOB, hashes: [hash('Yes')], timestamp: 2 });
  assert.deepEqual(a.pollResults('OLD')!.options[0], { option: 'Yes', voters: [BOB] });
  a.wipe();
  assert.equal(a.pollResults('OLD'), null);
  assert.equal(a.voteCount('OLD'), 0);
});
