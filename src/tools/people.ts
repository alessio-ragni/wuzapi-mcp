import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import { bareJid } from '../ingest/normalize.ts';
import type { Wuzapi } from '../wuzapi/client.ts';
import { UNTRUSTED, fail, phoneOf, text } from './format.ts';
import { toJid } from './read.ts';

const person = z.string().describe('Phone number with country code (e.g. 393331234567) or a JID');

/** Downloads a profile picture from WhatsApp's CDN; null if it cannot be fetched. */
async function fetchPicture(url: string): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 3_500_000) return null;
    return { data, mimeType: (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim() };
  } catch {
    return null;
  }
}

/** People and profile: who has WhatsApp, who someone is, blocking, your own "about"; and channels. */
export function registerPeopleTools(server: McpServer, archive: Archive, wuzapi: Wuzapi): void {
  const label = (jid: string) => `${archive.displayName(jid) ?? phoneOf(jid)} (${phoneOf(jid)})`;

  server.registerTool(
    'check_whatsapp',
    {
      title: 'Check numbers on WhatsApp',
      description: 'Which phone numbers have a WhatsApp account, and their business name when they are verified businesses.',
      inputSchema: { numbers: z.array(z.string()).min(1).max(50).describe('Phone numbers with country code') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ numbers }) => {
      const phones = [...new Set(numbers.map((n) => phoneOf(toJid(n))))];
      const users = await wuzapi.checkUsers(phones);
      const byQuery = new Map(users.map((u) => [u.Query.replace(/^\+/, ''), u]));
      return text(
        phones
          .map((p) => {
            const u = byQuery.get(p);
            if (!u) return `${p}: no answer`;
            if (!u.IsInWhatsapp) return `${p}: not on WhatsApp`;
            return `${p}: on WhatsApp (${bareJid(u.JID)})${u.VerifiedName ? ` — business: ${u.VerifiedName}` : ''}`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_contact_info',
    {
      title: 'Get contact info',
      description: `Someone's WhatsApp profile: name, "about" text, business name, and profile photo (shown when they let you see it). ${UNTRUSTED}`,
      inputSchema: { contact: person, photo: z.boolean().default(true).describe('Include the profile photo') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact, photo }) => {
      const jid = toJid(contact);
      if (jid.endsWith('@g.us')) return fail('That is a group: use get_group_info.');
      const users = await wuzapi.userInfo([jid]);
      const info = users[jid] ?? Object.values(users)[0];
      const lines = [label(jid)];
      if (info?.Status) lines.push(`About: ${info.Status}`);
      const business = info?.VerifiedName?.Details?.verifiedName;
      if (business) lines.push(`Verified business: ${business}`);
      if (info?.Devices) lines.push(`Devices: ${info.Devices.length}`);
      const content: CallToolResult['content'] = [];
      if (photo) {
        const avatar = await wuzapi.avatar(jid).catch(() => null);
        const picture = avatar ? await fetchPicture(avatar.url) : null;
        if (picture) content.push({ type: 'image', data: picture.data.toString('base64'), mimeType: picture.mimeType });
        else lines.push('No profile photo visible to you.');
      }
      if (!info) lines.push('WhatsApp gave no profile for this number: it may not be on WhatsApp (check_whatsapp tells).');
      return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
    },
  );

  server.registerTool(
    'block_contact',
    {
      title: 'Block or unblock',
      description: 'Block someone (they can no longer message or call you), unblock them, or list who is blocked. Confirm with the user before blocking.',
      inputSchema: {
        action: z.enum(['block', 'unblock', 'list']),
        contact: person.optional().describe('Who to block or unblock'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ action, contact }) => {
      if (action === 'list') {
        const list = await wuzapi.blocklist();
        return text(list.length ? `Blocked (${list.length}):\n${list.map((j) => `- ${label(archive.resolveJid(bareJid(j)))}`).join('\n')}` : 'Nobody is blocked.');
      }
      if (!contact) return fail(`Say who to ${action}.`);
      const jid = toJid(contact);
      if (action === 'block') await wuzapi.block(jid);
      else await wuzapi.unblock(jid);
      return text(`${label(jid)} ${action === 'block' ? 'blocked' : 'unblocked'}.`);
    },
  );

  server.registerTool(
    'set_about',
    {
      title: 'Set your about text',
      description: 'Change the "about" line on your own WhatsApp profile, the one your contacts see.',
      inputSchema: { text: z.string().min(1).max(139) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ text: about }) => {
      await wuzapi.setAbout(about);
      return text(`Your about now reads: ${about}`);
    },
  );

  // --- channels ------------------------------------------------------------------

  server.registerTool(
    'list_channels',
    {
      title: 'List channels',
      description: `The WhatsApp channels you follow, with their JIDs, followers and whether they are muted. ${UNTRUSTED}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const channels = await wuzapi.channels();
      if (!channels.length) return text('You follow no channels.');
      return text(
        channels
          .map((c) => {
            const t = c.thread_metadata ?? {};
            const followers = t.subscribers_count !== undefined ? ` — ${Number(t.subscribers_count).toLocaleString('en')} followers` : '';
            const muted = c.viewer_metadata?.mute === 'on' ? ' [muted]' : '';
            const role = c.viewer_metadata?.role && c.viewer_metadata.role !== 'subscriber' ? ` [${c.viewer_metadata.role}]` : '';
            const link = t.invite ? `\n  https://whatsapp.com/channel/${t.invite}` : '';
            return `${t.name?.text ?? '(no name)'} (${c.id})${followers}${muted}${role}${link}`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'manage_channel',
    {
      title: 'Follow, unfollow or mute a channel',
      description: 'Follow or unfollow a WhatsApp channel, or mute and unmute its updates. Channels are named by their JID (ending in @newsletter, from list_channels).',
      inputSchema: {
        channel_jid: z.string().regex(/@newsletter$/, 'a channel JID ends in @newsletter'),
        action: z.enum(['follow', 'unfollow', 'mute', 'unmute']),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ channel_jid, action }) => {
      if (action === 'follow') await wuzapi.followChannel(channel_jid);
      else if (action === 'unfollow') await wuzapi.unfollowChannel(channel_jid);
      else await wuzapi.muteChannel(channel_jid, action === 'mute');
      return text({ follow: 'Following', unfollow: 'No longer following', mute: 'Muted', unmute: 'Unmuted' }[action] + ` ${channel_jid}.`);
    },
  );
}
