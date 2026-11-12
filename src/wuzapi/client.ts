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
  LID?: string;
  IsAdmin: boolean;
  IsSuperAdmin: boolean;
  DisplayName?: string;
  /** Set when creating a group could not add this person: 403 means their privacy settings need an invite. */
  Error?: number;
}

export interface GroupInfo {
  JID: string;
  OwnerJID?: string;
  Name: string;
  Topic?: string;
  GroupCreated?: string;
  Participants?: GroupParticipant[];
  ParticipantCount?: number;
  MemberAddMode?: string;
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

export interface UserCheck {
  Query: string;
  IsInWhatsapp: boolean;
  JID: string;
  VerifiedName?: string;
}

export interface UserInfo {
  Status?: string;
  PictureID?: string;
  VerifiedName?: { Details?: { verifiedName?: string } } | null;
  Devices?: string[] | null;
  LID?: string;
}

export interface JoinRequest {
  JID: string;
  RequestedAt?: string;
}

/** A channel (newsletter), as whatsmeow describes it. Only the fields we show. */
export interface Channel {
  id: string;
  state?: { type?: string };
  thread_metadata?: {
    name?: { text?: string };
    description?: { text?: string };
    invite?: string;
    subscribers_count?: string | number;
    verification?: string;
  };
  viewer_metadata?: { mute?: string; role?: string } | null;
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

  /** Creates a group with you as its owner. People who could not be added carry an `Error` in the result. */
  createGroup(name: string, participants: string[], membersCanAdd: boolean): Promise<GroupInfo> {
    return this.call('POST', '/group/create', {
      body: { name, participants, memberaddmode: membersCanAdd ? 'all_member_add' : 'admin_add' },
      timeoutMs: 60_000,
    });
  }

  updateParticipants(groupJid: string, people: string[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<unknown> {
    return this.call('POST', '/group/updateparticipants', { body: { GroupJID: groupJid, Phone: people, Action: action } });
  }

  async inviteLink(groupJid: string, reset = false): Promise<string> {
    const data = await this.call<{ InviteLink: string }>('GET', `/group/invitelink?groupJID=${encodeURIComponent(groupJid)}&reset=${reset}`);
    return data.InviteLink;
  }

  setMemberAddMode(groupJid: string, membersCanAdd: boolean): Promise<unknown> {
    return this.call('POST', '/group/memberaddmode', { body: { groupjid: groupJid, mode: membersCanAdd ? 'all_member_add' : 'admin_add' } });
  }

  /**
   * Asks the phone for up to `count` messages of one chat older than the anchor message.
   * The answer arrives later, as a HistorySync webhook.
   */
  requestHistory(chatJid: string, anchor: { id: string; fromMe: boolean; timestampMs: number }, count = 50): Promise<unknown> {
    const q = new URLSearchParams({
      chat_jid: chatJid,
      oldest_msg_id: anchor.id,
      oldest_msg_from_me: String(anchor.fromMe),
      oldest_msg_timestamp: String(anchor.timestampMs),
      count: String(count),
    });
    return this.call('GET', `/session/history?${q}`);
  }

  // --- sending ---------------------------------------------------------------

  private contextInfo(reply?: ReplyTo): { ContextInfo?: Record<string, unknown>; QuotedText?: string } {
    return reply
      ? { ContextInfo: { StanzaID: reply.messageId, Participant: reply.participant }, QuotedText: reply.quotedText ?? '' }
      : {};
  }

  /** Sends text; `mentions` are JIDs tagged with @, `mentionAll` tags every member of a group. */
  sendText(to: string, body: string, reply?: ReplyTo, mentions: string[] = [], mentionAll = false): Promise<SendResult> {
    const context = this.contextInfo(reply);
    if (mentions.length) context.ContextInfo = { ...(context.ContextInfo ?? {}), MentionedJID: mentions };
    return this.call('POST', '/chat/send/text', {
      body: { Phone: to, Body: body, LinkPreview: true, ...context, ...(mentionAll ? { MentionAll: true } : {}) },
    });
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

  // --- message actions -------------------------------------------------------

  /** Deletes a message for everyone. `sender` only to delete someone else's message in a group you administer. */
  deleteMessage(chatJid: string, messageId: string, sender?: string): Promise<{ Id: string }> {
    return this.call('POST', '/chat/delete', { body: { Phone: chatJid, Id: messageId, ...(sender ? { SenderJID: sender } : {}) } });
  }

  editMessage(chatJid: string, messageId: string, body: string): Promise<SendResult> {
    return this.call('POST', '/chat/send/edit', { body: { Phone: chatJid, Id: messageId, Body: body } });
  }

  /** Pins a message for everyone in the chat (1, 7 or 30 days), or unpins it. */
  pinMessage(chatJid: string, messageId: string, pin: boolean, sender?: string, durationSeconds?: number): Promise<unknown> {
    return this.call('POST', '/chat/pin', {
      body: { Chat: chatJid, Id: messageId, Pin: pin, ...(sender ? { Sender: sender } : {}), ...(pin && durationSeconds ? { DurationSeconds: durationSeconds } : {}) },
    });
  }

  starMessage(chatJid: string, messageId: string, fromMe: boolean, star: boolean, sender?: string): Promise<unknown> {
    return this.call('POST', '/chat/star', { body: { Chat: chatJid, Id: messageId, FromMe: fromMe, Star: star, ...(sender ? { Sender: sender } : {}) } });
  }

  /** Votes on a poll; `sender` is whoever created it. An empty list withdraws the vote. */
  votePoll(chatJid: string, pollId: string, sender: string, fromMe: boolean, options: string[]): Promise<SendResult> {
    return this.call('POST', '/chat/poll/vote', { body: { Chat: chatJid, Sender: sender, Id: pollId, FromMe: fromMe, Options: options } });
  }

  markRead(chatJid: string, messageIds: string[], sender?: string): Promise<unknown> {
    return this.call('POST', '/chat/markread', { body: { Id: messageIds, ChatPhone: chatJid, ...(sender ? { SenderPhone: sender } : {}) } });
  }

  // --- chat list -------------------------------------------------------------

  archiveChat(chatJid: string, archive: boolean): Promise<unknown> {
    return this.call('POST', '/chat/archive', { body: { jid: chatJid, archive } });
  }

  pinChat(chatJid: string, pin: boolean): Promise<unknown> {
    return this.call('POST', '/chat/pinchat', { body: { Chat: chatJid, Pin: pin } });
  }

  /** Mutes a chat for `seconds`, or for ever with 0; unmutes with mute=false. */
  muteChat(chatJid: string, mute: boolean, seconds = 0): Promise<unknown> {
    return this.call('POST', '/chat/mute', { body: { Chat: chatJid, Mute: mute, ...(mute && seconds ? { DurationSeconds: seconds } : {}) } });
  }

  markChatUnread(chatJid: string, unread: boolean): Promise<unknown> {
    return this.call('POST', '/chat/unread', { body: { Chat: chatJid, Unread: unread } });
  }

  // --- more sending ------------------------------------------------------------

  sendLocation(to: string, latitude: number, longitude: number, name?: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/location', { body: { Phone: to, Latitude: latitude, Longitude: longitude, Name: name ?? '', ...this.contextInfo(reply) } });
  }

  sendContact(to: string, name: string, vcard: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/contact', { body: { Phone: to, Name: name, Vcard: vcard, ...this.contextInfo(reply) } });
  }

  /** Sends an image (or short video) as a sticker; WuzAPI converts it to WebP. */
  sendSticker(to: string, dataUrl: string, mimetype: string, reply?: ReplyTo): Promise<SendResult> {
    return this.call('POST', '/chat/send/sticker', { body: { Phone: to, Sticker: dataUrl, MimeType: mimetype, ...this.contextInfo(reply) }, timeoutMs: 120_000 });
  }

  // --- group settings ----------------------------------------------------------

  setGroupName(groupJid: string, name: string): Promise<unknown> {
    return this.call('POST', '/group/name', { body: { GroupJID: groupJid, Name: name } });
  }

  setGroupTopic(groupJid: string, topic: string): Promise<unknown> {
    return this.call('POST', '/group/topic', { body: { GroupJID: groupJid, Topic: topic } });
  }

  /** Sets the group picture: a JPEG, as a data URL. */
  setGroupPhoto(groupJid: string, jpegDataUrl: string): Promise<{ PictureID?: string }> {
    return this.call('POST', '/group/photo', { body: { GroupJID: groupJid, Image: jpegDataUrl }, timeoutMs: 60_000 });
  }

  removeGroupPhoto(groupJid: string): Promise<unknown> {
    return this.call('POST', '/group/photo/remove', { body: { groupjid: groupJid } });
  }

  /** Only admins send messages (announce), or everyone does. */
  setGroupAnnounce(groupJid: string, announce: boolean): Promise<unknown> {
    return this.call('POST', '/group/announce', { body: { GroupJID: groupJid, Announce: announce } });
  }

  /** Only admins edit the name, description and picture (locked), or everyone does. */
  setGroupLocked(groupJid: string, locked: boolean): Promise<unknown> {
    return this.call('POST', '/group/locked', { body: { groupjid: groupJid, locked } });
  }

  setDisappearing(groupJid: string, duration: 'off' | '24h' | '7d' | '90d'): Promise<unknown> {
    return this.call('POST', '/group/ephemeral', { body: { groupjid: groupJid, duration } });
  }

  setJoinApproval(groupJid: string, on: boolean): Promise<unknown> {
    return this.call('POST', '/group/joinapprovalmode', { body: { groupjid: groupJid, mode: on } });
  }

  leaveGroup(groupJid: string): Promise<unknown> {
    return this.call('POST', '/group/leave', { body: { GroupJID: groupJid } });
  }

  /** What a group invite link leads to, without joining. */
  inviteInfo(code: string): Promise<GroupInfo> {
    return this.call('POST', '/group/inviteinfo', { body: { Code: code } });
  }

  joinGroup(code: string): Promise<unknown> {
    return this.call('POST', '/group/join', { body: { Code: code }, timeoutMs: 60_000 });
  }

  async joinRequests(groupJid: string): Promise<JoinRequest[]> {
    const data = await this.call<JoinRequest[] | null>('GET', `/group/requestparticipants?groupJID=${encodeURIComponent(groupJid)}`);
    return data ?? [];
  }

  answerJoinRequests(groupJid: string, people: string[], action: 'approve' | 'reject'): Promise<unknown> {
    return this.call('POST', '/group/updaterequestparticipants', { body: { GroupJID: groupJid, Phone: people, Action: action } });
  }

  // --- people ------------------------------------------------------------------

  /** Which numbers have WhatsApp. Digits only, with country code. */
  async checkUsers(phones: string[]): Promise<UserCheck[]> {
    const data = await this.call<{ Users: UserCheck[] | null }>('POST', '/user/check', { body: { Phone: phones.map((p) => `+${p.replace(/^\+/, '')}`) } });
    return data?.Users ?? [];
  }

  async userInfo(jids: string[]): Promise<Record<string, UserInfo>> {
    const data = await this.call<{ Users: Record<string, UserInfo> | null }>('POST', '/user/info', { body: { Phone: jids } });
    return data?.Users ?? {};
  }

  /** Where to fetch someone's profile picture, or null when they have none or hide it from you. */
  async avatar(jid: string, preview = false): Promise<{ url: string; id?: string } | null> {
    try {
      const data = await this.call<{ url?: string; URL?: string; id?: string; ID?: string }>('POST', '/user/avatar', { body: { Phone: jid, Preview: preview } });
      const url = data?.url ?? data?.URL;
      return url ? { url, id: data?.id ?? data?.ID } : null;
    } catch (err) {
      if (/no avatar|not-authorized|item-not-found|\b40[134]\b/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  block(jid: string): Promise<unknown> {
    return this.call('POST', '/user/block', { body: { JID: jid } });
  }

  unblock(jid: string): Promise<unknown> {
    return this.call('POST', '/user/unblock', { body: { JID: jid } });
  }

  async blocklist(): Promise<string[]> {
    const data = await this.call<{ Blocklist?: string[] | null }>('GET', '/user/blocklist');
    return data?.Blocklist ?? [];
  }

  /** Your own "about" text. */
  setAbout(text: string): Promise<unknown> {
    return this.call('POST', '/status/set/text', { body: { Body: text } });
  }

  // --- channels ----------------------------------------------------------------

  async channels(): Promise<Channel[]> {
    const data = await this.call<{ Newsletter?: Channel[] | null }>('GET', '/newsletter/list');
    return data?.Newsletter ?? [];
  }

  followChannel(jid: string): Promise<unknown> {
    return this.call('POST', '/newsletter/join', { body: { NewsletterJID: jid } });
  }

  unfollowChannel(jid: string): Promise<unknown> {
    return this.call('POST', '/newsletter/leave', { body: { NewsletterJID: jid } });
  }

  muteChannel(jid: string, mute: boolean): Promise<unknown> {
    return this.call('POST', '/newsletter/mute', { body: { NewsletterJID: jid, Mute: mute } });
  }

  // --- media -------------------------------------------------------------------

  async download(kind: 'image' | 'video' | 'audio' | 'document' | 'sticker', media: MediaDownload): Promise<{ mimetype: string; data: Buffer }> {
    const out = await this.call<{ Mimetype: string; Data: string }>('POST', `/chat/download${kind}`, { body: media, timeoutMs: 120_000 });
    const comma = out.Data.indexOf(',');
    return { mimetype: out.Mimetype, data: Buffer.from(out.Data.slice(comma + 1), 'base64') };
  }
}
