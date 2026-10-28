# wuzapi-mcp

An MCP server for WhatsApp, built on top of [WuzAPI](https://github.com/asternic/wuzapi).

> **Status: early development.** It runs on your own machine and Claude Code can use it. Running it on a server reachable from the Claude apps (HTTPS + login) is the next step.

Give Claude your personal WhatsApp: search and read your chats, reply, quote a message, react, send files and voice notes, read voice notes as text, follow your groups.

## How it fits together

```
WhatsApp ⇄ WuzAPI ──signed webhooks──▶ wuzapi-mcp ── archive (SQLite, full-text search)
                  ◀──────REST────────       │
                                      status/QR page · MCP over HTTP
                                              │
                                         Claude Code
```

- **WuzAPI** keeps the WhatsApp session — it joins your account as a linked device, like WhatsApp Web — and exposes it as a REST API. It is used as is: wuzapi-mcp does not fork or patch it.
- **wuzapi-mcp** receives every message through WuzAPI's signed webhooks, keeps a searchable archive, shows a page with the link status and the QR, and exposes WhatsApp to Claude as MCP tools.

Both run in Docker. Their ports are bound to `127.0.0.1`: reachable from the machine itself, never from the network.

## Where it runs

There is no central service. You run it on a machine of yours — your laptop to try it, a small VPS to keep it on all the time. Your messages stay on that machine except when Claude reads them through a tool you allowed.

One installation holds one WhatsApp account.

## Getting started

You need Docker and `openssl`.

```bash
git clone https://github.com/alessio-ragni/wuzapi-mcp.git
cd wuzapi-mcp
scripts/init-env.sh        # writes .env with random secrets and your time zone
docker compose up -d       # starts WuzAPI and wuzapi-mcp
```

Open **http://127.0.0.1:8091** and scan the QR from WhatsApp → Settings → Linked devices → Link a device. The page then shows the account as linked and the archive filling up while the phone sends its history (up to `WUZAPI_SYNC_DAYS` days).

Connect Claude Code once — the page shows the same command:

```bash
claude mcp add --transport http --scope user whatsapp http://127.0.0.1:8091/mcp
```

On your own machine there is no password: the server only answers to that machine. Do not publish the ports.

## The archive

- Every message is stored once, whether it arrives live or with the history the phone sends at linking time.
- Search is full-text, ignores accents and matches word prefixes.
- **Linking a WhatsApp starts from an empty archive.** Unlinking — from the page, or by removing the device on the phone — deletes the archive and everything WuzAPI kept for that account.
- Restarting the machine or the containers keeps everything.
- Photos, videos, voice notes and documents are not copied in advance: `download_media` fetches one when Claude asks, into `~/Downloads/wuzapi-mcp`.

## Tools

| Read | Write | Media |
|---|---|---|
| `search_contacts`, `list_chats`, `get_chat`, `list_messages`, `search_messages`, `get_message_context`, `get_last_interaction`, `list_groups`, `get_group_info` | `send_message` (with quoted reply), `send_file`, `send_voice`, `react`, `create_poll` | `download_media`, `transcribe_voice` |

`send_file` and `send_voice` take the path of a file on your machine; your home folder is mounted read-only for that.

Voice transcription is off by default. Turn it on in `.env` with `TRANSCRIPTION_PROVIDER` = `openai`, `elevenlabs` or `whisper-local` (any OpenAI-compatible server) and its key or URL, then `docker compose up -d`.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Node 24 runs the TypeScript sources directly; there is no build step. Tests use invented data only.

## Read this before using it

- **This is not an official WhatsApp API.** WuzAPI speaks the WhatsApp Web protocol through [whatsmeow](https://github.com/tulir/whatsmeow). Automated use can get a number restricted. Use it on your own account, at a human pace.
- **Messages are untrusted input.** Anyone who writes to you can put instructions in a message. An assistant that reads everything and can send to anyone is exactly the shape prompt injection exploits. Keep tool-call confirmations on for the sending tools.

## Credits

The tool set is inspired by [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp), which showed how good WhatsApp feels inside Claude. The WhatsApp side is entirely [WuzAPI](https://github.com/asternic/wuzapi) and [whatsmeow](https://github.com/tulir/whatsmeow).

## License

MIT
