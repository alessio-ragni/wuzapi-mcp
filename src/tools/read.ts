import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import { UNTRUSTED, chatLabel, fail, formatTime, messageLine, parseTime, phoneOf, text } from './format.ts';

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);
const page = z.number().int().min(0).default(0).describe('Page number, starting at 0');

/** A bare phone number becomes a WhatsApp JID; anything with an @ is kept as is. */
export function toJid(value: string): string {
  if (value.includes('@')) return value.trim();
  const digits = value.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`"${value}" is neither a phone number nor a JID`);
  return `${digits}@s.whatsapp.net`;
}

export function registerReadTools(server: McpServer, archive: Archive): void {
  server.registerTool(
    'search_contacts',
    {
      title: 'Search contacts',
      description: 'Find WhatsApp contacts by name or phone number. Returns their JIDs, needed by the other tools.',
      inputSchema: { query: z.string().min(1).describe('Part of a name or phone number'), limit: limit(100, 20) },
      annotations: readOnly,
    },
    ({ query, limit }) => {
      const contacts = archive.searchContacts(query, limit);
      const chats = archive.listChats({ query, limit, offset: 0 }).filter((c) => !c.isGroup);
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const c of contacts) {
        seen.add(c.jid);
        lines.push(`${c.name ?? c.pushName ?? phoneOf(c.jid)} — ${phoneOf(c.jid)} (${c.jid})`);
      }
      for (const c of chats) if (!seen.has(c.jid)) lines.push(`${c.name ?? phoneOf(c.jid)} — ${phoneOf(c.jid)} (${c.jid})`);
      return text(lines.length ? lines.join('\n') : `No contact matches "${query}".`);
    },
  );

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description: 'List chats, most recently active first, optionally filtered by name, number or JID.',
      inputSchema: {
        query: z.string().optional().describe('Filter by name, number or JID'),
        groups_only: z.boolean().default(false),
        limit: limit(200, 20),
        page,
      },
      annotations: readOnly,
    },
    ({ query, groups_only, limit, page }) => {
      const chats = archive.listChats({ query, groupsOnly: groups_only, limit, offset: page * limit });
      if (!chats.length) return text(query ? `No chat matches "${query}".` : 'The archive has no chats yet.');
      return text(chats.map((c) => `${chatLabel(archive, c)} — last message ${formatTime(c.lastMessageAt)}`).join('\n'));
    },
  );

  server.registerTool(
    'get_chat',
    {
      title: 'Get chat',
      description: `Details of one chat and its latest messages. ${UNTRUSTED}`,
      inputSchema: {
        chat_jid: z.string().describe('Chat JID, or a phone number for a direct chat'),
        last_messages: z.number().int().min(0).max(50).default(10),
      },
      annotations: readOnly,
    },
    ({ chat_jid, last_messages }) => {
      const jid = toJid(chat_jid);
      const chat = archive.getChat(jid);
      if (!chat) return fail(`No chat ${jid} in the archive.`);
      const messages = archive.listMessages({ chatJid: jid, limit: last_messages, offset: 0 }).reverse();
      return text(
        [
          chatLabel(archive, chat),
          `Last message: ${formatTime(chat.lastMessageAt)}`,
          '',
          ...messages.map((m) => messageLine(archive, m)),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description: `Messages, newest first, filtered by chat, sender, date range and/or words. ${UNTRUSTED}`,
      inputSchema: {
        chat_jid: z.string().optional().describe('Only this chat (JID or phone number)'),
        sender: z.string().optional().describe('Only messages from this person (JID or phone number)'),
        after: z.string().optional().describe('From this date, YYYY-MM-DD or YYYY-MM-DD HH:MM'),
        before: z.string().optional().describe('Up to this date, YYYY-MM-DD or YYYY-MM-DD HH:MM'),
        query: z.string().optional().describe('Words the message must contain'),
        limit: limit(200, 30),
        page,
      },
      annotations: readOnly,
    },
    ({ chat_jid, sender, after, before, query, limit, page }) => {
      const messages = archive.listMessages({
        chatJid: chat_jid ? toJid(chat_jid) : undefined,
        senderJid: sender ? toJid(sender) : undefined,
        after: after ? parseTime(after) : undefined,
        before: before ? parseTime(before) : undefined,
        query,
        limit,
        offset: page * limit,
      });
      if (!messages.length) return text('No messages match.');
      return text(messages.map((m) => messageLine(archive, m, { withChat: !chat_jid })).join('\n'));
    },
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description: `Full-text search across every archived message (accents ignored, words match as prefixes). ${UNTRUSTED}`,
      inputSchema: {
        query: z.string().min(1).describe('Words to look for'),
        chat_jid: z.string().optional().describe('Only this chat (JID or phone number)'),
        limit: limit(200, 30),
        page,
      },
      annotations: readOnly,
    },
    ({ query, chat_jid, limit, page }) => {
      const messages = archive.listMessages({
        query,
        chatJid: chat_jid ? toJid(chat_jid) : undefined,
        limit,
        offset: page * limit,
      });
      if (!messages.length) return text(`Nothing found for "${query}".`);
      return text(messages.map((m) => messageLine(archive, m, { withChat: !chat_jid })).join('\n'));
    },
  );

  server.registerTool(
    'get_message_context',
    {
      title: 'Get message context',
      description: `The messages around one message in its chat, in time order. ${UNTRUSTED}`,
      inputSchema: {
        message_id: z.string(),
        chat_jid: z.string().optional().describe('The chat the message is in, if known'),
        before: z.number().int().min(0).max(50).default(5),
        after: z.number().int().min(0).max(50).default(5),
      },
      annotations: readOnly,
    },
    ({ message_id, chat_jid, before, after }) => {
      const messages = archive.messageContext(message_id, chat_jid ? toJid(chat_jid) : undefined, before, after);
      if (!messages) return fail(`No message ${message_id} in the archive.`);
      const chat = archive.getChat(messages[0]!.chatJid);
      return text(
        [
          chat ? chatLabel(archive, chat) : messages[0]!.chatJid,
          '',
          ...messages.map((m) => `${m.id === message_id ? '→ ' : '  '}${messageLine(archive, m)}`),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'get_last_interaction',
    {
      title: 'Get last interaction',
      description: `The most recent message exchanged with a person, in either direction. ${UNTRUSTED}`,
      inputSchema: { contact: z.string().describe('JID or phone number') },
      annotations: readOnly,
    },
    ({ contact }) => {
      const jid = toJid(contact);
      const [last] = archive.listMessages({ chatJid: jid, limit: 1, offset: 0 });
      if (!last) return text(`No messages with ${jid} in the archive.`);
      return text(messageLine(archive, last));
    },
  );
}
