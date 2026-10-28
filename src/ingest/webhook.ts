import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Archive, ArchivedMessage } from '../archive/archive.ts';
import { bareJid, fromHistorySync, fromMessageEvent } from './normalize.ts';

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
}

/** Message parts that carry no content of their own: key exchange, reactions, edits/deletes, votes. */
const ROUTINE = new Set([
  'messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage', 'reactionMessage',
  'pollUpdateMessage', 'keepInChatMessage', 'encReactionMessage',
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
      return archive.addMessage(stored) ? 'message stored' : 'message already stored';
    }
    case 'HistorySync': {
      const data = (event.Data ?? event.data ?? {}) as Record<string, unknown>;
      const batch = fromHistorySync(data);
      for (const c of batch.chats) archive.upsertChat(archive.resolveJid(c.jid), { name: c.name });
      for (const p of batch.pushNames) archive.upsertContact(archive.resolveJid(p.jid), { pushName: p.name });
      const added = archive.addMessages(batch.messages.map((m) => archive.canonical(ownSender(m, account))));
      hooks.onHistory?.(added);
      return `history sync: ${added} new of ${batch.messages.length} messages, ${batch.chats.length} chats`;
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
