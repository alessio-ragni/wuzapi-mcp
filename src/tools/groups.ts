import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import type { Config } from '../config.ts';
import { bareJid } from '../ingest/normalize.ts';
import type { Wuzapi } from '../wuzapi/client.ts';
import { fail, formatTime, phoneOf, text } from './format.ts';
import { toJid } from './read.ts';
import { readAllowed } from './write.ts';

const groupJid = z.string().describe('Group JID, ending in @g.us');

/** "https://chat.whatsapp.com/AbC123" or "AbC123" → "AbC123". */
export function inviteCode(link: string): string {
  const code = link.trim().replace(/^https?:\/\/(?:chat\.)?whatsapp\.com\/(?:invite\/)?/i, '').replace(/[/?#].*$/, '');
  if (!/^[\w-]{10,}$/.test(code)) throw new Error(`"${link}" is not a WhatsApp group invite link.`);
  return code;
}

/** Group settings and membership beyond create/add/remove: name, description, photo, rules, joining and leaving. */
export function registerGroupTools(server: McpServer, archive: Archive, wuzapi: Wuzapi, config: Config): void {
  const label = (jid: string) => `${archive.displayName(jid) ?? phoneOf(jid)} (${phoneOf(jid)})`;

  server.registerTool(
    'update_group',
    {
      title: 'Update group settings',
      description:
        'Change a group you administer: name, description, photo (a JPEG on this computer) or remove the photo, ' +
        'who may send messages, who may edit the group info, who may add members, disappearing messages, and whether ' +
        'new members need approval. Give only what should change; each change is reported.',
      inputSchema: {
        group_jid: groupJid,
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(2048).optional().describe('"" clears it'),
        photo_path: z.string().optional().describe('Absolute path of a JPEG image on this computer'),
        remove_photo: z.boolean().optional(),
        only_admins_send: z.boolean().optional().describe('true: only admins can send messages'),
        only_admins_edit_info: z.boolean().optional().describe('true: only admins can change name, description and photo'),
        members_can_add: z.boolean().optional().describe('true: every member can add people; false: admins only'),
        disappearing_messages: z.enum(['off', '24h', '7d', '90d']).optional(),
        approve_new_members: z.boolean().optional().describe('true: admins must approve people joining with the link'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const jid = args.group_jid;
      const steps: [string, () => Promise<unknown>][] = [];
      if (args.name !== undefined) steps.push([`name → "${args.name}"`, () => wuzapi.setGroupName(jid, args.name!)]);
      if (args.description !== undefined) steps.push([args.description ? 'description updated' : 'description cleared', () => wuzapi.setGroupTopic(jid, args.description!)]);
      if (args.photo_path !== undefined) {
        steps.push([
          'photo updated',
          async () => {
            const file = await readAllowed(config, args.photo_path!);
            if (file.mimetype !== 'image/jpeg') throw new Error('WhatsApp takes JPEG images only for group photos (.jpg or .jpeg)');
            return wuzapi.setGroupPhoto(jid, `data:image/jpeg;base64,${file.data.toString('base64')}`);
          },
        ]);
      } else if (args.remove_photo) steps.push(['photo removed', () => wuzapi.removeGroupPhoto(jid)]);
      if (args.only_admins_send !== undefined) {
        steps.push([args.only_admins_send ? 'only admins can send messages' : 'everyone can send messages', () => wuzapi.setGroupAnnounce(jid, args.only_admins_send!)]);
      }
      if (args.only_admins_edit_info !== undefined) {
        steps.push([args.only_admins_edit_info ? 'only admins can edit the group info' : 'everyone can edit the group info', () => wuzapi.setGroupLocked(jid, args.only_admins_edit_info!)]);
      }
      if (args.members_can_add !== undefined) {
        steps.push([args.members_can_add ? 'every member can add people' : 'only admins can add people', () => wuzapi.setMemberAddMode(jid, args.members_can_add!)]);
      }
      if (args.disappearing_messages !== undefined) {
        const d = args.disappearing_messages;
        steps.push([d === 'off' ? 'disappearing messages off' : `messages disappear after ${d}`, () => wuzapi.setDisappearing(jid, d)]);
      }
      if (args.approve_new_members !== undefined) {
        steps.push([args.approve_new_members ? 'new members need approval' : 'new members join without approval', () => wuzapi.setJoinApproval(jid, args.approve_new_members!)]);
      }
      if (!steps.length) return fail('Nothing to change: give at least one setting.');
      const lines: string[] = [];
      let failed = 0;
      for (const [what, run] of steps) {
        try {
          await run();
          lines.push(`✓ ${what}`);
        } catch (err) {
          failed++;
          lines.push(`✗ ${what}: ${(err as Error).message}`);
        }
      }
      if (args.name !== undefined && !lines.some((l) => l.startsWith('✗ name'))) archive.upsertChat(jid, { name: args.name, isGroup: true });
      const head = `${archive.displayName(jid) ?? jid}:`;
      const result = text([head, ...lines].join('\n'));
      return failed === steps.length ? { ...result, isError: true } : result;
    },
  );

  server.registerTool(
    'leave_group',
    {
      title: 'Leave group',
      description: 'Leave a group. You stop receiving its messages; the archive keeps what it already has. Confirm with the user first.',
      inputSchema: { group_jid: groupJid },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ group_jid }) => {
      await wuzapi.leaveGroup(group_jid);
      return text(`You left ${archive.displayName(group_jid) ?? group_jid}.`);
    },
  );

  server.registerTool(
    'get_group_invite_info',
    {
      title: 'Preview a group invite link',
      description: 'What a group invite link leads to — name, description, size, owner — without joining.',
      inputSchema: { link: z.string().describe('The invite link (https://chat.whatsapp.com/…) or its code') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ link }) => {
      const g = await wuzapi.inviteInfo(inviteCode(link));
      const size = g.ParticipantCount ?? g.Participants?.length;
      return text(
        [
          `${g.Name} (${g.JID})`,
          g.Topic ? `Description: ${g.Topic}` : '',
          size !== undefined ? `Members: ${size}` : '',
          g.OwnerJID ? `Created by: ${label(bareJid(archive.resolveJid(g.OwnerJID)))}` : '',
          g.GroupCreated && !g.GroupCreated.startsWith('0001') ? `Created: ${formatTime(Math.floor(Date.parse(g.GroupCreated) / 1000))}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'join_group',
    {
      title: 'Join group',
      description: 'Join a group through its invite link. If the group asks for approval, an admin has to let you in.',
      inputSchema: { link: z.string().describe('The invite link (https://chat.whatsapp.com/…) or its code') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ link }) => {
      const code = inviteCode(link);
      const info = await wuzapi.inviteInfo(code).catch(() => null);
      await wuzapi.joinGroup(code);
      if (info?.JID) archive.upsertChat(bareJid(info.JID), { name: info.Name || null, isGroup: true });
      return text(info ? `Joined ${info.Name} (${info.JID}), or asked to join if it needs approval.` : 'Joined the group, or asked to join if it needs approval.');
    },
  );

  server.registerTool(
    'group_join_requests',
    {
      title: 'Group join requests',
      description: 'People waiting to be let into a group you administer (when new members need approval): list them, approve or reject.',
      inputSchema: {
        group_jid: groupJid,
        action: z.enum(['list', 'approve', 'reject']).default('list'),
        people: z.array(z.string()).optional().describe('With approve/reject: phone numbers or JIDs; omitted means everyone waiting'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ group_jid, action, people }) => {
      const waiting = await wuzapi.joinRequests(group_jid);
      if (action === 'list') {
        if (!waiting.length) return text('Nobody is waiting to join.');
        return text(
          waiting
            .map((r) => {
              const jid = archive.resolveJid(bareJid(r.JID));
              const when = r.RequestedAt && !r.RequestedAt.startsWith('0001') ? ` — asked ${formatTime(Math.floor(Date.parse(r.RequestedAt) / 1000))}` : '';
              return `- ${label(jid)}${when}`;
            })
            .join('\n'),
        );
      }
      const targets = people?.length ? people.map((p) => toJid(p)) : waiting.map((r) => bareJid(r.JID));
      if (!targets.length) return text('Nobody is waiting to join.');
      await wuzapi.answerJoinRequests(group_jid, targets, action);
      return text(`${action === 'approve' ? 'Approved' : 'Rejected'}: ${targets.map((t) => label(archive.resolveJid(t))).join(', ')}`);
    },
  );
}
