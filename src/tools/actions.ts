import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Archive, ArchivedMessage } from '../archive/archive.ts';
import type { MediaStore } from '../media/store.ts';
import type { Wuzapi } from '../wuzapi/client.ts';
import { fail, phoneOf, text } from './format.ts';
import { toJid } from './read.ts';

const isGroup = (jid: string) => jid.endsWith('@g.us');

/** Things you do to a message or a chat that already exists: delete, edit, pin, star, vote, archive, mute… */
export function registerActionTools(server: McpServer, archive: Archive, wuzapi: Wuzapi, media: MediaStore): void {
  const own = () => archive.accountJid();

  /** The message, from the archive; the error names what is missing. */
  const find = (message_id: string, chat_jid: string | undefined): ArchivedMessage => {
    const m = archive.getMessage(message_id, chat_jid ? toJid(chat_jid) : undefined);
    if (!m) throw new Error(`No message ${message_id}${chat_jid ? ` in ${toJid(chat_jid)}` : ''} in the archive.`);
    return m;
  };

  /** Who wrote it, as WhatsApp wants it in a message key: your own JID for your messages. */
  const authorOf = (m: ArchivedMessage): string => (m.fromMe ? (own() ?? m.senderJid) : m.senderJid);

  const chatName = (jid: string) => archive.displayName(jid) ?? phoneOf(jid);
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const messageRef = {
    message_id: z.string().describe('Id of the message (from the read tools)'),
    chat_jid: z.string().optional().describe('The chat the message is in, if known'),
  };

  server.registerTool(
    'delete_message',
    {
      title: 'Delete message for everyone',
      description:
        'Delete a message for everyone in the chat. Works on your own messages, and on other people’s messages in groups where you are an admin. ' +
        'WhatsApp only allows it for about two days after sending. This cannot be undone: confirm with the user first.',
      inputSchema: messageRef,
      annotations: destructive,
    },
    async ({ message_id, chat_jid }) => {
      const m = find(message_id, chat_jid);
      if (m.deletedAt) return text('That message is already deleted.');
      if (!m.fromMe && !isGroup(m.chatJid)) return fail('Only your own messages can be deleted in a direct chat.');
      await wuzapi.deleteMessage(m.chatJid, m.id, m.fromMe ? undefined : m.senderJid);
      archive.markDeleted(m.chatJid, m.id);
      media.forget(m.chatJid, m.id);
      return text(`Deleted for everyone in ${chatName(m.chatJid)}.`);
    },
  );

  server.registerTool(
    'edit_message',
    {
      title: 'Edit message',
      description: 'Change the text of a message you sent (or the caption of your photo/video). WhatsApp allows it for 15 minutes after sending.',
      inputSchema: { ...messageRef, text: z.string().min(1).describe('The new text') },
      annotations: write,
    },
    async ({ message_id, chat_jid, text: body }) => {
      const m = find(message_id, chat_jid);
      if (!m.fromMe) return fail('Only your own messages can be edited.');
      if (m.deletedAt) return fail('That message was deleted.');
      await wuzapi.editMessage(m.chatJid, m.id, body);
      archive.markEdited(m.chatJid, m.id, body);
      return text(`Edited in ${chatName(m.chatJid)}.`);
    },
  );

  server.registerTool(
    'pin_message',
    {
      title: 'Pin message',
      description: 'Pin a message at the top of its chat for everyone, for 1, 7 or 30 days — or unpin it.',
      inputSchema: {
        ...messageRef,
        pin: z.boolean().default(true).describe('false unpins'),
        days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
      },
      annotations: write,
    },
    async ({ message_id, chat_jid, pin, days }) => {
      const m = find(message_id, chat_jid);
      await wuzapi.pinMessage(m.chatJid, m.id, pin, isGroup(m.chatJid) ? authorOf(m) : undefined, days * 86_400);
      return text(pin ? `Pinned in ${chatName(m.chatJid)} for ${days} day${days > 1 ? 's' : ''}.` : `Unpinned in ${chatName(m.chatJid)}.`);
    },
  );

  server.registerTool(
    'star_message',
    {
      title: 'Star message',
      description: 'Star a message (it appears among your starred messages on every device), or remove the star.',
      inputSchema: { ...messageRef, star: z.boolean().default(true).describe('false removes the star') },
      annotations: write,
    },
    async ({ message_id, chat_jid, star }) => {
      const m = find(message_id, chat_jid);
      await wuzapi.starMessage(m.chatJid, m.id, m.fromMe, star, isGroup(m.chatJid) ? authorOf(m) : undefined);
      return text(star ? 'Starred.' : 'Star removed.');
    },
  );

  server.registerTool(
    'vote_poll',
    {
      title: 'Vote on a poll',
      description: 'Vote on a poll with one or more of its options (by their text). An empty list withdraws your vote.',
      inputSchema: {
        message_id: z.string().describe('Id of the poll message'),
        options: z.array(z.string()).describe('Option texts, exactly as in the poll'),
      },
      annotations: write,
    },
    async ({ message_id, options }) => {
      const poll = archive.getPoll(message_id);
      if (!poll) return fail(`No poll ${message_id} in the archive.`);
      const m = find(message_id, poll.chatJid);
      const unknown = options.filter((o) => !poll.options.includes(o));
      if (unknown.length) return fail(`Not options of this poll: ${unknown.join(', ')}. The options are: ${poll.options.join(' / ')}`);
      await wuzapi.votePoll(m.chatJid, m.id, authorOf(m), m.fromMe, [...new Set(options)]);
      return text(options.length ? `Voted: ${options.join(', ')}.` : 'Vote withdrawn.');
    },
  );

  server.registerTool(
    'manage_chat',
    {
      title: 'Archive, pin, mute or mark a chat',
      description:
        'Organise a chat or group in your chat list, on every device: archive or unarchive it (an archived chat comes back by itself ' +
        'when someone writes, as on the phone), pin or unpin it at the top, mute or unmute its notifications, mark it read (sends read receipts — blue ticks — if you have them on) or unread.',
      inputSchema: {
        chat_jid: z.string().describe('Chat JID, group JID or phone number'),
        action: z.enum(['archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute', 'mark_read', 'mark_unread']),
        mute_for: z.enum(['8h', '1w', 'always']).default('8h').describe('With mute: for how long'),
      },
      annotations: write,
    },
    async ({ chat_jid, action, mute_for }) => {
      const jid = toJid(chat_jid);
      const name = chatName(jid);
      switch (action) {
        case 'archive':
        case 'unarchive':
          await wuzapi.archiveChat(jid, action === 'archive');
          return text(action === 'archive' ? `${name} archived.` : `${name} is back in the chat list.`);
        case 'pin':
        case 'unpin':
          await wuzapi.pinChat(jid, action === 'pin');
          return text(action === 'pin' ? `${name} pinned at the top.` : `${name} unpinned.`);
        case 'mute':
        case 'unmute': {
          const seconds = { '8h': 8 * 3600, '1w': 7 * 86_400, always: 0 }[mute_for];
          await wuzapi.muteChat(jid, action === 'mute', seconds);
          return text(action === 'unmute' ? `${name} unmuted.` : `${name} muted ${mute_for === 'always' ? 'for ever' : `for ${mute_for === '8h' ? '8 hours' : 'a week'}`}.`);
        }
        case 'mark_unread':
          await wuzapi.markChatUnread(jid, true);
          return text(`${name} marked as unread.`);
        case 'mark_read': {
          // Read receipts go per sender: the latest messages from others, grouped by who wrote them.
          const recent = archive.listMessages({ chatJid: jid, limit: 50, offset: 0 }).filter((m) => !m.fromMe && !m.deletedAt);
          const bySender = new Map<string, string[]>();
          for (const m of recent) bySender.set(m.senderJid, [...(bySender.get(m.senderJid) ?? []), m.id]);
          for (const [sender, ids] of bySender) await wuzapi.markRead(jid, ids, isGroup(jid) ? sender : undefined);
          await wuzapi.markChatUnread(jid, false).catch(() => undefined);
          return text(`${name} marked as read.`);
        }
        default:
          return fail(`Unknown action ${action as string}.`);
      }
    },
  );
}
