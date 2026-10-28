import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import type { Config } from '../config.ts';
import { transcribe } from '../transcribe.ts';
import type { ReplyTo, Wuzapi } from '../wuzapi/client.ts';
import { UNTRUSTED, fail, phoneOf, text } from './format.ts';
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
const EXT: Record<string, string> = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));

const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
const MAX_BYTES = 64 * 1024 * 1024;

/** Reads a file Claude wants to send, refusing anything outside FILES_ROOT. */
async function readAllowed(config: Config, path: string): Promise<{ data: Buffer; name: string; mimetype: string }> {
  if (!config.FILES_ROOT) throw new Error('Sending files is off: FILES_ROOT is not set.');
  const root = await realpath(config.FILES_ROOT);
  const real = await realpath(resolve(path)).catch(() => {
    throw new Error(`No file at ${path}. Give the full path on the machine running wuzapi-mcp.`);
  });
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} is outside ${config.FILES_ROOT}, the folder files can be sent from.`);
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > MAX_BYTES) throw new Error(`${path} is larger than 64 MB.`);
  return { data: await readFile(real), name: basename(real), mimetype: mimeOf(real) };
}

const dataUrl = (mimetype: string, data: Buffer) => `data:${mimetype};base64,${data.toString('base64')}`;

export function registerWriteTools(server: McpServer, archive: Archive, wuzapi: Wuzapi, config: Config): void {
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
      description: 'Send a WhatsApp text message to a person or a group, optionally as a reply quoting an earlier message.',
      inputSchema: {
        to: recipient,
        text: z.string().min(1),
        reply_to: z.string().optional().describe('Id of the message to quote (from the read tools)'),
      },
      annotations: write,
    },
    async ({ to, text: body, reply_to }) => {
      const jid = toJid(to);
      const r = await wuzapi.sendText(jid, body, replyTo(reply_to, jid));
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
        path: z.string().describe('Absolute path of the file, e.g. /Users/me/Desktop/photo.jpg'),
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
      inputSchema: { to: recipient, path: z.string().describe('Absolute path of the audio file') },
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
      const members = (g.Participants ?? []).map((p) => {
        const jid = p.PhoneNumber || p.JID;
        const role = p.IsSuperAdmin ? ' (owner)' : p.IsAdmin ? ' (admin)' : '';
        return `- ${p.DisplayName || archive.displayName(jid) || phoneOf(jid)} ${phoneOf(jid)}${role}`;
      });
      return text([`${g.Name} (${g.JID})`, g.Topic ? `Description: ${g.Topic}` : '', `Members (${members.length}):`, ...members].filter(Boolean).join('\n'));
    },
  );

  // --- media -------------------------------------------------------------------

  const fetchMedia = async (message_id: string, chat_jid: string | undefined) => {
    const m = archive.getMessage(message_id, chat_jid ? toJid(chat_jid) : undefined);
    if (!m) throw new Error(`No message ${message_id} in the archive.`);
    if (!m.media) throw new Error(`Message ${message_id} has no media.`);
    const { kind, url, directPath, mediaKey, mimetype, fileEncSHA256, fileSHA256, fileLength } = m.media;
    const file = await wuzapi.download(kind, {
      Url: url, DirectPath: directPath, MediaKey: mediaKey, Mimetype: mimetype,
      FileEncSHA256: fileEncSHA256, FileSHA256: fileSHA256, FileLength: fileLength,
    });
    return { message: m, ...file };
  };

  server.registerTool(
    'download_media',
    {
      title: 'Download media',
      description: 'Save a message’s photo, video, audio, document or sticker to this machine and return the file path.',
      inputSchema: { message_id: z.string(), chat_jid: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ message_id, chat_jid }) => {
      const dir = config.DOWNLOADS_DIR ?? join(config.DATA_DIR, 'downloads');
      const { message, mimetype, data } = await fetchMedia(message_id, chat_jid);
      const mime = mimetype.split(';')[0]!.trim();
      const name = message.media?.fileName
        ? `${message_id}-${basename(message.media.fileName)}`
        : `${message_id}${EXT[mime] ?? (mime.startsWith('audio/ogg') ? '.ogg' : '')}`;
      await mkdir(dir, { recursive: true });
      const path = join(dir, name.replace(/[^\w.\-]+/g, '_'));
      await writeFile(path, data);
      return text(`Saved ${message.type} (${mime}, ${Math.round(data.length / 1024)} KB) to ${path}`);
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
      const { message, mimetype, data } = await fetchMedia(message_id, chat_jid);
      if (message.type !== 'voice' && message.type !== 'audio') return fail(`Message ${message_id} is a ${message.type}, not audio.`);
      return text(await transcribe(config, { data, mimetype }));
    },
  );
}
