# wuzapi-mcp

An MCP server for WhatsApp, built on top of [WuzAPI](https://github.com/asternic/wuzapi).

> **Status: early development.** Today it runs WuzAPI and links your WhatsApp; the MCP tools are not there yet. Watch the repo if you want to know when they are.

Give Claude (Claude Code, the Claude apps, Claude in the car) your personal WhatsApp: search and read your chats, reply, quote a message, react, read voice notes as text, follow your groups.

## How it fits together

```
WhatsApp ⇄ WuzAPI ──webhooks──▶ wuzapi-mcp ── local archive (SQLite, full-text search)
                    ◀──REST────       │
                              stdio · HTTP + OAuth
                           Claude Code · Claude apps
```

- **WuzAPI** keeps the WhatsApp session (it joins your account as a linked device, like WhatsApp Web) and exposes it as a REST API. It is used as is: wuzapi-mcp does not fork or patch it.
- **wuzapi-mcp** receives every message through WuzAPI's signed webhooks, keeps a searchable archive, and exposes WhatsApp to Claude as MCP tools — locally over stdio, or remotely over HTTP behind its own OAuth login.

## Where it runs

There is no central service. You run it on a machine of yours that stays on — your laptop to try it, a small VPS to keep it. Your messages never leave that machine except when Claude reads them through a tool you allowed.

## Getting started

You need Docker, `jq` and `openssl`.

```bash
git clone https://github.com/alessio-ragni/wuzapi-mcp.git
cd wuzapi-mcp
scripts/init-env.sh        # writes .env with random secrets
docker compose up -d       # starts WuzAPI, reachable from this machine only
scripts/pair.sh            # shows the QR in your browser and waits until your phone has scanned it
```

Scan the QR from WhatsApp → Settings → Linked devices → Link a device. Linking asks the phone for up to `WUZAPI_SYNC_DAYS` days of history, and WuzAPI keeps up to `WUZAPI_HISTORY_PER_CHAT` messages per chat.

WuzAPI's port is bound to `127.0.0.1`, so WuzAPI is only reachable from the machine itself. On a VPS, run `scripts/pair.sh` there and open the QR through an SSH tunnel (`ssh -L 8090:127.0.0.1:8090 <your-vps>`) until wuzapi-mcp serves its own password-protected pairing page.

To unlink, remove the device from the phone, or run `docker compose down -v` to drop the session and everything WuzAPI stored.

## Planned tools

| Read | Write | Media |
|---|---|---|
| `search_contacts`, `list_chats`, `get_chat`, `list_messages`, `search_messages`, `get_message_context`, `get_last_interaction`, `list_groups`, `get_group_info` | `send_message` (with quoted reply), `send_file`, `send_voice`, `react`, `create_poll` | `download_media`, `transcribe_voice` |

Voice transcription is pluggable: OpenAI, ElevenLabs, a local Whisper, or off. You bring your own keys.

## Read this before using it

- **This is not an official WhatsApp API.** WuzAPI speaks the WhatsApp Web protocol through [whatsmeow](https://github.com/tulir/whatsmeow). Automated use can get a number restricted. Use it on your own account, at a human pace.
- **Messages are untrusted input.** Anyone who writes to you can put instructions in a message. An assistant that reads everything and can send to anyone is exactly the shape prompt injection exploits. Keep that in mind when you connect it to an agent.

## Credits

The tool set is inspired by [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp), which showed how good WhatsApp feels inside Claude. The WhatsApp side is entirely [WuzAPI](https://github.com/asternic/wuzapi) and [whatsmeow](https://github.com/tulir/whatsmeow).

## License

MIT
