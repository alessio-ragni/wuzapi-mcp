import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'other';

/** What WuzAPI needs to download a message's media later. Stored as JSON. */
export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  url?: string;
  directPath?: string;
  mediaKey?: string;
  mimetype?: string;
  fileEncSHA256?: string;
  fileSHA256?: string;
  fileLength?: number;
  fileName?: string;
}

export interface ArchivedMessage {
  chatJid: string;
  id: string;
  senderJid: string;
  senderName: string | null;
  fromMe: boolean;
  timestamp: number; // unix seconds
  type: MessageType;
  text: string | null;
  quotedId: string | null;
  media: MediaRef | null;
}

export interface Chat {
  jid: string;
  name: string | null;
  isGroup: boolean;
  lastMessageAt: number | null;
}

export interface Contact {
  jid: string;
  name: string | null;
  pushName: string | null;
}

interface MessageRow {
  chat_jid: string;
  id: string;
  sender_jid: string;
  sender_name: string | null;
  from_me: number;
  timestamp: number;
  type: MessageType;
  text: string | null;
  quoted_id: string | null;
  media: string | null;
}

interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  last_message_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  jid             TEXT PRIMARY KEY,
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER
);
CREATE TABLE IF NOT EXISTS contacts (
  jid       TEXT PRIMARY KEY,
  name      TEXT,
  push_name TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  rowid       INTEGER PRIMARY KEY,
  chat_jid    TEXT NOT NULL,
  id          TEXT NOT NULL,
  sender_jid  TEXT NOT NULL,
  sender_name TEXT,
  from_me     INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL,
  type        TEXT NOT NULL,
  text        TEXT,
  quoted_id   TEXT,
  media       TEXT,
  UNIQUE (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_time ON messages (chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS messages_time ON messages (timestamp);
CREATE INDEX IF NOT EXISTS messages_id ON messages (id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  text, content = 'messages', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
`;

function toMessage(row: MessageRow): ArchivedMessage {
  return {
    chatJid: row.chat_jid,
    id: row.id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    fromMe: row.from_me === 1,
    timestamp: row.timestamp,
    type: row.type,
    text: row.text,
    quotedId: row.quoted_id,
    media: row.media ? (JSON.parse(row.media) as MediaRef) : null,
  };
}

function toChat(row: ChatRow): Chat {
  return { jid: row.jid, name: row.name, isGroup: row.is_group === 1, lastMessageAt: row.last_message_at };
}

/** Turns free text into an FTS5 query that matches every word as a prefix, with no syntax to trip over. */
export function ftsQuery(text: string): string {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((w) => `"${w}"*`).join(' ');
}

/**
 * The local message archive: one WhatsApp account at a time.
 * Linking a different account, or unlinking, wipes it.
 */
export class Archive {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- account -------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  accountJid(): string | null {
    return this.getMeta('account_jid');
  }

  /**
   * Records which account the archive belongs to. A different account than the one on file
   * means a new link: everything from the old one is deleted first. Returns true when it wiped.
   */
  claimAccount(jid: string): boolean {
    const current = this.accountJid();
    if (current === jid) return false;
    const wiped = current !== null;
    if (wiped) this.wipe();
    this.setMeta('account_jid', jid);
    return wiped;
  }

  /** Deletes every message, chat, contact and setting. */
  wipe(): void {
    this.db.exec(`
      DELETE FROM messages;
      DELETE FROM chats;
      DELETE FROM contacts;
      DELETE FROM meta;
      INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');
    `);
    this.db.exec('VACUUM');
  }

  // --- writing -------------------------------------------------------------

  upsertChat(jid: string, fields: { name?: string | null; isGroup?: boolean; lastMessageAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, is_group, last_message_at) VALUES (@jid, @name, @isGroup, @lastMessageAt)
         ON CONFLICT (jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           is_group = MAX(chats.is_group, excluded.is_group),
           last_message_at = MAX(COALESCE(chats.last_message_at, 0), COALESCE(excluded.last_message_at, 0))`,
      )
      .run({
        jid,
        name: fields.name ?? null,
        isGroup: fields.isGroup || jid.endsWith('@g.us') ? 1 : 0,
        lastMessageAt: fields.lastMessageAt ?? null,
      });
  }

  upsertContact(jid: string, fields: { name?: string | null; pushName?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name, push_name) VALUES (@jid, @name, @pushName)
         ON CONFLICT (jid) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           push_name = COALESCE(excluded.push_name, contacts.push_name)`,
      )
      .run({ jid, name: fields.name ?? null, pushName: fields.pushName ?? null });
  }

  /** Stores a message once; a second copy of the same id (live + history) changes nothing. */
  addMessage(m: ArchivedMessage): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO messages (chat_jid, id, sender_jid, sender_name, from_me, timestamp, type, text, quoted_id, media)
         VALUES (@chatJid, @id, @senderJid, @senderName, @fromMe, @timestamp, @type, @text, @quotedId, @media)
         ON CONFLICT (chat_jid, id) DO NOTHING`,
      )
      .run({
        ...m,
        fromMe: m.fromMe ? 1 : 0,
        media: m.media ? JSON.stringify(m.media) : null,
      });
    this.upsertChat(m.chatJid, { lastMessageAt: m.timestamp });
    if (!m.fromMe && m.senderName) this.upsertContact(m.senderJid, { pushName: m.senderName });
    return result.changes > 0;
  }

  addMessages(messages: ArchivedMessage[]): number {
    let added = 0;
    this.db.transaction(() => {
      for (const m of messages) if (this.addMessage(m)) added++;
    })();
    return added;
  }

  // --- reading -------------------------------------------------------------

  stats(): { chats: number; messages: number; contacts: number; oldest: number | null; newest: number | null } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number | null }).n;
    return {
      chats: one('SELECT COUNT(*) AS n FROM chats') ?? 0,
      messages: one('SELECT COUNT(*) AS n FROM messages') ?? 0,
      contacts: one('SELECT COUNT(*) AS n FROM contacts') ?? 0,
      oldest: one('SELECT MIN(timestamp) AS n FROM messages'),
      newest: one('SELECT MAX(timestamp) AS n FROM messages'),
    };
  }

  /** Best display name for a JID: saved contact name, then chat name, then the name they set themselves. */
  displayName(jid: string): string | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(c.name, ch.name, c.push_name) AS name
         FROM (SELECT ? AS jid) j
         LEFT JOIN contacts c ON c.jid = j.jid
         LEFT JOIN chats ch ON ch.jid = j.jid`,
      )
      .get(jid) as { name: string | null };
    return row.name;
  }

  getChat(jid: string): Chat | null {
    const row = this.db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as ChatRow | undefined;
    return row ? toChat(row) : null;
  }

  listChats(opts: { query?: string; limit: number; offset: number; groupsOnly?: boolean }): Chat[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit, offset: opts.offset };
    if (opts.query) {
      where.push(`(ch.name LIKE @q OR ch.jid LIKE @q OR c.name LIKE @q OR c.push_name LIKE @q)`);
      params.q = `%${opts.query}%`;
    }
    if (opts.groupsOnly) where.push('ch.is_group = 1');
    const rows = this.db
      .prepare(
        `SELECT ch.jid, COALESCE(ch.name, c.name, c.push_name) AS name, ch.is_group, ch.last_message_at
         FROM chats ch LEFT JOIN contacts c ON c.jid = ch.jid
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ch.last_message_at DESC NULLS LAST
         LIMIT @limit OFFSET @offset`,
      )
      .all(params) as ChatRow[];
    return rows.map(toChat);
  }

  searchContacts(query: string, limit: number): Contact[] {
    const q = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT jid, name, push_name FROM contacts
         WHERE jid NOT LIKE '%@g.us' AND (name LIKE ? OR push_name LIKE ? OR jid LIKE ?)
         ORDER BY name IS NULL, name, push_name
         LIMIT ?`,
      )
      .all(q, q, q, limit) as { jid: string; name: string | null; push_name: string | null }[];
    return rows.map((r) => ({ jid: r.jid, name: r.name, pushName: r.push_name }));
  }

  listMessages(opts: {
    chatJid?: string;
    senderJid?: string;
    after?: number;
    before?: number;
    query?: string;
    limit: number;
    offset: number;
  }): ArchivedMessage[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit, offset: opts.offset };
    let from = 'messages m';
    if (opts.query) {
      const match = ftsQuery(opts.query);
      if (!match) return [];
      from = 'messages_fts f JOIN messages m ON m.rowid = f.rowid';
      where.push('messages_fts MATCH @match');
      params.match = match;
    }
    if (opts.chatJid) (where.push('m.chat_jid = @chatJid'), (params.chatJid = opts.chatJid));
    if (opts.senderJid) (where.push('m.sender_jid = @senderJid'), (params.senderJid = opts.senderJid));
    if (opts.after !== undefined) (where.push('m.timestamp >= @after'), (params.after = opts.after));
    if (opts.before !== undefined) (where.push('m.timestamp <= @before'), (params.before = opts.before));
    const rows = this.db
      .prepare(
        `SELECT m.* FROM ${from}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.timestamp DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(params) as MessageRow[];
    return rows.map(toMessage);
  }

  getMessage(id: string, chatJid?: string): ArchivedMessage | null {
    const row = (
      chatJid
        ? this.db.prepare('SELECT * FROM messages WHERE id = ? AND chat_jid = ?').get(id, chatJid)
        : this.db.prepare('SELECT * FROM messages WHERE id = ? ORDER BY timestamp DESC LIMIT 1').get(id)
    ) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  /** The messages just before and just after one message, in time order. */
  messageContext(id: string, chatJid: string | undefined, before: number, after: number): ArchivedMessage[] | null {
    const target = this.getMessage(id, chatJid);
    if (!target) return null;
    const older = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_jid = ? AND (timestamp < ? OR (timestamp = ? AND rowid < (SELECT rowid FROM messages WHERE chat_jid = ? AND id = ?)))
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(target.chatJid, target.timestamp, target.timestamp, target.chatJid, target.id, before) as MessageRow[];
    const newer = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND rowid > (SELECT rowid FROM messages WHERE chat_jid = ? AND id = ?)))
         ORDER BY timestamp ASC, rowid ASC LIMIT ?`,
      )
      .all(target.chatJid, target.timestamp, target.timestamp, target.chatJid, target.id, after) as MessageRow[];
    return [...older.reverse().map(toMessage), target, ...newer.map(toMessage)];
  }
}
