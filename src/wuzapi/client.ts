/**
 * A small typed client for the WuzAPI endpoints wuzapi-mcp uses.
 * Field names follow WuzAPI 1.1.0 exactly (they are case-sensitive on the way back).
 */

export class WuzapiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SessionStatus {
  connected: boolean;
  loggedIn: boolean;
  jid: string;
  name: string;
  events: string;
}

export interface AdminUser {
  id: string;
  name: string;
  token: string;
  jid: string;
  events: string;
  connected: boolean;
  loggedIn: boolean;
}

export interface HistoryRow {
  id: number;
  chat_jid: string;
  sender_jid: string;
  message_id: string;
  timestamp: string;
  message_type: string;
  text_content: string;
  quoted_message_id?: string;
  data_json?: string | Record<string, unknown> | null;
}

export interface ContactInfo {
  Found: boolean;
  FirstName: string;
  FullName: string;
  PushName: string;
  BusinessName: string;
}

export interface GroupParticipant {
  JID: string;
  PhoneNumber?: string;
  IsAdmin: boolean;
  IsSuperAdmin: boolean;
  DisplayName?: string;
}

export interface GroupInfo {
  JID: string;
  OwnerJID?: string;
  Name: string;
  Topic?: string;
  GroupCreated?: string;
  Participants?: GroupParticipant[];
  ParticipantCount?: number;
}

export interface SendResult {
  Id: string;
  Timestamp: number;
}

export interface MediaDownload {
  Url?: string;
  DirectPath?: string;
  MediaKey?: string;
  Mimetype?: string;
  FileEncSHA256?: string;
  FileSHA256?: string;
  FileLength?: number;
}

export interface ReplyTo {
  messageId: string;
  participant: string;
  quotedText?: string;
}

/** Events wuzapi-mcp needs. WuzAPI only forwards the types a user is subscribed to. */
export const EVENTS = ['Message', 'HistorySync', 'PairSuccess', 'LoggedOut'];

export class Wuzapi {
  readonly baseUrl: string;
  readonly userToken: string;
  readonly adminToken: string;

  constructor(baseUrl: string, userToken: string, adminToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.userToken = userToken;
    this.adminToken = adminToken;
  }

  private async call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; form?: FormData; admin?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = opts.admin ? { Authorization: this.adminToken } : { token: this.userToken };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const raw = await res.text();
    let json: { success?: boolean; data?: unknown; error?: string } = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      throw new WuzapiError(res.status, `WuzAPI ${method} ${path}: ${res.status} ${raw.slice(0, 200)}`);
    }
    if (!res.ok || json.success === false) {
      throw new WuzapiError(res.status, `WuzAPI ${method} ${path}: ${json.error ?? res.statusText}`);
    }
    return json.data as T;
  }

  // --- admin ---------------------------------------------------------------

  listUsers(): Promise<AdminUser[]> {
    return this.call<AdminUser[]>('GET', '/admin/users', { admin: true }).then((u) => u ?? []);
  }

  createUser(user: { name: string; events: string; history: number; days_to_sync_history: number }): Promise<{ id: string }> {
    return this.call('POST', '/admin/users', { admin: true, body: { ...user, token: this.userToken } });
  }

  editUser(id: string, fields: { events?: string; history?: number; days_to_sync_history?: number }): Promise<unknown> {
    return this.call('PUT', `/admin/users/${encodeURIComponent(id)}`, { admin: true, body: fields });
  }

  /** Removes the user with its WhatsApp session and every message WuzAPI stored for it. */
  deleteUserCompletely(id: string): Promise<unknown> {
    return this.call('DELETE', `/admin/users/${encodeURIComponent(id)}/full`, { admin: true });
  }

  // --- session -------------------------------------------------------------

  status(): Promise<SessionStatus> {
    return this.call('GET', '/session/status', { timeoutMs: 5_000 });
  }

  connect(): Promise<unknown> {
    return this.call('POST', '/session/connect', { body: { Subscribe: EVENTS, Immediate: true } });
  }

  async qr(): Promise<string | null> {
    const data = await this.call<{ QRCode?: string }>('GET', '/session/qr', { timeoutMs: 5_000 });
    return data?.QRCode || null;
  }

  /** How many messages per chat WuzAPI keeps, and how many days of history a new link asks the phone for. */
  setHistory(history: number, days: number): Promise<unknown> {
    return this.call('POST', '/session/history', { body: { history, days_to_sync_history: days } });
  }

  logout(): Promise<unknown> {
    return this.call('POST', '/session/logout');
  }

  // --- stored history ------------------------------------------------------

  conversations(offset: number, limit = 200): Promise<{ chats: { chat_jid: string }[] | null; has_more: boolean; next_offset?: number }> {
    return this.call('GET', `/chat/conversations?limit=${limit}&offset=${offset}`);
  }

  messages(chatJid: string, before?: number, limit = 100): Promise<{ messages: HistoryRow[] | null; has_more: boolean; next_before?: number }> {
    const q = new URLSearchParams({ chat_jid: chatJid, limit: String(limit) });
    if (before !== undefined) q.set('before', String(before));
    return this.call('GET', `/chat/messages?${q}`);
  }

  // --- contacts and groups ---------------------------------------------------

  contacts(): Promise<Record<string, ContactInfo>> {
    return this.call<Record<string, ContactInfo>>('GET', '/user/contacts').then((c) => c ?? {});
  }

  /** The privacy LID WhatsApp uses for a phone number, or null when it has none on file. */
  async lidFor(pnJid: string): Promise<string | null> {
    try {
      const data = await this.call<{ lid?: string }>('GET', `/user/lid/${encodeURIComponent(pnJid)}`, { timeoutMs: 5_000 });
      return data?.lid || null;
    } catch (err) {
      if (err instanceof WuzapiError && err.status === 404) return null;
      throw err;
    }
  }

  groups(): Promise<GroupInfo[]> {
    return this.call<{ Groups: GroupInfo[] | null }>('GET', '/group/list').then((d) => d?.Groups ?? []);
  }

  groupInfo(groupJid: string): Promise<GroupInfo> {
    return this.call('GET', `/group/info?groupJID=${encodeURIComponent(groupJid)}`);
  }

  // --- sending ---------------------------------------------------------------

  private contextInfo(reply?: ReplyTo) {
    return reply
      ? { ContextInfo: { StanzaID: reply.messageId, Participant: reply.participant }, QuotedText: reply.quotedText ?? '' }
      : {};
  }

  sendText(to: string, body: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/text', { body: { Phone: to, Body: body, LinkPreview: true, ...this.contextInfo(reply) } });
  }

  sendImage(to: string, dataUrl: string, caption?: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/image', { body: { Phone: to, Image: dataUrl, Caption: caption ?? '', ...this.contextInfo(reply) }, timeoutMs: 120_000 });
  }

  sendVideo(to: string, dataUrl: string, caption?: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/video', { body: { Phone: to, Video: dataUrl, Caption: caption ?? '', ...this.contextInfo(reply) }, timeoutMs: 120_000 });
  }

  sendDocument(to: string, dataUrl: string, fileName: string, caption?: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/document', {
      body: { Phone: to, Document: dataUrl, FileName: fileName, Caption: caption ?? '', ...this.contextInfo(reply) },
      timeoutMs: 120_000,
    });
  }

  /** Sends any audio file as a voice note; WuzAPI converts it to ogg/opus with ffmpeg. */
  sendVoice(to: string, audio: Buffer, fileName: string, mimetype: string): Promise<SendResult> {
    const form = new FormData();
    form.append('Phone', to);
    form.append('Audio', new Blob([new Uint8Array(audio)], { type: mimetype }), fileName);
    return this.call('POST', '/chat/send/voice', { form, timeoutMs: 120_000 });
  }

  sendPoll(to: string, question: string, options: string[]): Promise<SendResult> {
    return this.call('POST', '/chat/send/poll', { body: { group: to, header: question, options } });
  }

  /** Reacts to a message; an empty emoji removes the reaction. */
  react(chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string): Promise<SendResult> {
    return this.call('POST', '/chat/react', {
      body: {
        Phone: chatJid,
        Id: fromMe ? `me:${messageId}` : messageId,
        Body: emoji || 'remove',
        ...(participant ? { Participant: participant } : {}),
      },
    });
  }

  // --- media -------------------------------------------------------------------

  async download(kind: 'image' | 'video' | 'audio' | 'document' | 'sticker', media: MediaDownload): Promise<{ mimetype: string; data: Buffer }> {
    const out = await this.call<{ Mimetype: string; Data: string }>('POST', `/chat/download${kind}`, { body: media, timeoutMs: 120_000 });
    const comma = out.Data.indexOf(',');
    return { mimetype: out.Mimetype, data: Buffer.from(out.Data.slice(comma + 1), 'base64') };
  }
}
