import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import type { Config } from '../config.ts';
import { containerToHost, hostToContainer } from '../paths.ts';
import { MediaExpiredError, fileNameFor, type MediaStore } from '../media/store.ts';
import { transcribe } from '../transcribe.ts';
import type { GroupParticipant, ReplyTo, Wuzapi } from '../wuzapi/client.ts';
import { UNTRUSTED, fail, formatTime, phoneOf, text } from './format.ts';
import { toJid } from './read.ts';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads a file Claude wants to send, refusing anything outside FILES_ROOT. `path` is a host path
 * (what the user would type); it is mapped to the container mount before being opened.
 */
export async function readAllowed(config: Config, path: string): Promise<{ data: Buffer; name: string; mimetype: string }> {
  if (!config.FILES_ROOT || !config.FILES_MOUNT) throw new Error('Sending files is off: FILES_ROOT is not set.');
  const outside = new Error(`${path} is outside ${config.FILES_ROOT}, the folder files can be sent from.`);
  const inside = hostToContainer(path, config.FILES_ROOT, config.FILES_MOUNT);
  if (!inside) throw outside;
  const root = await realpath(config.FILES_MOUNT);
  const real = await realpath(inside).catch(() => {
    throw new Error(`No file at ${path}. Give the full path on the computer running wuzapi-mcp.`);
  });
  if (real !== root && !real.startsWith(root + sep)) throw outside;
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > MAX_BYTES) throw new Error(`${path} is larger than 64 MB.`);
  return { data: await readFile(real), name: basename(real), mimetype: mimeOf(real) };
}

const dataUrl = (mimetype: string, data: Buffer) => `data:${mimetype};base64,${data.toString('base64')}`;

/** A vCard 3.0 for one person; waid makes WhatsApp offer "Message" on the card. */
export function vcard(name: string, digits: string): string {
  const safe = name.replace(/[\r\n]+/g, ' ').replace(/([,;\\])/g, '\\$1');
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${safe}`, `N:${safe};;;;`, `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`, 'END:VCARD'].join('\n');
}

const INLINE_IMAGE_BYTES = 3_500_000;
const INLINE_TEXT_BYTES = 100_000;
const INLINE_FILE_BYTES = 5 * 1024 * 1024;

export function registerWriteTools(server: McpServer, archive: Archive, wuzapi: Wuzapi, config: Config, media: MediaStore): void {
  /** What WuzAPI needs to quote a message: its id and who wrote it. */
  const replyTo = (messageId: string | undefined, chatJid: string): ReplyTo | undefined => {
    if (!messageId) return undefined;
    const quoted = archive.getMessage(messageId, chatJid);
    if (!quoted) throw new Error(`No message ${messageId} in ${chatJid} to reply to.`);
    const participant = quoted.fromMe ? (archive.accountJid() ?? quoted.senderJid) : quoted.senderJid;
    return { messageId, participant, quotedText: quoted.text ?? '' };
  };

  const sent = (to: string, id: string) => text(`Sent to ${archive.displayName(to) ?? phoneOf(to)} (${to}). Message id: ${id}`);
  const recipient = z.string().describe('Phone number with country code (e.g. 393331234567) or a chat/group JID');
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Send a WhatsApp text message to a person or a group, optionally as a reply quoting an earlier message. ' +
        'In a group you can tag people (mentions) or everyone (mention_all); *bold*, _italic_ and ~strikethrough~ work as on the phone.',
      inputSchema: {
        to: recipient,
        text: z.string().min(1),
        reply_to: z.string().optional().describe('Id of the message to quote (from the read tools)'),
        mentions: z
          .array(z.string())
          .default([])
          .describe('People to tag, by phone number or JID. Their @number is added to the text where it is missing.'),
        mention_all: z.boolean().default(false).describe('Tag every member of the group (groups only)'),
      },
      annotations: write,
    },
    async ({ to, text: body, reply_to, mentions, mention_all }) => {
      const jid = toJid(to);
      if (mention_all && !jid.endsWith('@g.us')) return fail('mention_all works in groups only.');
      const tagged = [...new Set(mentions.map((p) => toJid(p)))];
      // WhatsApp shows a tag only where the text has @number.
      const missing = tagged.map(phoneOf).filter((p) => !body.includes(`@${p}`));
      const finalBody = missing.length ? `${body} ${missing.map((p) => `@${p}`).join(' ')}` : body;
      const r = await wuzapi.sendText(jid, finalBody, replyTo(reply_to, jid), tagged, mention_all);
      return sent(jid, r.Id);
    },
  );

  server.registerTool(
    'send_location',
    {
      title: 'Send location',
      description: 'Send a map location (a pin) to a person or a group.',
      inputSchema: {
        to: recipient,
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().optional().describe('Name of the place, shown under the pin'),
        reply_to: z.string().optional().describe('Id of the message to quote'),
      },
      annotations: write,
    },
    async ({ to, latitude, longitude, name, reply_to }) => {
      const jid = toJid(to);
      const r = await wuzapi.sendLocation(jid, latitude, longitude, name, replyTo(reply_to, jid));
      return sent(jid, r.Id);
    },
  );

  server.registerTool(
    'send_contact',
    {
      title: 'Send contact card',
      description: 'Share a contact card (name and phone number) that the recipient can save or message with one tap.',
      inputSchema: {
        to: recipient,
        name: z.string().min(1).describe('Name on the card'),
        phone: z.string().min(5).describe('The phone number on the card, with country code'),
        reply_to: z.string().optional().describe('Id of the message to quote'),
      },
      annotations: write,
    },
    async ({ to, name, phone, reply_to }) => {
      const jid = toJid(to);
      const digits = phone.replace(/[^\d]/g, '');
      if (!digits) return fail(`"${phone}" is not a phone number.`);
      const r = await wuzapi.sendContact(jid, name, vcard(name, digits), replyTo(reply_to, jid));
      return sent(jid, r.Id);
    },
  );

  server.registerTool(
    'send_sticker',
    {
      title: 'Send sticker',
      description: 'Send an image from this machine (PNG, JPEG, WebP or GIF) as a WhatsApp sticker; it is converted to a 512×512 sticker.',
      inputSchema: {
        to: recipient,
        path: z.string().describe('Absolute path of the image on this computer'),
        reply_to: z.string().optional().describe('Id of the message to quote'),
      },
      annotations: write,
    },
    async ({ to, path, reply_to }) => {
      const jid = toJid(to);
      const file = await readAllowed(config, path);
      if (!file.mimetype.startsWith('image/')) return fail(`${path} is not an image.`);
      const r = await wuzapi.sendSticker(jid, dataUrl(file.mimetype, file.data), file.mimetype, replyTo(reply_to, jid));
      return sent(jid, r.Id);
    },
  );

  server.registerTool(
    'send_file',
    {
      title: 'Send file',
      description:
        'Send a file — image, video, audio or document — from this machine. Images and videos are shown inline; anything else arrives as a document.',
      inputSchema: {
        to: recipient,
        path: z.string().describe('Absolute path of the file on this computer, e.g. /Users/me/Desktop/photo.jpg or C:\\Users\\me\\Desktop\\photo.jpg'),
        caption: z.string().optional(),
        reply_to: z.string().optional().describe('Id of the message to quote'),
        as_document: z.boolean().default(false).describe('Send images and videos as files, uncompressed'),
      },
      annotations: write,
    },
    async ({ to, path, caption, reply_to, as_document }) => {
      const jid = toJid(to);
      const file = await readAllowed(config, path);
      const reply = replyTo(reply_to, jid);
      const url = dataUrl(file.mimetype, file.data);
      const kind = as_document ? 'document' : file.mimetype.split('/')[0];
      const r =
        kind === 'image' && file.mimetype !== 'image/gif'
          ? await wuzapi.sendImage(jid, url, caption, reply)
          : kind === 'video'
            ? await wuzapi.sendVideo(jid, url, caption, reply)
            : await wuzapi.sendDocument(jid, url, file.name, caption, reply);
      return sent(jid, r.Id);
    },
  );

  server.registerTool(
    'send_voice',
    {
      title: 'Send voice note',
      description: 'Send an audio file from this machine as a WhatsApp voice note (any format; it is converted).',
      inputSchema: { to: recipient, path: z.string().describe('Absolute path of the audio file on this computer') },
      annotations: write,
    },
    async ({ to, path }) => {
      const jid = toJid(to);
      const file = await readAllowed(config, path);
      const r = await wuzapi.sendVoice(jid, file.data, file.name, file.mimetype);
      return sent(jid, r.Id);
    },
  );

  server.registerTool(
    'react',
    {
      title: 'React to a message',
      description: 'Add an emoji reaction to a message, or remove yours with an empty emoji.',
      inputSchema: {
        message_id: z.string(),
        chat_jid: z.string().describe('The chat the message is in'),
        emoji: z.string().describe('One emoji, or "" to remove the reaction'),
      },
      annotations: write,
    },
    async ({ message_id, chat_jid, emoji }) => {
      const jid = toJid(chat_jid);
      const target = archive.getMessage(message_id, jid);
      if (!target) return fail(`No message ${message_id} in ${jid}.`);
      await wuzapi.react(jid, message_id, emoji, target.fromMe, jid.endsWith('@g.us') && !target.fromMe ? target.senderJid : undefined);
      return text(emoji ? `Reacted ${emoji}.` : 'Reaction removed.');
    },
  );

  server.registerTool(
    'create_poll',
    {
      title: 'Create poll',
      description: 'Send a poll to a person or a group.',
      inputSchema: {
        to: recipient,
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(2).max(12),
      },
      annotations: write,
    },
    async ({ to, question, options }) => {
      const jid = toJid(to);
      const r = await wuzapi.sendPoll(jid, question, options);
      return sent(jid, r.Id);
    },
  );

  /** Group member lists pair each privacy LID with its number: worth remembering for everyone else. */
  const learnLids = (members: GroupParticipant[]) => {
    for (const p of members) {
      const lid = p.LID || (p.JID.endsWith('@lid') ? p.JID : '');
      if (lid && p.PhoneNumber && archive.resolveJid(lid) !== p.PhoneNumber) archive.recordLid(p.PhoneNumber, lid);
    }
  };

  /** A member's phone-number JID when WhatsApp gives one, filed the way the archive files people. */
  const memberJid = (p: GroupParticipant) => archive.resolveJid(p.PhoneNumber || p.JID);
  const memberName = (p: GroupParticipant) =>
    p.DisplayName || archive.displayName(memberJid(p)) || archive.displayName(p.JID) || phoneOf(memberJid(p));
  const personLabel = (jid: string) => `${archive.displayName(jid) ?? phoneOf(jid)} (${phoneOf(jid)})`;

  server.registerTool(
    'list_groups',
    {
      title: 'List groups',
      description: 'The groups you are in, live from WhatsApp, with their JIDs and member counts.',
      inputSchema: { query: z.string().optional().describe('Filter by name') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      const groups = (await wuzapi.groups()).filter((g) => !query || g.Name.toLowerCase().includes(query.toLowerCase()));
      if (!groups.length) return text(query ? `No group matches "${query}".` : 'You are in no groups.');
      return text(groups.map((g) => `${g.Name} (${g.JID}) — ${g.ParticipantCount ?? g.Participants?.length ?? '?'} members`).join('\n'));
    },
  );

  server.registerTool(
    'get_group_info',
    {
      title: 'Get group info',
      description: 'A group’s name, description and members, live from WhatsApp.',
      inputSchema: { group_jid: z.string().describe('Group JID, ending in @g.us') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ group_jid }) => {
      const g = await wuzapi.groupInfo(group_jid);
      learnLids(g.Participants ?? []);
      const members = (g.Participants ?? []).map((p) => {
        const jid = memberJid(p);
        const role = p.IsSuperAdmin ? ' (owner)' : p.IsAdmin ? ' (admin)' : '';
        return `- ${memberName(p)} ${phoneOf(jid)}${role}`;
      });
      const adding = g.MemberAddMode ? `Who can add members: ${g.MemberAddMode === 'all_member_add' ? 'everyone' : 'admins only'}` : '';
      return text(
        [`${g.Name} (${g.JID})`, g.Topic ? `Description: ${g.Topic}` : '', adding, `Members (${members.length}):`, ...members].filter(Boolean).join('\n'),
      );
    },
  );

  server.registerTool(
    'create_group',
    {
      title: 'Create group',
      description:
        'Create a WhatsApp group with you as owner, optionally making some members admins. ' +
        'People whose privacy settings block being added are reported: send them the invite link (get_group_invite_link).',
      inputSchema: {
        name: z.string().min(1).max(100),
        participants: z.array(z.string()).min(1).describe('Phone numbers with country code, or JIDs'),
        admins: z.array(z.string()).default([]).describe('Participants to make admins'),
        members_can_add: z.boolean().default(true).describe('Let every member add people, not only admins'),
      },
      annotations: write,
    },
    async ({ name, participants, admins, members_can_add }) => {
      const wanted = [...new Set(participants.map((p) => phoneOf(toJid(p))))];
      const g = await wuzapi.createGroup(name, wanted, members_can_add);
      archive.upsertChat(g.JID, { name: g.Name || name, isGroup: true });
      const own = archive.accountJid();
      const byPhone = new Map((g.Participants ?? []).map((p) => [phoneOf(memberJid(p)), p]));
      const added: string[] = [];
      const blocked: string[] = [];
      const failed: string[] = [];
      for (const phone of wanted) {
        const p = byPhone.get(phone);
        const label = personLabel(`${phone}@s.whatsapp.net`);
        if (p && !p.Error) added.push(phone);
        else if (p?.Error === 403) blocked.push(label);
        else failed.push(`${label}${p?.Error ? ` — error ${p.Error}` : ' — not in the group'}`);
      }
      const promote = [...new Set(admins.map((a) => phoneOf(toJid(a))))].filter((a) => added.includes(a) && `${a}@s.whatsapp.net` !== own);
      const notPromoted = admins.map((a) => phoneOf(toJid(a))).filter((a) => !promote.includes(a));
      if (promote.length) await wuzapi.updateParticipants(g.JID, promote, 'promote');
      return text(
        [
          `Created "${g.Name || name}" (${g.JID}). ${members_can_add ? 'Every member can add people.' : 'Only admins can add people.'}`,
          `Added (${added.length}): ${added.map((a) => personLabel(`${a}@s.whatsapp.net`)).join(', ') || 'nobody'}`,
          promote.length ? `Admins: ${promote.map((a) => personLabel(`${a}@s.whatsapp.net`)).join(', ')}` : '',
          notPromoted.length ? `Not made admin, because they are not in the group: ${notPromoted.join(', ')}` : '',
          blocked.length ? `Their privacy settings need an invite instead (${blocked.length}): ${blocked.join(', ')}` : '',
          failed.length ? `Could not add: ${failed.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'update_group_participants',
    {
      title: 'Update group members',
      description: 'Add or remove people in a group you administer, or make them admins (promote) or not (demote).',
      inputSchema: {
        group_jid: z.string().describe('Group JID, ending in @g.us'),
        action: z.enum(['add', 'remove', 'promote', 'demote']),
        people: z.array(z.string()).min(1).describe('Phone numbers with country code, or JIDs'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ group_jid, action, people }) => {
      const phones = [...new Set(people.map((p) => phoneOf(toJid(p))))];
      await wuzapi.updateParticipants(group_jid, phones, action);
      // WuzAPI does not say who was refused, so read the group back.
      const g = await wuzapi.groupInfo(group_jid);
      const now = new Map((g.Participants ?? []).map((p) => [phoneOf(memberJid(p)), p]));
      const lines = phones.map((phone) => {
        const p = now.get(phone);
        const state = !p ? 'not in the group' : p.IsSuperAdmin ? 'owner' : p.IsAdmin ? 'admin' : 'member';
        return `- ${personLabel(`${phone}@s.whatsapp.net`)}: ${state}`;
      });
      const hint = action === 'add' && phones.some((ph) => !now.has(ph)) ? '\nWhoever is not in the group probably needs the invite link (get_group_invite_link).' : '';
      return text(`${g.Name} after ${action}:\n${lines.join('\n')}${hint}`);
    },
  );

  server.registerTool(
    'get_group_invite_link',
    {
      title: 'Get group invite link',
      description: 'The invite link of a group you administer. Send it with send_message to people who could not be added.',
      inputSchema: {
        group_jid: z.string().describe('Group JID, ending in @g.us'),
        reset: z.boolean().default(false).describe('Revoke the current link and make a new one'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ group_jid, reset }) => text(await wuzapi.inviteLink(group_jid, reset)),
  );

  server.registerTool(
    'get_poll_results',
    {
      title: 'Get poll results',
      description:
        'Who voted what on a poll, with names and numbers, and — in a group — who has not voted yet. ' +
        'Give the poll message id, or a chat to use its latest poll. Votes are kept from the moment they arrive; ' +
        'with refresh, older votes are asked from the phone first.',
      inputSchema: {
        message_id: z.string().optional().describe('Id of the poll message'),
        chat_jid: z.string().optional().describe('Chat or group whose latest poll to read'),
        refresh: z.boolean().default(true).describe('Ask the phone for the votes first (takes up to ~20 seconds)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ message_id, chat_jid, refresh }) => {
      const poll = message_id ? archive.getPoll(message_id) : chat_jid ? archive.latestPoll(toJid(chat_jid)) : null;
      if (!poll) return fail(message_id ? `No poll ${message_id} in the archive.` : 'Give message_id or chat_jid; no poll found.');

      let refreshNote = '';
      if (refresh) {
        const before = archive.voteCount(poll.id);
        const [newest] = archive.listMessages({ chatJid: poll.chatJid, limit: 1, offset: 0 });
        try {
          if (!newest) throw new Error('the chat has no messages to start from');
          // The phone sends messages older than the anchor, and only for an anchor it knows.
          if (newest.id === poll.id) throw new Error('the poll is still the latest message in its chat, so the phone cannot send it back yet');
          await wuzapi.requestHistory(poll.chatJid, { id: newest.id, fromMe: newest.fromMe, timestampMs: newest.timestamp * 1000 });
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && archive.voteCount(poll.id) === before) await new Promise((r) => setTimeout(r, 1_000));
          if (archive.voteCount(poll.id) === before) refreshNote = 'The phone sent no new votes.';
        } catch (err) {
          refreshNote = `Could not ask the phone for votes: ${(err as Error).message}`;
        }
      }

      if (poll.chatJid.endsWith('@g.us')) {
        // Voters outside your address book arrive as privacy LIDs; the member list names their numbers.
        try {
          learnLids((await wuzapi.groupInfo(poll.chatJid)).Participants ?? []);
        } catch {
          // Without the member list, those voters keep their LID.
        }
      }
      const r = archive.pollResults(poll.id)!;
      const voted = new Set<string>();
      const lines = [`Poll: ${poll.question} — in ${archive.displayName(poll.chatJid) ?? poll.chatJid} {id: ${poll.id}}`];
      for (const o of r.options) {
        o.voters.forEach((v) => voted.add(v));
        lines.push(`${o.option} — ${o.voters.length}${o.voters.length ? `: ${o.voters.map(personLabel).join(', ')}` : ''}`);
      }
      if (r.unmatched.length) {
        r.unmatched.forEach((v) => voted.add(v));
        lines.push(`Voted for an option no longer known — ${r.unmatched.length}: ${r.unmatched.map(personLabel).join(', ')}`);
      }
      if (r.since && poll.chatJid.endsWith('@g.us')) {
        try {
          const own = archive.accountJid();
          const g = await wuzapi.groupInfo(poll.chatJid);
          const missing = (g.Participants ?? []).filter((p) => !voted.has(memberJid(p)) && memberJid(p) !== own);
          lines.push(`Not voted — ${missing.length}: ${missing.map((p) => `${memberName(p)} (${phoneOf(memberJid(p))})`).join(', ') || 'nobody'}`);
        } catch {
          // The group is optional context; the votes stand on their own.
        }
      }
      lines.push(r.since ? `Votes on file since ${formatTime(r.since)}.` : 'No votes on file for this poll.');
      if (refreshNote) lines.push(refreshNote);
      if (!r.since) lines.push('Votes cast before wuzapi-mcp kept them can be seen on the phone: open the poll → View votes.');
      return text(lines.join('\n'));
    },
  );

  // --- media -------------------------------------------------------------------

  const messageWithMedia = (message_id: string, chat_jid: string | undefined) => {
    const m = archive.getMessage(message_id, chat_jid ? toJid(chat_jid) : undefined);
    if (!m) throw new Error(`No message ${message_id} in the archive.`);
    if (m.deletedAt) throw new Error(`Message ${message_id} was deleted by its sender.`);
    if (!m.media && !archive.getMediaFile(m.chatJid, m.id)) throw new Error(`Message ${message_id} has no media.`);
    return m;
  };

  server.registerTool(
    'download_media',
    {
      title: 'Download media',
      description:
        'Get a message’s photo, video, audio, document or sticker. Photos come back inside the answer so you can see them, ' +
        'short text files too; every file also gets a download link the user can open in a browser (it expires), ' +
        'and a copy in the downloads folder when one is configured. Files are kept from the moment they arrive.',
      inputSchema: {
        message_id: z.string(),
        chat_jid: z.string().optional(),
        include_file: z
          .enum(['auto', 'always', 'never'])
          .default('auto')
          .describe('auto: photos and short text files inside the answer; always: any file up to 5 MB (e.g. a PDF); never: link and path only'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ message_id, chat_jid, include_file }) => {
      const m = messageWithMedia(message_id, chat_jid);
      let file;
      try {
        file = await media.get(m);
      } catch (err) {
        if (err instanceof MediaExpiredError) return fail(err.message);
        throw err;
      }
      const name = fileNameFor(m, file.mimetype);
      const kb = Math.max(1, Math.round(file.data.length / 1024));
      const lines = [`${m.type} from ${archive.displayName(m.senderJid) ?? phoneOf(m.senderJid)}: ${name} (${file.mimetype}, ${kb} KB)`];

      const link = media.link(m.chatJid, m.id);
      lines.push(`Download link (works until ${formatTime(Math.floor(link.expires.getTime() / 1000))}): ${link.url}`);

      // A copy for programs on the machine wuzapi-mcp runs on (Claude Code, a file manager).
      if (config.DOWNLOADS_MOUNT) {
        try {
          await mkdir(config.DOWNLOADS_MOUNT, { recursive: true });
          const path = join(config.DOWNLOADS_MOUNT, `${message_id}-${name}`.replace(/[^\w.\-]+/g, '_'));
          await writeFile(path, file.data);
          const shown = config.DOWNLOADS_DIR && config.DOWNLOADS_MOUNT !== config.DOWNLOADS_DIR ? containerToHost(path, config.DOWNLOADS_MOUNT, config.DOWNLOADS_DIR) : path;
          lines.push(`Saved on ${config.hosted ? 'the server' : 'this computer'}: ${shown}`);
        } catch (err) {
          lines.push(`Not saved to the downloads folder: ${(await media.checkDownloads()) ?? (err as Error).message}`);
        }
      }

      const content: CallToolResult['content'] = [];
      const isText = /^text\/|^application\/(json|xml|csv)/.test(file.mimetype);
      const isImage = file.mimetype.startsWith('image/') && file.mimetype !== 'image/gif';
      if (include_file !== 'never') {
        if (isImage && file.data.length <= INLINE_IMAGE_BYTES) {
          content.push({ type: 'image', data: file.data.toString('base64'), mimeType: file.mimetype });
        } else if (isText && file.data.length <= INLINE_TEXT_BYTES) {
          content.push({ type: 'resource', resource: { uri: link.url, mimeType: file.mimetype, text: file.data.toString('utf8') } });
          lines.push(UNTRUSTED);
        } else if (include_file === 'always' && file.data.length <= INLINE_FILE_BYTES) {
          content.push({ type: 'resource', resource: { uri: link.url, mimeType: file.mimetype, blob: file.data.toString('base64') } });
        } else if (m.type === 'voice' || m.type === 'audio') {
          lines.push('To read what it says, use transcribe_voice.');
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
    },
  );

  server.registerTool(
    'transcribe_voice',
    {
      title: 'Transcribe voice note',
      description: `Turn a voice note or audio message into text. ${UNTRUSTED}`,
      inputSchema: { message_id: z.string(), chat_jid: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ message_id, chat_jid }) => {
      if (config.TRANSCRIPTION_PROVIDER === 'off') {
        return fail('Voice transcription is off. Set TRANSCRIPTION_PROVIDER and its key in .env, then restart wuzapi-mcp.');
      }
      const message = messageWithMedia(message_id, chat_jid);
      if (message.type !== 'voice' && message.type !== 'audio') return fail(`Message ${message_id} is a ${message.type}, not audio.`);
      try {
        const { data, mimetype } = await media.get(message);
        return text(await transcribe(config, { data, mimetype }));
      } catch (err) {
        if (err instanceof MediaExpiredError) return fail(err.message);
        throw err;
      }
    },
  );
}
