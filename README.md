# wuzapi-mcp

An MCP server for WhatsApp, built on top of [WuzAPI](https://github.com/asternic/wuzapi).

> **Status: early development.** Nothing here is usable yet. Watch the repo if you want to know when it is.

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
