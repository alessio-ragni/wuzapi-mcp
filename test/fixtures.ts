// Invented data only: these numbers, names and messages do not belong to anyone.

export const ME = '15550000001@s.whatsapp.net';
export const ALICE = '15550000002@s.whatsapp.net';
export const ALICE_LID = '900000000000002@lid';
export const BOB = '15550000003@s.whatsapp.net';
export const GROUP = '120363000000000001@g.us';

export function liveText(opts: { id: string; chat?: string; sender?: string; fromMe?: boolean; text: string; at?: string; pushName?: string }) {
  return {
    Info: {
      Chat: opts.chat ?? ALICE,
      Sender: opts.sender ?? (opts.fromMe ? ME : ALICE),
      IsFromMe: opts.fromMe ?? false,
      IsGroup: (opts.chat ?? ALICE).endsWith('@g.us'),
      ID: opts.id,
      PushName: opts.pushName ?? 'Alice',
      Timestamp: opts.at ?? '2026-01-02T10:00:00Z',
    },
    Message: { conversation: opts.text },
  };
}

export const liveReplyFromLid = {
  Info: {
    Chat: ALICE_LID,
    Sender: ALICE_LID,
    SenderAlt: ALICE,
    IsFromMe: false,
    IsGroup: false,
    ID: 'MSG-REPLY',
    PushName: 'Alice',
    Timestamp: '2026-01-02T10:05:00Z',
  },
  Message: {
    extendedTextMessage: { text: 'Sounds good, see you at the café', contextInfo: { stanzaID: 'MSG-1', participant: ME } },
  },
};

export const liveImage = {
  Info: { Chat: GROUP, Sender: BOB, IsFromMe: false, IsGroup: true, ID: 'MSG-IMG', PushName: 'Bob', Timestamp: '2026-01-02T11:00:00Z' },
  Message: {
    imageMessage: {
      URL: 'https://mmg.example.invalid/x',
      directPath: '/v/x',
      mediaKey: 'a2V5',
      mimetype: 'image/jpeg',
      fileEncSHA256: 'ZW5j',
      fileSHA256: 'c2hh',
      fileLength: 1234,
      caption: 'The view from the hut',
    },
  },
};

export const liveVoice = {
  Info: { Chat: ALICE, Sender: ALICE, IsFromMe: false, IsGroup: false, ID: 'MSG-VOICE', PushName: 'Alice', Timestamp: '2026-01-02T12:00:00Z' },
  Message: { audioMessage: { PTT: true, mimetype: 'audio/ogg; codecs=opus', directPath: '/v/a', mediaKey: 'a2V5' } },
};

export const historySync = {
  syncType: 2,
  conversations: [
    {
      ID: BOB,
      name: 'Bob Example',
      messages: [
        { message: { key: { remoteJID: BOB, fromMe: false, ID: 'H-1' }, message: { conversation: 'Old news from Bob' }, messageTimestamp: 1735689600, pushName: 'Bob' } },
        { message: { key: { remoteJID: BOB, fromMe: true, ID: 'H-2' }, message: { conversation: 'My old answer' }, messageTimestamp: 1735689660 } },
        { message: { key: { remoteJID: BOB, fromMe: false, ID: 'H-3' }, message: { reactionMessage: { text: '👍' } }, messageTimestamp: 1735689700 } },
      ],
    },
  ],
  pushnames: [{ ID: ALICE, pushname: 'Alice' }],
};
