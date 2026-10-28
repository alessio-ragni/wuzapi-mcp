import type { Archive } from './archive/archive.ts';
import type { Config } from './config.ts';
import { fromMessageEvent, bareJid } from './ingest/normalize.ts';
import { ownSender } from './ingest/webhook.ts';
import { EVENTS, type Wuzapi } from './wuzapi/client.ts';

export interface WhatsAppState {
  reachable: boolean;
  connected: boolean;
  loggedIn: boolean;
  phone: string | null;
  qr: string | null;
  error?: string;
}

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

/**
 * Keeps the WuzAPI side in the shape wuzapi-mcp needs — one user, subscribed to the right
 * events, connected — and keeps the archive tied to the account that is linked.
 */
export class Session {
  readonly config: Config;
  readonly wuzapi: Wuzapi;
  readonly archive: Archive;
  backfillState = 'not started';
  private userReady = false;
  private backfilling = false;

  constructor(config: Config, wuzapi: Wuzapi, archive: Archive) {
    this.config = config;
    this.wuzapi = wuzapi;
    this.archive = archive;
  }

  /** Creates the WuzAPI user if missing and makes sure it forwards every event we archive. */
  async ensureUser(): Promise<void> {
    const users = await this.wuzapi.listUsers();
    const settings = {
      events: EVENTS.join(','),
      history: this.config.WUZAPI_HISTORY_PER_CHAT,
      days_to_sync_history: this.config.WUZAPI_SYNC_DAYS,
    };
    const me = users.find((u) => u.token === this.config.WUZAPI_USER_TOKEN);
    if (!me) {
      await this.wuzapi.createUser({ name: this.config.WUZAPI_USER_NAME, ...settings });
      log('created WuzAPI user', this.config.WUZAPI_USER_NAME);
    } else {
      const subscribed = new Set(me.events.split(',').map((e) => e.trim()));
      if (!EVENTS.every((e) => subscribed.has(e) || subscribed.has('All'))) {
        await this.wuzapi.editUser(me.id, { events: [...new Set([...subscribed, ...EVENTS])].filter(Boolean).join(',') });
        log('subscribed WuzAPI user to', EVENTS.join(','));
      }
    }
    this.userReady = true;
  }

  /**
   * Current state. With `connect` (the page asks this way) it also starts a session when none is
   * running, which makes WhatsApp issue a QR — only while someone is looking at it.
   */
  async state({ connect = true }: { connect?: boolean } = {}): Promise<WhatsAppState> {
    try {
      if (!this.userReady) await this.ensureUser();
      let status = await this.wuzapi.status();
      // A linked account (it has a JID) is always reconnected; a QR round only starts on request.
      if (!status.connected && (connect || status.jid)) {
        await this.wuzapi.connect().catch(() => undefined);
        status = await this.wuzapi.status();
      }
      const qr = status.connected && !status.loggedIn ? await this.wuzapi.qr().catch(() => null) : null;
      if (status.loggedIn && status.jid) this.adopt(bareJid(status.jid));
      return {
        reachable: true,
        connected: status.connected,
        loggedIn: status.loggedIn,
        phone: status.loggedIn && status.jid ? status.jid.split(/[:@]/)[0]! : null,
        qr,
      };
    } catch (err) {
      return { reachable: false, connected: false, loggedIn: false, phone: null, qr: null, error: String((err as Error).message) };
    }
  }

  /** Ties the archive to the linked account; imports what WuzAPI already holds when the archive does not have it yet. */
  adopt(jid: string): void {
    if (this.archive.claimAccount(jid)) log('a different account is linked: archive wiped');
    if (this.archive.getMeta('backfilled') !== jid) void this.backfill(jid);
    else if (this.backfillState === 'not started') this.backfillState = 'done';
  }

  /** A new link through the QR: the old archive goes, the phone's history refills it. */
  onPaired(jid: string): void {
    log('new link: wiping the archive');
    this.archive.wipe();
    this.archive.setMeta('account_jid', jid);
    // History arrives by itself through HistorySync events; nothing stored in WuzAPI is older.
    this.archive.setMeta('backfilled', jid);
    this.backfillState = 'receiving history from the phone';
  }

  /** Unlinked from the phone (or by us): delete the archive and every copy WuzAPI kept. */
  async onLoggedOut(): Promise<void> {
    log('unlinked: wiping the archive and WuzAPI’s copy');
    this.archive.wipe();
    this.backfillState = 'not started';
    try {
      const me = (await this.wuzapi.listUsers()).find((u) => u.token === this.config.WUZAPI_USER_TOKEN);
      if (me) await this.wuzapi.deleteUserCompletely(me.id);
    } catch (err) {
      log('could not delete the WuzAPI user:', (err as Error).message);
    }
    this.userReady = false;
  }

  /** Unlink button: log out of WhatsApp, then wipe. */
  async unlink(): Promise<void> {
    await this.wuzapi.logout().catch((err) => log('logout:', (err as Error).message));
    await this.onLoggedOut();
  }

  /** Contact names from the phone's address book, so chats show names instead of numbers. */
  async syncContacts(): Promise<number> {
    const contacts = await this.wuzapi.contacts();
    let n = 0;
    this.archive.db.transaction(() => {
      for (const [jid, c] of Object.entries(contacts)) {
        const name = c.FullName || c.FirstName || c.BusinessName || null;
        if (!name && !c.PushName) continue;
        this.archive.upsertContact(bareJid(jid), { name, pushName: c.PushName || null });
        n++;
      }
    })();
    return n;
  }

  /** Group names, which messages do not carry. */
  async syncGroups(): Promise<number> {
    const groups = await this.wuzapi.groups();
    for (const g of groups) this.archive.upsertChat(bareJid(g.JID), { name: g.Name || null, isGroup: true });
    return groups.length;
  }

  /** Imports every message WuzAPI stored before wuzapi-mcp was listening. */
  async backfill(jid: string): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    let chats = 0;
    let added = 0;
    try {
      this.backfillState = 'importing…';
      await this.syncContacts().catch((err) => log('contacts:', err.message));
      await this.syncGroups().catch((err) => log('groups:', err.message));
      let offset = 0;
      for (;;) {
        const page = await this.wuzapi.conversations(offset);
        for (const c of page.chats ?? []) {
          chats++;
          let before: number | undefined;
          for (;;) {
            const batch = await this.wuzapi.messages(c.chat_jid, before);
            const rows = batch.messages ?? [];
            const messages = rows
              .map((row) => {
                const data = typeof row.data_json === 'string' ? safeJson(row.data_json) : (row.data_json ?? null);
                const ts = Math.floor(Date.parse(row.timestamp) / 1000);
                return data ? fromMessageEvent(data, { id: row.message_id, chatJid: row.chat_jid, timestamp: ts }) : null;
              })
              .filter((m) => m !== null)
              .map((m) => ownSender(m, jid));
            added += this.archive.addMessages(messages);
            if (!batch.has_more || batch.next_before === undefined) break;
            before = batch.next_before;
          }
          this.backfillState = `importing… ${chats} chats, ${added} messages`;
        }
        if (!page.has_more || page.next_offset === undefined) break;
        offset = page.next_offset;
      }
      this.archive.setMeta('backfilled', jid);
      this.backfillState = `done: ${added} messages from ${chats} chats`;
      log('backfill', this.backfillState);
    } catch (err) {
      this.backfillState = `failed: ${(err as Error).message} (retries on next check)`;
      log('backfill failed:', (err as Error).message);
    } finally {
      this.backfilling = false;
    }
  }
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}
