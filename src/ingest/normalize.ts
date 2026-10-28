import type { ArchivedMessage, MediaRef, MessageType } from '../archive/archive.ts';

/**
 * Turns WhatsApp messages, as WuzAPI forwards them, into archive rows.
 *
 * Two shapes arrive:
 *  - a live message (and WuzAPI's stored history): `{ Info: {...}, Message: {...} }`, Go field names;
 *  - a history sync entry: `WebMessageInfo { key: {...}, message: {...}, messageTimestamp }`.
 * The inner `message` is the same protobuf in both, with camelCase keys.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
};
const obj = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined);

/** Strips the device part: "391234:12@s.whatsapp.net" → "391234@s.whatsapp.net". */
export function bareJid(jid: string): string {
  const [user, server] = jid.split('@');
  if (!server) return jid;
  return `${user!.split(':')[0]}@${server}`;
}

const isPn = (jid: string | undefined): jid is string => !!jid && jid.endsWith('@s.whatsapp.net');

/** Prefers the phone-number JID over the privacy LID when WhatsApp gives both. */
function preferPn(jid: string, alt: string | undefined): string {
  return jid.endsWith('@lid') && isPn(alt) ? bareJid(alt) : bareJid(jid);
}

/** Unwraps the containers WhatsApp puts around the real content. */
function unwrap(message: Obj): Obj {
  let m = message;
  for (let i = 0; i < 5; i++) {
    const inner =
      obj(obj(m.ephemeralMessage)?.message) ??
      obj(obj(m.viewOnceMessage)?.message) ??
      obj(obj(m.viewOnceMessageV2)?.message) ??
      obj(obj(m.viewOnceMessageV2Extension)?.message) ??
      obj(obj(m.documentWithCaptionMessage)?.message) ??
      obj(obj(m.editedMessage)?.message);
    if (!inner) return m;
    m = inner;
  }
  return m;
}

function mediaRef(kind: MediaRef['kind'], m: Obj): MediaRef {
  return {
    kind,
    url: str(m.URL) ?? str(m.url),
    directPath: str(m.directPath),
    mediaKey: str(m.mediaKey),
    mimetype: str(m.mimetype),
    fileEncSHA256: str(m.fileEncSHA256),
    fileSHA256: str(m.fileSHA256),
    fileLength: num(m.fileLength),
    fileName: str(m.fileName),
  };
}

export interface Content {
  type: MessageType;
  text: string | null;
  quotedId: string | null;
  media: MediaRef | null;
}

/** Reads type, text, reply target and media out of a message protobuf. Null for things that are not messages. */
export function readContent(message: Obj): Content | null {
  const m = unwrap(message);
  const quotedFrom = (x: Obj | undefined) => str(obj(x?.contextInfo)?.stanzaID) ?? null;

  if (str(m.conversation)) return { type: 'text', text: str(m.conversation)!, quotedId: null, media: null };

  const ext = obj(m.extendedTextMessage);
  if (ext) return { type: 'text', text: str(ext.text) ?? '', quotedId: quotedFrom(ext), media: null };

  const image = obj(m.imageMessage);
  if (image) return { type: 'image', text: str(image.caption) ?? null, quotedId: quotedFrom(image), media: mediaRef('image', image) };

  const video = obj(m.videoMessage);
  if (video) return { type: 'video', text: str(video.caption) ?? null, quotedId: quotedFrom(video), media: mediaRef('video', video) };

  const audio = obj(m.audioMessage);
  if (audio) {
    return { type: audio.PTT === true || audio.ptt === true ? 'voice' : 'audio', text: null, quotedId: quotedFrom(audio), media: mediaRef('audio', audio) };
  }

  const doc = obj(m.documentMessage);
  if (doc) {
    const caption = str(doc.caption) ?? null;
    return { type: 'document', text: caption, quotedId: quotedFrom(doc), media: mediaRef('document', doc) };
  }

  const sticker = obj(m.stickerMessage);
  if (sticker) return { type: 'sticker', text: null, quotedId: quotedFrom(sticker), media: mediaRef('sticker', sticker) };

  const loc = obj(m.locationMessage) ?? obj(m.liveLocationMessage);
  if (loc) {
    const where = [str(loc.name), str(loc.address)].filter(Boolean).join(', ');
    const coords = `${num(loc.degreesLatitude) ?? '?'}, ${num(loc.degreesLongitude) ?? '?'}`;
    return { type: 'location', text: where ? `${where} (${coords})` : coords, quotedId: null, media: null };
  }

  const contact = obj(m.contactMessage);
  if (contact) return { type: 'contact', text: str(contact.displayName) ?? null, quotedId: null, media: null };
  const contacts = obj(m.contactsArrayMessage);
  if (contacts) return { type: 'contact', text: str(contacts.displayName) ?? null, quotedId: null, media: null };

  const poll = obj(m.pollCreationMessage) ?? obj(m.pollCreationMessageV2) ?? obj(m.pollCreationMessageV3);
  if (poll) {
    const options = Array.isArray(poll.options) ? poll.options.map((o) => str(obj(o)?.optionName)).filter(Boolean) : [];
    return { type: 'poll', text: `${str(poll.name) ?? ''}${options.length ? ` — ${options.join(' / ')}` : ''}`, quotedId: null, media: null };
  }

  // Reactions, receipts, protocol messages (deletes, key shares…), poll votes: not archived.
  return null;
}

/** A live message, or a row of WuzAPI's stored history: `{ Info, Message }`. */
export function fromMessageEvent(event: Obj, fallback: { id?: string; chatJid?: string; timestamp?: number } = {}): ArchivedMessage | null {
  const info = obj(event.Info) ?? {};
  const message = obj(event.Message) ?? obj(event.RawMessage);
  if (!message) return null;
  const content = readContent(message);
  if (!content) return null;

  const rawChat = str(info.Chat) ?? fallback.chatJid;
  const id = str(info.ID) ?? fallback.id;
  if (!rawChat || !id) return null;
  const fromMe = info.IsFromMe === true;
  const isGroup = info.IsGroup === true || rawChat.endsWith('@g.us');

  const chatJid = isGroup ? bareJid(rawChat) : preferPn(rawChat, str(fromMe ? info.RecipientAlt : info.SenderAlt));
  const rawSender = str(info.Sender) ?? (fromMe ? 'me' : rawChat);
  const senderJid = rawSender === 'me' ? 'me' : preferPn(rawSender, str(info.SenderAlt));
  const ts = str(info.Timestamp) ? Math.floor(Date.parse(str(info.Timestamp)!) / 1000) : NaN;

  return {
    chatJid,
    id,
    senderJid,
    senderName: fromMe ? null : (str(info.PushName) ?? null),
    fromMe,
    timestamp: Number.isFinite(ts) && ts > 0 ? ts : (fallback.timestamp ?? Math.floor(Date.now() / 1000)),
    ...content,
  };
}

/** One entry of a history sync: `WebMessageInfo`. */
export function fromWebMessage(web: Obj, conversationJid?: string): ArchivedMessage | null {
  const key = obj(web.key) ?? {};
  const message = obj(web.message);
  if (!message) return null;
  const content = readContent(message);
  if (!content) return null;

  const rawChat = str(key.remoteJID) ?? str(key.remoteJid) ?? conversationJid;
  const id = str(key.ID) ?? str(key.id);
  if (!rawChat || !id) return null;
  const fromMe = key.fromMe === true;
  const isGroup = rawChat.endsWith('@g.us');
  const participant = str(key.participant) ?? str(web.participant);

  const chatJid = !isGroup && conversationJid && isPn(conversationJid) ? bareJid(conversationJid) : bareJid(rawChat);
  const senderJid = fromMe ? 'me' : bareJid(isGroup ? (participant ?? rawChat) : chatJid);

  return {
    chatJid,
    id,
    senderJid,
    senderName: fromMe ? null : (str(web.pushName) ?? null),
    fromMe,
    timestamp: num(web.messageTimestamp) ?? Math.floor(Date.now() / 1000),
    ...content,
  };
}

export interface HistoryBatch {
  messages: ArchivedMessage[];
  chats: { jid: string; name: string | null }[];
  pushNames: { jid: string; name: string }[];
}

/** Everything useful in a HistorySync event's `Data`. */
export function fromHistorySync(data: Obj): HistoryBatch {
  const batch: HistoryBatch = { messages: [], chats: [], pushNames: [] };
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  for (const c of conversations) {
    if (!isObj(c)) continue;
    const id = str(c.ID) ?? str(c.id);
    if (!id) continue;
    // A direct chat may be keyed by its privacy LID; the phone-number JID is kept alongside.
    const pn = str(c.pnJID) ?? str(c.pnJid);
    const jid = id.endsWith('@lid') && isPn(pn) ? bareJid(pn) : bareJid(id);
    batch.chats.push({ jid, name: str(c.name) ?? str(c.displayName) ?? null });
    const messages = Array.isArray(c.messages) ? c.messages : [];
    for (const entry of messages) {
      const web = obj(obj(entry)?.message);
      if (!web) continue;
      const m = fromWebMessage(web, jid);
      if (m) batch.messages.push(m);
    }
  }
  const pushnames = Array.isArray(data.pushnames) ? data.pushnames : [];
  for (const p of pushnames) {
    const jid = str(obj(p)?.ID) ?? str(obj(p)?.id);
    const name = str(obj(p)?.pushname);
    if (jid && name) batch.pushNames.push({ jid: bareJid(jid), name });
  }
  return batch;
}
