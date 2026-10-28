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
  /** A phone just linked through the QR: a new link always starts from an empty archive. */
  onPaired(jid: string): void;
  /** The device was removed from the phone, or WhatsApp logged it out. */
  onLoggedOut(): void;
}

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
      if (!m) return 'message ignored (not archived content)';
      const info = (event.Info ?? {}) as Record<string, unknown>;
      if (m.chatJid.endsWith('@g.us') === false && !m.fromMe && m.senderName) {
        archive.upsertContact(m.senderJid, { pushName: m.senderName });
      }
      if (info.IsGroup === true) archive.upsertChat(m.chatJid, { isGroup: true });
      return archive.addMessage(ownSender(m, account)) ? 'message stored' : 'message already stored';
    }
    case 'HistorySync': {
      const data = (event.Data ?? event.data ?? {}) as Record<string, unknown>;
      const batch = fromHistorySync(data);
      for (const c of batch.chats) archive.upsertChat(c.jid, { name: c.name });
      for (const p of batch.pushNames) archive.upsertContact(p.jid, { pushName: p.name });
      const added = archive.addMessages(batch.messages.map((m) => ownSender(m, account)));
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
