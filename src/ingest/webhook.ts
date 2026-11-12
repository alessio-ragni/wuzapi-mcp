import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Archive, ArchivedMessage } from '../archive/archive.ts';
import { bareJid, fromHistorySync, fromMessageEvent, readPoll, revisionFromEvent, voteFromEvent, type Revision } from './normalize.ts';

/** WuzAPI signs every webhook body with HMAC-SHA256 and sends it, lowercase hex, in `x-hmac-signature`. */
export function verifySignature(rawBody: Buffer, header: string | undefined, key: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', key).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.trim(), 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface IngestHooks {
  /** A batch of the phone's history arrived; `added` new messages were stored. */
  onHistory?(added: number): void;
  /** A phone just linked through the QR: a new link always starts from an empty archive. */
  onPaired(jid: string): void;
  /** The device was removed from the phone, or WhatsApp logged it out. */
  onLoggedOut(): void;
  /** A message was stored (media gets copied while WhatsApp still serves it). */
  onStored?(m: ArchivedMessage, source: 'live' | 'history'): void;
  /** A message was deleted for everyone: whatever was kept of it goes. */
  onDeleted?(chatJid: string, id: string): void;
}

/** Applies an edit or a delete to the archive. */
function applyRevision(archive: Archive, r: Revision, hooks: IngestHooks): boolean {
  const chatJid = archive.resolveJid(r.chatJid);
  if (r.kind === 'edit') return archive.markEdited(chatJid, r.targetId, r.text ?? '', r.timestamp);
  const done = archive.markDeleted(chatJid, r.targetId, r.timestamp);
  hooks.onDeleted?.(chatJid, r.targetId);
  return done;
}

/** Message parts that carry no content of their own: key exchange, reactions, edits/deletes. */
const ROUTINE = new Set([
  'messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage', 'reactionMessage',
  'keepInChatMessage', 'encReactionMessage',
]);

/** Fills in "me" with the linked account, so replies to your own messages can name you. */
export function ownSender(m: ArchivedMessage, account: string | null): ArchivedMessage {
  return m.senderJid === 'me' && account ? { ...m, senderJid: account } : m;
}

/** Applies one verified webhook to the archive. Returns what it did, for the log. */
export function handleEvent(archive: Archive, payload: Record<string, unknown>, hooks: IngestHooks): string {
  const type = typeof payload.type === 'string' ? payload.type : '';
  const event = (payload.event ?? {}) as Record<string, unknown>;
  const account = archive.accountJid();

  switch (type) {
    case 'Message': {
      const vote = voteFromEvent(payload);
      if (vote) return archive.recordVote(vote) ? 'message: poll vote stored' : 'message: older poll vote';
      const revision = revisionFromEvent(event);
      if (revision) {
        const applied = applyRevision(archive, revision, hooks);
        return `message: ${revision.kind === 'edit' ? 'edit' : 'delete'} ${applied ? 'applied' : 'of a message not in the archive'}`;
      }
      const m = fromMessageEvent(event);
      if (!m) {
        // Field names only, never content: enough to see what kind of message was skipped.
        const keys = Object.keys((event.Message ?? {}) as Record<string, unknown>);
        const routine = keys.every((k) => ROUTINE.has(k));
        return routine ? 'message: protocol only' : `skipped message (${keys.join(',') || 'no content'})`;
      }
      const info = (event.Info ?? {}) as Record<string, unknown>;
      const stored = archive.canonical(ownSender(m, account));
      if (info.IsGroup === true) archive.upsertChat(stored.chatJid, { isGroup: true });
      const poll = m.type === 'poll' ? readPoll(event.Message as Record<string, unknown>) : null;
      if (poll) archive.recordPoll({ id: stored.id, chatJid: stored.chatJid, ...poll });
      const added = archive.addMessage(stored);
      if (added) hooks.onStored?.(stored, 'live');
      return added ? 'message stored' : 'message already stored';
    }
    case 'HistorySync': {
      const data = (event.Data ?? event.data ?? {}) as Record<string, unknown>;
      const batch = fromHistorySync(data);
      for (const c of batch.chats) archive.upsertChat(archive.resolveJid(c.jid), { name: c.name });
      for (const p of batch.pushNames) archive.upsertContact(archive.resolveJid(p.jid), { pushName: p.name });
      const messages = batch.messages.map((m) => archive.canonical(ownSender(m, account)));
      const added = archive.addMessages(messages);
      for (const p of batch.polls) archive.recordPoll({ ...p, chatJid: archive.resolveJid(p.chatJid) });
      let votes = 0;
      for (const v of batch.votes) if (archive.recordVote(v)) votes++;
      // After the messages, so an edit or delete finds the message it is about.
      let revised = 0;
      archive.db.transaction(() => {
        for (const d of batch.deleted) {
          const chatJid = archive.resolveJid(d.chatJid);
          if (archive.markDeleted(chatJid, d.id, d.timestamp)) revised++;
          else if (!archive.getMessage(d.id, chatJid)) {
            // Kept as a mark, so the conversation shows where something was deleted.
            archive.addMessage(
              archive.canonical(
                ownSender(
                  { chatJid, id: d.id, senderJid: d.senderJid, senderName: null, fromMe: d.fromMe, timestamp: d.timestamp, type: 'other', text: null, quotedId: null, media: null, deletedAt: d.timestamp },
                  account,
                ),
              ),
            );
          }
        }
        for (const r of batch.revisions) if (applyRevision(archive, r, hooks)) revised++;
      })();
      if (hooks.onStored) for (const m of messages) if (m.media && !m.deletedAt) hooks.onStored(m, 'history');
      hooks.onHistory?.(added);
      return `history sync: ${added} new of ${batch.messages.length} messages, ${batch.chats.length} chats, ${votes} poll votes, ${revised} edits/deletes`;
    }
    case 'PairSuccess': {
      const jid = typeof event.ID === 'string' ? bareJid(event.ID) : null;
      if (jid) hooks.onPaired(jid);
      return 'paired';
    }
    case 'LoggedOut':
      hooks.onLoggedOut();
      return 'logged out';
    default:
      return `ignored ${type || 'unknown event'}`;
  }
}
