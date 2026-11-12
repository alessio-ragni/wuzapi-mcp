import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Archive } from '../src/archive/archive.ts';
import { loadConfig } from '../src/config.ts';
import { fromMessageEvent } from '../src/ingest/normalize.ts';
import { MediaExpiredError, MediaStore } from '../src/media/store.ts';
import { WuzapiError, type Wuzapi } from '../src/wuzapi/client.ts';
import { GROUP, liveImage } from './fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'wuzapi-mcp-media-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const env = {
  WUZAPI_ADMIN_TOKEN: 'a'.repeat(20),
  WUZAPI_USER_TOKEN: 'u'.repeat(20),
  WUZAPI_GLOBAL_HMAC_KEY: 'h'.repeat(40),
  DATA_DIR: dir,
};

function setup(download: (kind: string) => Promise<{ mimetype: string; data: Buffer }>, extra: Record<string, string> = {}) {
  const archive = new Archive(':memory:');
  const calls: string[] = [];
  const wuzapi = {
    async download(kind: string) {
      calls.push(kind);
      return download(kind);
    },
  } as unknown as Wuzapi;
  const media = new MediaStore(loadConfig({ ...env, ...extra }), archive, wuzapi);
  const image = fromMessageEvent(liveImage)!;
  archive.addMessage(image);
  return { archive, media, calls, image };
}

const jpeg = async () => ({ mimetype: 'image/jpeg', data: Buffer.from('not really a jpeg') });

test('a file is downloaded once, then served from the kept copy', async () => {
  const { media, calls, image, archive } = setup(jpeg);
  const first = await media.get(image);
  assert.equal(first.cached, false);
  const second = await media.get(image);
  assert.equal(second.cached, true);
  assert.equal(second.data.toString(), 'not really a jpeg');
  assert.deepEqual(calls, ['image']);
  assert.equal(archive.mediaStats().files, 1);

  media.forget(image.chatJid, image.id);
  assert.equal(archive.getMediaFile(image.chatJid, image.id), null);
});

test('expired media becomes a clear error, not a raw 403', async () => {
  const { media, image } = setup(async () => {
    throw new WuzapiError(500, 'WuzAPI POST /chat/downloadimage: failed to download image download failed with status code 403');
  });
  await assert.rejects(media.get(image), (err: unknown) => err instanceof MediaExpiredError && /no longer keeps this file/.test((err as Error).message));
});

test('what gets copied on arrival: kinds, size and age', () => {
  const { media, image } = setup(jpeg);
  const now = Date.parse('2026-01-03T00:00:00Z');
  assert.equal(media.wants(image, 'live', now), true);
  assert.equal(media.wants({ ...image, media: { ...image.media!, kind: 'video' } }, 'live', now), false);
  assert.equal(media.wants({ ...image, media: { ...image.media!, fileLength: 30 * 1024 * 1024 } }, 'live', now), false);
  assert.equal(media.wants(image, 'history', now), true);
  assert.equal(media.wants(image, 'history', now + 30 * 86_400_000), false);
  assert.equal(media.wants({ ...image, deletedAt: 1 }, 'live', now), false);

  const off = setup(jpeg, { MEDIA_PREFETCH: 'off' }).media;
  assert.equal(off.wants(image, 'live', now), false);
  const all = setup(jpeg, { MEDIA_PREFETCH: 'all' }).media;
  assert.equal(all.wants({ ...image, media: { ...image.media!, kind: 'video' } }, 'live', now), true);
  assert.throws(() => loadConfig({ ...env, MEDIA_PREFETCH: 'image,holograms' }), /unknown media kind holograms/);
});

test('arriving media is copied in the background', async () => {
  const { media, image, archive } = setup(jpeg);
  media.enqueue(image, 'live');
  for (let i = 0; i < 50 && !archive.getMediaFile(image.chatJid, image.id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(archive.getMediaFile(image.chatJid, image.id));
});

test('download links: valid until they expire, useless when altered', () => {
  const { media } = setup(jpeg);
  const now = Date.parse('2026-01-02T00:00:00Z');
  const { url } = media.link(GROUP, 'MSG-IMG', now);
  const token = url.split('/media/')[1]!;
  assert.deepEqual(media.verify(token, now), { chatJid: GROUP, id: 'MSG-IMG' });
  assert.equal(media.verify(token, now + 25 * 3600_000), null, 'expired after 24 hours');
  const parts = token.split('.');
  const forged = [Buffer.from('120363000000000002@g.us').toString('base64url'), parts[1], parts[2], parts[3]].join('.');
  assert.equal(media.verify(forged, now), null, 'another chat');
  assert.equal(media.verify(`${parts.slice(0, 2).join('.')}.${Number(parts[2]) + 999999}.${parts[3]}`, now), null, 'longer expiry');
  assert.equal(media.verify('garbage', now), null);
});

test('wiping the archive removes the kept files', async () => {
  const { media, image, archive } = setup(jpeg);
  await media.get(image);
  assert.ok(readdirSync(media.dir).length > 0);
  archive.wipe();
  for (let i = 0; i < 50 && existsSync(media.dir) && readdirSync(media.dir).length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(!existsSync(media.dir) || readdirSync(media.dir).length === 0);
});
