import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Archive, ArchivedMessage } from '../archive/archive.ts';
import type { Config } from '../config.ts';
import type { Wuzapi } from '../wuzapi/client.ts';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/aac': '.aac',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'application/zip': '.zip',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

/** The bare media type: "audio/ogg; codecs=opus" → "audio/ogg". */
export const bareMime = (mimetype: string) => mimetype.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';

/** WhatsApp no longer serves the file: its CDN answers 403, 404 or 410 once media has expired. */
export function isExpired(err: unknown): boolean {
  return /status code (403|404|410)\b|media (?:not found|expired)/i.test((err as Error)?.message ?? '');
}

export class MediaExpiredError extends Error {}

/** A message's file name as people see it: the sender's name for documents, else id + extension. */
export function fileNameFor(m: ArchivedMessage, mimetype: string): string {
  const ext = EXTENSIONS[bareMime(mimetype)] ?? '';
  const raw = m.media?.fileName ? m.media.fileName.split(/[\\/]/).pop()! : `${m.id}${ext}`;
  return raw.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || `${m.id}${ext}`;
}

export interface StoredMedia {
  data: Buffer;
  mimetype: string;
  /** Where it lives inside DATA_DIR/media. */
  file: string;
  /** True when it came from the copy kept at arrival, false when it was just downloaded. */
  cached: boolean;
}

const HISTORY_DAYS = 14;
const QUEUE_LIMIT = 10_000;

/**
 * Media files kept next to the archive. WhatsApp keeps media on its servers for a few weeks only;
 * a copy made on arrival stays downloadable for as long as the archive holds the message.
 */
export class MediaStore {
  readonly dir: string;
  private readonly config: Config;
  private readonly archive: Archive;
  private readonly wuzapi: Wuzapi;
  private readonly queue: { chatJid: string; id: string }[] = [];
  private readonly queued = new Set<string>();
  private readonly inflight = new Map<string, Promise<StoredMedia>>();
  private running = false;
  /** Null when the downloads folder works, or why it does not. */
  downloadsProblem: string | null = null;

  constructor(config: Config, archive: Archive, wuzapi: Wuzapi) {
    this.config = config;
    this.archive = archive;
    this.wuzapi = wuzapi;
    this.dir = join(config.DATA_DIR, 'media');
    archive.onWipe(() => {
      this.queue.length = 0;
      this.queued.clear();
      void rm(this.dir, { recursive: true, force: true }).then(() => mkdir(this.dir, { recursive: true })).catch(() => undefined);
    });
  }

  private static key(chatJid: string, id: string): string {
    return `${chatJid}\u0000${id}`;
  }

  private fileFor(chatJid: string, id: string, mimetype: string): string {
    const hash = createHash('sha256').update(MediaStore.key(chatJid, id)).digest('hex').slice(0, 40);
    return `${hash}${EXTENSIONS[bareMime(mimetype)] ?? '.bin'}`;
  }

  /** The file of a message: the kept copy when there is one, otherwise downloaded now and kept. */
  async get(m: ArchivedMessage): Promise<StoredMedia> {
    const key = MediaStore.key(m.chatJid, m.id);
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.load(m).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async load(m: ArchivedMessage): Promise<StoredMedia> {
    const kept = this.archive.getMediaFile(m.chatJid, m.id);
    if (kept) {
      try {
        return { data: await readFile(join(this.dir, kept.file)), mimetype: kept.mimetype, file: kept.file, cached: true };
      } catch {
        this.archive.deleteMediaFile(m.chatJid, m.id); // the file went missing: fetch it again
      }
    }
    if (m.deletedAt) throw new Error(`Message ${m.id} was deleted by its sender.`);
    if (!m.media) throw new Error(`Message ${m.id} has no media.`);
    const { kind, url, directPath, mediaKey, mimetype, fileEncSHA256, fileSHA256, fileLength } = m.media;
    let file: { mimetype: string; data: Buffer };
    try {
      file = await this.wuzapi.download(kind, {
        Url: url, DirectPath: directPath, MediaKey: mediaKey, Mimetype: mimetype,
        FileEncSHA256: fileEncSHA256, FileSHA256: fileSHA256, FileLength: fileLength,
      });
    } catch (err) {
      if (isExpired(err)) {
        throw new MediaExpiredError(
          `WhatsApp no longer keeps this file: media stays on its servers for a few weeks, and this one arrived before wuzapi-mcp kept a copy. Open it on the phone.`,
        );
      }
      throw err;
    }
    const type = bareMime(file.mimetype || mimetype || '');
    const name = this.fileFor(m.chatJid, m.id, type);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), file.data);
    // The sender may have deleted it while it was downloading.
    if (this.archive.getMessage(m.id, m.chatJid)?.deletedAt) {
      await unlink(join(this.dir, name)).catch(() => undefined);
      throw new Error(`Message ${m.id} was deleted by its sender.`);
    }
    this.archive.putMediaFile({ chatJid: m.chatJid, id: m.id, file: name, mimetype: type, size: file.data.length, savedAt: Math.floor(Date.now() / 1000) });
    return { data: file.data, mimetype: type, file: name, cached: false };
  }

  /** The sender deleted the message: its copy goes too. */
  forget(chatJid: string, id: string): void {
    const file = this.archive.deleteMediaFile(chatJid, id);
    if (file) void unlink(join(this.dir, file)).catch(() => undefined);
  }

  // --- copies made on arrival --------------------------------------------------

  /** Whether a newly stored message's media should be copied now. */
  wants(m: ArchivedMessage, source: 'live' | 'history', now = Date.now()): boolean {
    if (!m.media || m.deletedAt) return false;
    if (!this.config.MEDIA_PREFETCH.includes(m.media.kind)) return false;
    if ((m.media.fileLength ?? 0) > this.config.MEDIA_PREFETCH_MAX_MB * 1024 * 1024) return false;
    // Older history is almost always gone from WhatsApp's servers already.
    if (source === 'history' && m.timestamp * 1000 < now - HISTORY_DAYS * 24 * 3600_000) return false;
    return true;
  }

  /** Queues a copy of a message's media; downloads run one at a time, in the background. */
  enqueue(m: ArchivedMessage, source: 'live' | 'history'): void {
    if (!this.wants(m, source)) return;
    const key = MediaStore.key(m.chatJid, m.id);
    if (this.queued.has(key) || this.queue.length >= QUEUE_LIMIT) return;
    if (this.archive.getMediaFile(m.chatJid, m.id)) return;
    this.queued.add(key);
    // Live messages first: they are what someone is likely to ask about.
    if (source === 'live') this.queue.unshift({ chatJid: m.chatJid, id: m.id });
    else this.queue.push({ chatJid: m.chatJid, id: m.id });
    if (!this.running) void this.drain();
  }

  pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        this.queued.delete(MediaStore.key(item.chatJid, item.id));
        const m = this.archive.getMessage(item.id, item.chatJid);
        if (!m || !m.media || m.deletedAt) continue;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this.get(m);
            break;
          } catch (err) {
            if (err instanceof MediaExpiredError || !(err instanceof Error) || err.name === 'TypeError') break;
            if (attempt === 3) log('media copy failed:', m.id, (err as Error).message);
            else await new Promise((r) => setTimeout(r, attempt * 5_000).unref());
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  // --- download links ----------------------------------------------------------

  private secret(): Buffer {
    let s = this.archive.getMeta('media_link_secret');
    if (!s) {
      s = randomBytes(32).toString('base64url');
      this.archive.setMeta('media_link_secret', s);
    }
    return Buffer.from(s, 'base64url');
  }

  /** A link that downloads a message's file without signing in, until it expires. */
  link(chatJid: string, id: string, now = Date.now()): { url: string; expires: Date } {
    const expires = Math.floor(now / 1000) + Math.round(this.config.MEDIA_LINK_HOURS * 3600);
    const body = `${Buffer.from(chatJid).toString('base64url')}.${Buffer.from(id).toString('base64url')}.${expires}`;
    const sig = createHmac('sha256', this.secret()).update(body).digest('base64url');
    return { url: `${this.config.PUBLIC_URL}/media/${body}.${sig}`, expires: new Date(expires * 1000) };
  }

  /** The message a link points at, or null when it is forged, altered or expired. */
  verify(token: string, now = Date.now()): { chatJid: string; id: string } | null {
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [chat, id, expires, sig] = parts as [string, string, string, string];
    const expected = createHmac('sha256', this.secret()).update(`${chat}.${id}.${expires}`).digest();
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'base64url');
    } catch {
      return null;
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (!/^\d+$/.test(expires) || Number(expires) * 1000 < now) return null;
    return { chatJid: Buffer.from(chat, 'base64url').toString(), id: Buffer.from(id, 'base64url').toString() };
  }

  // --- the downloads folder ------------------------------------------------------

  /** Checks that the downloads folder can be written; remembers why not. */
  async checkDownloads(): Promise<string | null> {
    const dir = this.config.DOWNLOADS_MOUNT;
    if (!dir) return (this.downloadsProblem = null);
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.wuzapi-mcp-write-test-${process.pid}`);
      await writeFile(probe, '');
      await unlink(probe);
      this.downloadsProblem = null;
    } catch (err) {
      const shown = this.config.DOWNLOADS_DIR ?? dir;
      this.downloadsProblem =
        `${shown} cannot be written (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). ` +
        `On Linux run: sudo chown -R 1000:1000 "${shown}" — or recreate the container with the current image, which fixes it by itself.`;
      log('downloads folder:', this.downloadsProblem);
    }
    return this.downloadsProblem;
  }

  /** Size of the kept copies, for the page. */
  stats(): { files: number; bytes: number; pending: number } {
    return { ...this.archive.mediaStats(), pending: this.queue.length };
  }

  /** Makes sure the folder exists at start; removes files the archive no longer knows. */
  async init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    try {
      const known = new Set((this.archive.db.prepare('SELECT file FROM media_files').all() as { file: string }[]).map((r) => r.file));
      for (const f of await readdir(this.dir)) if (!known.has(f)) await unlink(join(this.dir, f)).catch(() => undefined);
    } catch (err) {
      log('media folder:', (err as Error).message);
    }
  }
}
