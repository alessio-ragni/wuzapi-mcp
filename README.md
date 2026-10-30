<div align="center">

# wuzapi-mcp

### Your WhatsApp, inside your AI assistant.

Search years of chats in a second, catch up on the groups you muted, see who answered your poll,
reply, send files and voice notes, and set up a group — just by asking.
**Private by design: everything runs on your own computer.**

[![Release](https://img.shields.io/github/v/release/alessio-ragni/wuzapi-mcp?include_prereleases&sort=semver)](https://github.com/alessio-ragni/wuzapi-mcp/releases)
[![CI](https://github.com/alessio-ragni/wuzapi-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alessio-ragni/wuzapi-mcp/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/alessio-ragni/wuzapi-mcp/pkgs/container/wuzapi-mcp)
[![MCP](https://img.shields.io/badge/MCP-any%20client-8A2BE2)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Works with **Claude Code · Claude Desktop · Gemini CLI · Codex · Cursor · VS Code** — any MCP client.

</div>

---

## Just ask

> **You:** What did Marco say about the flat in Bologna? It was sometime last spring.
>
> **Assistant:** On 14 April Marco wrote that the landlord would lower the rent to €850 if you sign
> for two years, and asked you to call him before Friday.

> **You:** Summarise the five-a-side group from this week, I muted it.
>
> **Assistant:** The match moves to Sunday at 10, Luca can't make it, and the pitch is already paid.
> Two people asked who brings the ball — nobody answered.

> **You:** Who said yes to my poll about the barbecue? Make a group with them and send the
> invitation.
>
> **Assistant:** Seven yes, two no, four haven't voted. I created *Barbecue 21 June* with the seven
> and posted the invitation. Want me to remind the four who haven't answered?

<sub>Invented examples. Your assistant asks before every message it sends.</sub>

## Why you'll like it

- 🔎 **Your whole history, searchable.** Every message is archived as it arrives, plus up to a year
  of history from your phone. Full-text search that ignores accents: `caffe` finds *caffè*.
- 🗳️ **Polls and groups, handled.** See who voted what and who hasn't yet, create a group with the
  people who said yes, make someone admin, share the invite link.
- ✍️ **It writes back.** Text replies that quote the original, photos, documents, voice notes,
  reactions, polls.
- 🎙️ **Voice notes become text** — through OpenAI, ElevenLabs or Whisper running locally, if you
  want it.
- 🔒 **Local-first.** No cloud service in the middle and no account to create. Your archive lives on
  your machine; your assistant only sees what it reads through a tool you allowed.
- 🧩 **Any MCP client.** One server for every assistant you use, today and tomorrow.
- 🐳 **Three commands to install.** A ready-made Docker image for Mac, Windows, Linux and servers:
  nothing to compile, no Go or Python toolchain.

## Get started in two minutes

You need [Docker](https://docs.docker.com/get-docker/).

**Mac and Linux**

```bash
git clone https://github.com/alessio-ragni/wuzapi-mcp.git && cd wuzapi-mcp
scripts/init-env.sh        # creates your private settings
docker compose up -d       # starts everything
```

**Windows** (PowerShell; [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
needs WSL 2, which its installer sets up)

```powershell
git clone https://github.com/alessio-ragni/wuzapi-mcp.git; cd wuzapi-mcp
powershell -ExecutionPolicy Bypass -File scripts\init-env.ps1   # creates your private settings
docker compose up -d                                           # starts everything
```

1. Open **http://127.0.0.1:8091**.
2. On your phone: WhatsApp → Settings → Linked devices → *Link a device*, and scan the QR.
3. Connect your assistant:

```bash
claude mcp add --transport http --scope user whatsapp http://127.0.0.1:8091/mcp
```

Ask *"what are my latest WhatsApp chats?"*. That's it.

<details>
<summary><b>Gemini CLI, Codex, Cursor, VS Code, Claude Desktop</b></summary>

The server speaks MCP over Streamable HTTP at `http://127.0.0.1:8091/mcp`:

| Client | Where | What to add |
|---|---|---|
| Gemini CLI | `~/.gemini/settings.json` | `"mcpServers": { "whatsapp": { "httpUrl": "http://127.0.0.1:8091/mcp" } }` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.whatsapp]` then `url = "http://127.0.0.1:8091/mcp"` |
| Cursor | `~/.cursor/mcp.json` | `"mcpServers": { "whatsapp": { "url": "http://127.0.0.1:8091/mcp" } }` |
| VS Code (Copilot) | `.vscode/mcp.json` | `"servers": { "whatsapp": { "type": "http", "url": "http://127.0.0.1:8091/mcp" } }` |
| Claude Desktop | `claude_desktop_config.json` | `"mcpServers": { "whatsapp": { "command": "npx", "args": ["mcp-remote", "http://127.0.0.1:8091/mcp"] } }` |

</details>

> **Preview (0.x).** Today it serves the assistants on the same computer. The cloud apps —
> ChatGPT, claude.ai, the Gemini app — need a public HTTPS address with a login: that hosted mode
> is the next milestone.

## How it works

```
WhatsApp ⇄ WuzAPI ──signed webhooks──▶ wuzapi-mcp ── your archive (SQLite, full-text search)
                  ◀──────REST────────       │
                                      status page · MCP over HTTP
                                              │
                                 your assistant (Claude, Gemini, Cursor…)
```

- **[WuzAPI](https://github.com/asternic/wuzapi)** keeps your WhatsApp session, as a linked device
  — like WhatsApp Web. Used as is, unmodified.
- **wuzapi-mcp** archives every message, shows the link status and the QR, and gives your assistant
  its tools.

Both run in Docker, on Mac, Windows or Linux, and answer only to your own computer (`127.0.0.1`),
which is why there is no password. Do not publish those ports on a network. One installation, one WhatsApp account.

## Tools

| Read | Write | Media |
|---|---|---|
| `search_contacts`, `list_chats`, `get_chat`, `list_messages`, `search_messages`, `get_message_context`, `get_last_interaction`, `list_groups`, `get_group_info`, `get_poll_results` | `send_message` (with quoted reply), `send_file`, `send_voice`, `react`, `create_poll`, `create_group`, `update_group_participants`, `get_group_invite_link` | `download_media`, `transcribe_voice` |

<details>
<summary>Details</summary>

- Times are shown in your time zone; dates can be given as `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.
- `send_file` and `send_voice` take the path of a file on your computer, written as you would write
  it (`/Users/me/…` or `C:\Users\me\…`). Only files in your home folder can be sent; it is mounted
  read-only for that. Any audio format works for voice notes; WuzAPI converts it.
- `download_media` saves into `Downloads/wuzapi-mcp` in your home folder and returns the path.
- `get_poll_results` lists who voted what and, in a group, who has not voted yet. Votes are kept
  from the moment they arrive; it can also ask the phone for older ones, but the phone only sends
  messages older than the chat's latest, so a poll that is still the last message cannot be fetched.
- `create_group` makes you the owner and can name admins. WhatsApp does not let you add people
  whose privacy settings allow only their own contacts to add them: the tool lists them, and
  `get_group_invite_link` gives the link to send them instead.
- `transcribe_voice` is off until you choose a provider — see
  [configuration](docs/configuration.md#voice-transcription).

Most clients ask before each tool call unless you allow it; keep that on for the sending and group
tools.

</details>

## The archive

- Every message is stored once, whether it arrives live or with the history the phone sends when it
  links. WhatsApp's status updates are left out.
- Search is full-text, ignores accents and matches word prefixes: `caffe` finds *caffè*.
- People in your address book are filed under their phone number even when WhatsApp names them by a
  privacy ID. People who are not in your address book appear by the name they chose.
- **Linking a WhatsApp starts from an empty archive.** Unlinking — the button on the page, or
  removing the device on your phone — deletes the archive and everything WuzAPI kept.
- Restarting the computer or the containers keeps everything.
- Photos, videos, voice notes and documents are not copied in advance; they are downloaded when
  your assistant asks for one.

## Update

```bash
git pull
docker compose pull
docker compose up -d
```

To stay on a version, set `WUZAPI_MCP_VERSION=0.1.0` in `.env`. Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## Uninstall

```bash
docker compose down -v     # stops everything and deletes the session and the archive
```

Then remove the device from your phone (WhatsApp → Settings → Linked devices) and delete the folder.

## FAQ

**Why Docker?** WuzAPI ships as a Docker image, and Docker lets the same two commands start
everything on a Mac, on Windows, on Linux and on a server, restart it after a reboot, and keep it
fenced off from the rest of your computer.

**Why do some chats show a name but no number?** WhatsApp is moving to privacy IDs (`…@lid`) that
hide phone numbers. wuzapi-mcp maps them back for everyone in your address book; for anyone else,
WhatsApp does not tell.

**Is this allowed?** It is not an official WhatsApp API — see the warning below.

**Something is wrong.** See [troubleshooting](docs/troubleshooting.md).

## Read this before using it

- **This is not an official WhatsApp API.** WuzAPI speaks the WhatsApp Web protocol through
  [whatsmeow](https://github.com/tulir/whatsmeow). Automated use can get a number restricted. Use
  it on your own account, at a human pace.
- **Messages are untrusted input.** Anyone who writes to you can put instructions in a message. An
  assistant that reads everything and can send to anyone is exactly what prompt injection targets.
  Keep confirmations on for the sending tools. More in [SECURITY.md](SECURITY.md).

## More

- [Configuration](docs/configuration.md) — every setting in `.env`
- [Architecture](docs/architecture.md) — how a message travels, what is stored where
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)

## Roadmap

- [x] Local archive with full-text search, sending, media, voice transcription
- [x] Polls and groups
- [ ] Hosted mode: a server with HTTPS and a login, for ChatGPT, claude.ai and phone apps

Ideas and bug reports are welcome in [Issues](https://github.com/alessio-ragni/wuzapi-mcp/issues).
If it saves you time, a ⭐ helps others find it.

## Credits

The tool set is inspired by [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp),
which showed how good WhatsApp feels inside an assistant. The WhatsApp side is entirely
[WuzAPI](https://github.com/asternic/wuzapi) and [whatsmeow](https://github.com/tulir/whatsmeow).

## License

MIT
